'use strict';
const logger = require('./lib/logger');

/**
 * frame-describe.js — Stage 6 of the pipeline (see src/pipeline.js).
 *
 * Writes a short "pen picture" for each frame Stage 5 captured: what is on
 * screen that the speaker is referring to, in 1–3 factual sentences. The
 * result is injected under the spoken line by Stage 7 (context-inject.js).
 *
 * Example:
 *   Spoken : Speaker 2: "This button looks off here."
 *   Look for: the button Speaker 2 calls 'off' — label, colour, position
 *   Output : "The 'Submit' CTA at the bottom of the KYC Details page is grey
 *             (disabled style) instead of the blue primary style, and sits
 *             below the fold under the PAN field."
 *
 * If the frame does not show what was asked, the model answers NOT_VISIBLE
 * and nothing is injected for that line — a wrong guess is worse than none.
 *
 * WHY INDEPENDENT CALLS: each call carries ONE image and its own question —
 * no shared history — so every image is billed exactly once. Frames are
 * processed sequentially to match every other stage's resume/credit pattern.
 *
 * RESUME: results are saved to descriptions.json after EVERY frame. A frame
 * with a saved description is never re-sent. A frame that errored is retried
 * on the next run, up to MAX_ATTEMPTS; after that Stage 7 proceeds without it.
 *
 * CREDIT SAFETY: an OpenAI quota/billing error stops the run with exit code 2;
 * everything described so far stays saved.
 *
 * Output: output/<group>/<session-id>/_work/<name>/descriptions.json
 *
 * Usage:
 *   node src/frame-describe.js
 */

require('dotenv').config();

const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const { config } = require('./lib/config');
const {
  ensureDir,
  framesDir,
  descriptionsPath,
  contextualTranscriptPath,
  listTranslatedRecordings,
} = require('./lib/session-paths');
const { toCreditErrorOrNull } = require('./lib/credit-errors');
const { exitOnCreditExhaustion } = require('./lib/credit-runner');

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = config.openaiModel();

/** Sentinel the model returns when the frame doesn't show what was asked. */
const NOT_VISIBLE = 'NOT_VISIBLE';
/** A failing frame is retried this many runs before Stage 7 gives up on it. */
const MAX_ATTEMPTS = 2;

/**
 * Builds the single-image prompt for one frame.
 *
 * @param {{whatToLookFor: string, spokenText: string, speaker: string|null}} frame
 * @returns {string}
 */
function buildPrompt(frame) {
  const who = frame.speaker || 'A speaker';
  const said = frame.spokenText ? `${who} said: "${frame.spokenText}"\n` : '';
  return `This is one still frame from a screen-shared meeting about a fintech application.

${said}What to identify on screen: ${frame.whatToLookFor}

Write a pen picture of ONLY the on-screen element(s) the speaker is referring to, in 1-3 factual sentences, so a reader who cannot see the screen understands what was meant. Name the screen/page if visible, the element, its exact label text, colour, state and position. Quote on-screen text exactly.

If the frame does not clearly show what is asked, reply with exactly ${NOT_VISIBLE} and nothing else. Never guess or invent details.`;
}

/**
 * Describes one frame via OpenAI — a fresh, independent request.
 *
 * @param {OpenAI} client
 * @param {string} imagePath
 * @param {object} frame - manifest frame entry
 * @returns {Promise<string>} description, or NOT_VISIBLE
 */
async function describeFrame(client, imagePath, frame) {
  const base64 = fs.readFileSync(imagePath).toString('base64');
  const response = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: buildPrompt(frame) },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
        ],
      },
    ],
  });
  return response.choices[0]?.message?.content?.trim() || NOT_VISIBLE;
}

/**
 * Reads the frame manifest for one recording, or null if not ready.
 * @returns {object|null}
 */
function readManifest(dir) {
  const p = path.join(dir, 'manifest.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Loads saved descriptions ({ [file]: {text, visible} | {error, attempts} }).
 * @returns {object}
 */
function readDescriptions(p) {
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')).frames || {};
  } catch {
    return {};
  }
}

/**
 * True when a saved entry needs no more work (described, or out of retries).
 * @param {object|undefined} entry
 * @returns {boolean}
 */
function isSettled(entry) {
  return !!entry && (entry.text != null || (entry.attempts || 0) >= MAX_ATTEMPTS);
}

/**
 * Describes every unsettled frame for one recording.
 *
 * @param {OpenAI} client
 * @param {{group: string, sessionId: string, baseName: string}} rec
 * @param {{done: number, total: number}} counters - run-wide, mutated in place
 */
async function processOneRecording(client, rec, counters) {
  const { group, sessionId, baseName } = rec;
  if (fs.existsSync(contextualTranscriptPath(group, sessionId, baseName))) return;

  const dir = framesDir(group, sessionId, baseName);
  const manifest = readManifest(dir);
  if (!manifest || !manifest.videoAvailable || !manifest.frames?.length) return;

  const outPath = descriptionsPath(group, sessionId, baseName);
  const saved = readDescriptions(outPath);
  const save = () => {
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, JSON.stringify({ model: OPENAI_MODEL, frames: saved }, null, 2), 'utf8');
  };

  for (const frame of manifest.frames) {
    const tag = `[${counters.done + 1}/${counters.total}]`;
    const item = `${group}/${sessionId}/${baseName}/${frame.file}`;
    counters.done++;

    if (isSettled(saved[frame.file])) {
      logger.info(`  ${tag} ⏭  Already described: ${item}`);
      continue;
    }

    const imagePath = path.join(dir, frame.file);
    if (!fs.existsSync(imagePath)) {
      logger.warn(`  ${tag} ⚠  Frame missing on disk, skipping: ${item}`);
      saved[frame.file] = { error: 'frame file missing', attempts: MAX_ATTEMPTS };
      save();
      continue;
    }

    logger.info(`  ${tag} 🖼  Describing: ${item}`);
    try {
      const text = await describeFrame(client, imagePath, frame);
      const visible = text !== NOT_VISIBLE;
      // A NOT_VISIBLE answer is settled too (text ''), so it is never re-sent.
      saved[frame.file] = { text: visible ? text : '', visible };
      save();
      logger.info(visible ? '      ✓  Saved.' : '      —  Not visible in frame; nothing will be injected.');
    } catch (err) {
      const creditErr = toCreditErrorOrNull(err);
      if (creditErr) {
        creditErr.currentItem = item;
        throw creditErr;
      }
      const prev = saved[frame.file]?.attempts || 0;
      saved[frame.file] = { error: err?.message || String(err), attempts: prev + 1 };
      save();
      logger.error(`      ✗  Error (attempt ${prev + 1}/${MAX_ATTEMPTS}): ${saved[frame.file].error}`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  logger.info('============================================================');
  logger.info(' Stage 6 — Frame Description (screen pen pictures)');
  logger.info('============================================================');

  const recordings = listTranslatedRecordings();

  // Count frames up front so "[3/12]" progress means something.
  let totalFrames = 0;
  for (const { group, sessionId, baseName } of recordings) {
    if (fs.existsSync(contextualTranscriptPath(group, sessionId, baseName))) continue;
    const m = readManifest(framesDir(group, sessionId, baseName));
    if (m?.videoAvailable && m.frames) totalFrames += m.frames.length;
  }
  if (totalFrames === 0) {
    logger.info('[info] No captured frames waiting. Nothing to do.\n');
    return;
  }

  if (!OPENAI_KEY) {
    logger.error('[error] OPENAI_API_KEY is not set in .env');
    logger.error('  Add your key from https://platform.openai.com/');
    process.exit(1);
  }

  logger.info(`[info] Model  : ${OPENAI_MODEL}`);
  logger.info(`[info] Frames : ${totalFrames} (already-described frames are skipped)\n`);

  const client = new OpenAI({ apiKey: OPENAI_KEY });
  const counters = { done: 0, total: totalFrames };

  for (const rec of recordings) {
    try {
      await processOneRecording(client, rec, counters);
    } catch (err) {
      exitOnCreditExhaustion(err, {
        serviceLabel: 'OpenAI',
        topUpUrl: 'https://platform.openai.com/account/billing',
        resumeCmd: 'npm run frame-describe',
        currentItem: err.currentItem || rec.baseName,
        doneCount: counters.done,
        totalCount: counters.total,
      });
      throw err;
    }
  }

  logger.info('\n============================================================');
  logger.info(' Done.');
  logger.info('============================================================\n');
}

module.exports = { main, processOneRecording, describeFrame, isSettled, readManifest, readDescriptions, MAX_ATTEMPTS };

if (require.main === module) {
  main().catch((err) => {
    logger.error('\n[fatal error]', err.message || err);
    process.exit(1);
  });
}

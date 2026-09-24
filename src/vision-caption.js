'use strict';
const logger = require('./lib/logger');

/**
 * vision-caption.js — Stage 4 of vision-assist (see HANDOVER.md for the full
 * 5-stage design). Consumes the frames Stage 3 (vision-capture.js) captured
 * and captions each one INDEPENDENTLY using OpenAI's vision-capable model.
 *
 * WHY INDEPENDENT (no shared history):
 *   Each API call gets ONLY that one image plus its own "what to look for"
 *   question — never a running conversation. This means:
 *     - each image is billed exactly once, ever (no re-sending accumulated
 *       image context on every turn — a real cost problem for multi-turn
 *       tool-calling loops with images)
 *     - captions COULD run concurrently, since there's no shared state
 *   This module processes frames SEQUENTIALLY, one at a time, by deliberate
 *   choice — not a technical requirement. Every other stage in this project
 *   uses the same one-item-at-a-time resume/credit-safety pattern, and
 *   matching that here keeps behavior predictable and keeps a single credit
 *   failure from leaving concurrent requests in an ambiguous half-done state.
 *   If throughput ever becomes a real problem, parallelizing this loop is a
 *   safe, isolated change — nothing else in the design depends on sequencing.
 *
 * DeepSeek (used elsewhere in this pipeline) has NO vision capability on any
 * tier — that's why this stage exists as a separate OpenAI-only step, and
 * why DeepSeek in vision-patch.js (Stage 5) only ever sees this stage's
 * TEXT captions, never the images themselves.
 *
 * RESUME LOGIC:
 *   A frame is skipped if its captions/<frame-basename>.json already exists.
 *
 * RESILIENCE:
 *   Layer 1 — Resume:      see above.
 *   Layer 2 — Per-frame:   one captioning failure logs and skips just that
 *                          frame, never aborts the session or the run.
 *   Layer 3 — Credit exit: OpenAI quota/billing errors stop the run cleanly
 *                          (no stack trace) — already-captioned frames stay done.
 *
 * Output: output/<group>/<session-id>/captions/<frame-basename>.json + .txt
 *
 * Usage:
 *   node src/vision-caption.js
 */

require('dotenv').config();

const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const { config } = require('./lib/config');
const {
  ensureDir,
  screenshotsDir,
  captionsDir,
  listAllSessions,
} = require('./lib/session-paths');
const { toCreditErrorOrNull } = require('./lib/credit-errors');
const { exitOnCreditExhaustion } = require('./lib/credit-runner');

const OPENAI_KEY   = process.env.OPENAI_API_KEY;
// Cheapest vision-capable tier, confirmed 2026-07-15 (see .env.example) —
// override via .env if this has changed since.
const OPENAI_MODEL = config.openaiModel();

/**
 * Builds the single-image, single-question prompt sent for one frame.
 * Deliberately terse — this is a targeted confirmation, not open-ended
 * image description.
 *
 * @param {string} whatToLookFor
 * @returns {string}
 */
function buildCaptionPrompt(whatToLookFor) {
  return `You are reviewing one still frame from a screen-recorded fintech application walkthrough.

What to confirm: ${whatToLookFor}

Describe ONLY what is visible in this frame that's relevant to the above, in 2-4 concise sentences. Be specific (exact colors, labels, positions) where visible. If what's being asked about is NOT visible or NOT determinable from this single frame, say so plainly instead of guessing — do not invent details that aren't actually in the image.`;
}

/**
 * Captions a single frame image via OpenAI. No conversation history — every
 * call is a fresh, independent request.
 *
 * @param {OpenAI} client
 * @param {string} imagePath - absolute path to the .jpg frame
 * @param {string} whatToLookFor
 * @returns {Promise<string>} caption text
 */
async function captionFrame(client, imagePath, whatToLookFor) {
  const base64 = fs.readFileSync(imagePath).toString('base64');

  const response = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: buildCaptionPrompt(whatToLookFor) },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
        ],
      },
    ],
  });

  return response.choices[0]?.message?.content?.trim() || '';
}

/**
 * @param {object} frame - {timestampSeconds, label, file, whatToLookFor, problemNumber}
 * @param {string} caption
 * @returns {string} formatted .txt content
 */
function formatCaptionTxt(frame, caption) {
  const lines = [];
  lines.push('========================================');
  lines.push(`FRAME   : ${frame.file}`);
  lines.push(`TIME    : ${frame.label}`);
  lines.push(`CHECKED : ${frame.whatToLookFor}`);
  lines.push('========================================');
  lines.push('');
  lines.push('CAPTION');
  lines.push('-------');
  lines.push(caption || '(empty response)');
  return lines.join('\n');
}

/**
 * Processes all uncaptioned frames for one session.
 *
 * @param {OpenAI} client
 * @param {string} group
 * @param {string} sessionId
 * @param {{done: number, total: number}} counters - shared run-wide counters, mutated in place
 * @returns {Promise<'skipped'|'done'>}
 */
async function processOneSession(client, group, sessionId, counters) {
  const manifestPath = path.join(screenshotsDir(group, sessionId), 'manifest.json');
  if (!fs.existsSync(manifestPath)) return 'skipped'; // Stage 3 hasn't run yet

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    logger.warn(`  ⚠  ${group}/${sessionId}: could not read screenshots manifest (${err.message}) — skipping.`);
    return 'skipped';
  }
  if (!manifest.videoAvailable || !manifest.frames || manifest.frames.length === 0) {
    return 'skipped'; // nothing to caption for this session
  }

  const capsDir = captionsDir(group, sessionId);
  ensureDir(capsDir);

  for (const frame of manifest.frames) {
    const frameBaseName = path.basename(frame.file, path.extname(frame.file));
    const jsonPath = path.join(capsDir, `${frameBaseName}.json`);
    const txtPath  = path.join(capsDir, `${frameBaseName}.txt`);

    // ── LAYER 1: Resume ────────────────────────────────────────────────────
    if (fs.existsSync(jsonPath)) {
      logger.info(`  [${counters.done + 1}/${counters.total}] ⏭  Already captioned: ${group}/${sessionId}/${frame.file}`);
      counters.done++;
      continue;
    }

    logger.info(`  [${counters.done + 1}/${counters.total}] 🖼  Captioning: ${group}/${sessionId}/${frame.file}`);

    const imagePath = path.join(screenshotsDir(group, sessionId), frame.file);
    if (!fs.existsSync(imagePath)) {
      logger.warn(`      ⚠  Frame file missing on disk, skipping: ${imagePath}`);
      counters.done++;
      continue;
    }

    try {
      const caption = await captionFrame(client, imagePath, frame.whatToLookFor);

      fs.writeFileSync(jsonPath, JSON.stringify({
        timestampSeconds: frame.timestampSeconds,
        whatToLookFor: frame.whatToLookFor,
        problemNumber: frame.problemNumber,
        caption,
        cachedAt: new Date().toISOString(),
      }, null, 2), 'utf8');
      fs.writeFileSync(txtPath, formatCaptionTxt(frame, caption), 'utf8');

      logger.info(`      ✓  Saved caption.`);
    } catch (err) {
      // ── LAYER 3: Credit / quota error ─────────────────────────────────────
      const creditErr = toCreditErrorOrNull(err);
      if (creditErr) {
        creditErr.currentItem = `${group}/${sessionId}/${frame.file}`;
        throw creditErr;
      }
      // ── LAYER 2: Any other error — log and move to the next frame ────────
      logger.error(`      ✗  Error captioning ${frame.file}: ${err?.message || err?.error?.message || String(err)}`);
    }

    counters.done++;
  }

  return 'done';
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  logger.info('============================================================');
  logger.info(' Vision-Assist Stage 4 — Independent Frame Captioning');
  logger.info('============================================================');

  if (!OPENAI_KEY) {
    logger.error('[error] OPENAI_API_KEY is not set in .env');
    logger.error('  Add your key from https://platform.openai.com/');
    process.exit(1);
  }

  const sessions = listAllSessions(); // {group, sessionId}

  if (sessions.length === 0) {
    logger.error('[error] No sessions found under output/<group>/<session-id>/. Run npm run vision-capture first.');
    process.exit(1);
  }

  // Count total frames up front so progress numbers ("[3/12]") mean something.
  let totalFrames = 0;
  for (const { group, sessionId } of sessions) {
    const manifestPath = path.join(screenshotsDir(group, sessionId), 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.videoAvailable && manifest.frames) totalFrames += manifest.frames.length;
    } catch {
      /* skip corrupt manifests when counting */
    }
  }

  if (totalFrames === 0) {
    logger.info('[info] No captured frames waiting to be captioned. Nothing to do.');
    return;
  }

  logger.info(`[info] Model         : ${OPENAI_MODEL}`);
  logger.info(`[info] Frames to caption (incl. already-done, which will be skipped): ${totalFrames}`);
  logger.info(`[info] Resume        : already-captioned frames will be skipped\n`);

  const client = new OpenAI({ apiKey: OPENAI_KEY });
  const counters = { done: 0, total: totalFrames };

  for (const { group, sessionId } of sessions) {
    try {
      await processOneSession(client, group, sessionId, counters);
    } catch (err) {
      exitOnCreditExhaustion(err, {
        serviceLabel: 'OpenAI',
        topUpUrl: 'https://platform.openai.com/account/billing',
        resumeCmd: 'npm run vision-caption',
        currentItem: err.currentItem || `${group}/${sessionId}`,
        doneCount: counters.done,
        totalCount: counters.total,
      });
      throw err;
    }
  }

  logger.info('\n============================================================');
  logger.info(' Done. Captions saved under:');
  logger.info('   output/<group>/<session-id>/captions/');
  logger.info('============================================================\n');
}

module.exports = { main, processOneSession, captionFrame };

if (require.main === module) {
  main().catch((err) => {
    logger.error('\n[fatal error]', err.message || err);
    process.exit(1);
  });
}

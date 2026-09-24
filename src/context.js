'use strict';
const logger = require('./lib/logger');

/**
 * context.js — Stage 3: English transcript → contextual transcript.
 *
 * Per recording, in one pass (each step cached in _work/<name>/ so a crash or
 * credit stop resumes where it left off):
 *   1. find the source video      input/<group>/<name>.* (own group first)
 *   2. scan  (OpenAI, text)       which lines need the screen?   → scan.json
 *   3. capture (ffmpeg)           one frame per requested moment → frames/
 *   4. describe (OpenAI, vision)  pen picture per frame          → descriptions.json
 *   5. write <name>-contextual.txt, descriptions under their lines (atomic)
 *   6. delete every intermediate: Sarvam JSON, _work/, and the recording's
 *      audio in audio/ — the session folder keeps only the final file.
 *
 * Example output:
 *   [12:04 → 12:11]  Speaker 2:
 *     This button looks off here.
 *     [SCREEN @ 12:07] The 'Submit' CTA on the KYC page is grey instead of blue.
 *
 * SOURCE VIDEO MISSING: the recording is HELD (nothing spent, nothing
 * deleted) unless run with { allowMissingVideo: true } — pipeline.js asks
 * you first. When allowed, the transcript is written without screen context
 * and its header says so.
 *
 * A frame that fails to capture/describe is retried next run, up to
 * MAX_ATTEMPTS, then skipped and counted in the header.
 *
 * Usage: node src/context.js [--allow-missing-video]
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { config, ensureDir } = require('./lib/config');
const {
  DEFAULT_GROUP,
  sessionDir,
  transcriptsDir,
  translateDir,
  workDir,
  contextualTranscriptPath,
  listTranslatedRecordings,
} = require('./lib/sessions');
const { findSourceVideo } = require('./lib/input-walk');
const { chunkDir } = require('./lib/chunking');
const { transcriptEntries, formatContextualTranscript } = require('./lib/transcript-format');
const { formatLabel } = require('./lib/format');
const { scanTranscript, describeFrame } = require('./lib/openai-context');
const { toCreditErrorOrNull, exitCreditExhausted } = require('./lib/credit');

ffmpeg.setFfmpegPath(ffmpegPath);

const MAX_ATTEMPTS = 2;

// ─── Small helpers ────────────────────────────────────────────────────────────

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(p, data) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

function extractFrame(videoPath, outPath, atSeconds) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath).seekInput(atSeconds).frames(1).output(outPath)
      .on('end', () => resolve()).on('error', reject).run();
  });
}

/** A description entry needs no more work: answered, or out of retries. */
const isSettled = (d) => !!d && ('visible' in d || (d.attempts || 0) >= MAX_ATTEMPTS);

/** Rethrows OpenAI billing errors as credit errors; returns other errors' text. */
function classify(err, item) {
  const creditErr = toCreditErrorOrNull(err);
  if (creditErr) {
    creditErr.currentItem = item;
    throw creditErr;
  }
  return err?.message || String(err);
}

// ─── Final write + cleanup ────────────────────────────────────────────────────

function removeIfEmpty(dir) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

/** Deletes every intermediate for one recording (Sarvam JSON, _work/, audio). */
function cleanupRecording({ group, sessionId, baseName }) {
  const tDir = translateDir(group, sessionId);
  if (fs.existsSync(tDir)) {
    for (const f of fs.readdirSync(tDir)) {
      const stem = f.replace(/\.[^.]+$/, '');
      if (stem === baseName || stem === `${baseName}_translate` || f.startsWith(`${baseName}__part`)) {
        fs.rmSync(path.join(tDir, f), { force: true });
      }
    }
    removeIfEmpty(tDir);
    removeIfEmpty(transcriptsDir(group, sessionId));
  }
  fs.rmSync(workDir(group, sessionId, baseName), { recursive: true, force: true });
  removeIfEmpty(path.join(sessionDir(group, sessionId), '_work'));

  const audioDir = config.audioDir();
  fs.rmSync(path.join(audioDir, `${baseName}.mp3`), { force: true });
  fs.rmSync(chunkDir(audioDir, baseName), { recursive: true, force: true });
}

/** Writes the final transcript atomically, then cleans up. */
function finalize(rec, result, annotations, screenStatus) {
  const finalPath = contextualTranscriptPath(rec.group, rec.sessionId, rec.baseName);
  fs.writeFileSync(`${finalPath}.tmp`, formatContextualTranscript(result, `${rec.baseName}.mp3`, { annotations, screenStatus }), 'utf8');
  fs.renameSync(`${finalPath}.tmp`, finalPath);
  cleanupRecording(rec);
  logger.info(`  [context] ✓ ${path.basename(finalPath)} — screen: ${screenStatus}`);
}

// ─── One recording ────────────────────────────────────────────────────────────

/**
 * @param {{group: string, sessionId: string, baseName: string, jsonPath: string}} rec
 * @param {{allowMissingVideo: boolean, getClient: () => OpenAI}} opts
 * @returns {Promise<'written'|'held'|'failed'|'skipped'>}
 */
async function processRecording(rec, opts) {
  const { group, sessionId, baseName, jsonPath } = rec;
  const label = `${group}/${sessionId}/${baseName}`;

  // Final already there (e.g. crash after write) → just finish the cleanup.
  if (fs.existsSync(contextualTranscriptPath(group, sessionId, baseName))) {
    cleanupRecording(rec);
    return 'skipped';
  }

  const result = readJson(jsonPath, null);
  if (!result) {
    logger.error(`  [context] ✗ Unreadable transcript JSON: ${label}`);
    return 'failed';
  }
  const entries = transcriptEntries(result);

  // 1. Source video
  const video = findSourceVideo(config.inputDir(), baseName, group, DEFAULT_GROUP);
  if (!video) {
    if (!opts.allowMissingVideo) {
      logger.warn(`  [context] ⏸ Held (source video not in input/): ${label}`);
      return 'held';
    }
    finalize(rec, result, new Map(), 'unavailable — source video not found in input/');
    return 'written';
  }

  // 2. Scan (cached)
  const work = workDir(group, sessionId, baseName);
  const scanFile = path.join(work, 'scan.json');
  let scan = readJson(scanFile, null);
  if (!scan) {
    const timed = entries.map((entry, index) => ({ index, entry })).filter(({ entry }) => entry.start != null && entry.end != null);
    try {
      scan = { requests: timed.length ? await scanTranscript(opts.getClient(), timed) : [] };
    } catch (err) {
      logger.error(`  [context] ✗ Scan failed for ${label}: ${classify(err, label)}`);
      return 'failed';
    }
    writeJson(scanFile, scan);
    logger.info(`  [context] ${label}: ${scan.requests.length} line(s) need the screen.`);
  }
  if (scan.requests.length === 0) {
    finalize(rec, result, new Map(), 'none needed');
    return 'written';
  }

  // 3 + 4. Capture and describe each requested frame (cached per frame)
  const framesDir = path.join(work, 'frames');
  const descFile = path.join(work, 'descriptions.json');
  const desc = readJson(descFile, {});
  ensureDir(framesDir);

  for (const req of scan.requests) {
    const file = `frame_L${req.line}_${formatLabel(req.timestampSeconds)}.jpg`;
    if (isSettled(desc[file])) continue;
    const framePath = path.join(framesDir, file);
    const fail = (msg) => {
      desc[file] = { error: msg, attempts: (desc[file]?.attempts || 0) + 1 };
      logger.warn(`  [context] ⚠ ${file}: ${msg}`);
    };

    if (!fs.existsSync(framePath)) {
      try {
        await extractFrame(video, framePath, req.timestampSeconds);
      } catch {
        /* reported below as "no frame" */
      }
    }
    if (!fs.existsSync(framePath)) {
      fail('no frame produced (past end of video?)');
    } else {
      try {
        const text = await describeFrame(opts.getClient(), framePath, {
          whatToLookFor: req.whatToLookFor,
          spokenText: entries[req.line]?.text,
          speaker: entries[req.line]?.speaker,
        });
        desc[file] = { visible: text != null, text: text || '' };
      } catch (err) {
        writeJson(descFile, desc); // keep progress before a possible credit exit
        fail(classify(err, `${label}/${file}`));
      }
    }
    writeJson(descFile, desc);
  }

  // 5 + 6. Finalize once every frame is settled; otherwise retry next run.
  const files = scan.requests.map((r) => `frame_L${r.line}_${formatLabel(r.timestampSeconds)}.jpg`);
  if (!files.every((f) => isSettled(desc[f]))) return 'failed';

  const annotations = new Map();
  let notVisible = 0;
  let failed = 0;
  scan.requests.forEach((req, i) => {
    const d = desc[files[i]];
    if (!('visible' in d)) {
      failed++;
    } else if (!d.visible) {
      notVisible++;
    } else {
      if (!annotations.has(req.line)) annotations.set(req.line, []);
      annotations.get(req.line).push({ timestampSeconds: req.timestampSeconds, text: d.text });
    }
  });
  const extras = [notVisible && `${notVisible} not visible`, failed && `${failed} failed`].filter(Boolean);
  const added = scan.requests.length - notVisible - failed;
  finalize(rec, result, annotations,
    `${added} note(s) added (${scan.requests.length} frame(s) requested${extras.length ? `, ${extras.join(', ')}` : ''})`);
  return 'written';
}

// ─── Stage entry point ────────────────────────────────────────────────────────

/**
 * @param {{allowMissingVideo?: boolean}} [opts]
 * @returns {Promise<{written: number, held: number, failed: number, skipped: number}>}
 */
async function run(opts = {}) {
  const tally = { written: 0, held: 0, failed: 0, skipped: 0 };
  let client = null;
  const getClient = () => {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set in .env');
    return (client ||= new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));
  };

  for (const rec of listTranslatedRecordings()) {
    try {
      tally[await processRecording(rec, { allowMissingVideo: !!opts.allowMissingVideo, getClient })]++;
    } catch (err) {
      if (!err.isCreditError) throw err;
      exitCreditExhausted({
        serviceLabel: 'OpenAI',
        topUpUrl: 'https://platform.openai.com/account/billing',
        currentItem: err.currentItem || rec.baseName,
      });
    }
  }

  logger.info(`[context] ${tally.written} written` +
    (tally.held ? `, ${tally.held} held (source video missing)` : '') +
    (tally.failed ? `, ${tally.failed} incomplete (retried next run)` : '') + '.');
  return tally;
}

module.exports = { run, processRecording, cleanupRecording, isSettled };

if (require.main === module) {
  run({ allowMissingVideo: process.argv.includes('--allow-missing-video') }).catch((err) => {
    logger.error('\n[fatal error]', err.message || err);
    process.exit(1);
  });
}

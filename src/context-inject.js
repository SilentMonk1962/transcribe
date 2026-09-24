'use strict';
const logger = require('./lib/logger');

/**
 * context-inject.js — Stage 7 (final) of the pipeline (see src/pipeline.js).
 * No model call — pure local assembly.
 *
 * For each recording:
 *   1. Waits until Stages 4–6 are settled (scan done, frames captured or
 *      known-unavailable, every frame described or out of retries).
 *   2. Renders the English transcript with each screen description placed
 *      directly under the line it explains:
 *
 *        [12:04 → 12:11]  Speaker 2:
 *          This button looks off here.
 *          [SCREEN @ 12:07] The 'Submit' CTA on the KYC page is grey...
 *
 *   3. Writes output/<group>/<session-id>/<name>-contextual.txt (atomically:
 *      temp file + rename, so a crash never leaves a half-written final).
 *   4. ONLY THEN deletes every intermediate for that recording: the Sarvam
 *      JSON (+ chunk parts) and _work/<name>/ (scan, frames, descriptions).
 *      Empty transcripts/ and _work/ folders are removed too, so a finished
 *      session folder holds nothing but its contextual transcript(s).
 *
 * The header's SCREEN line always says what happened, e.g.
 *   "4 note(s) added (5 frame(s) checked, 1 not visible)"
 *   "none needed"
 *   "unavailable — source video not found in input/ (3 line(s) needed context)"
 *
 * RESUME: a recording whose contextual transcript exists is skipped.
 *
 * Usage:
 *   node src/context-inject.js
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {
  sessionDir,
  transcriptsDir,
  workDir,
  scanPath,
  framesDir,
  descriptionsPath,
  contextualTranscriptPath,
  listTranslatedRecordings,
} = require('./lib/session-paths');
const { formatContextualTranscript } = require('./lib/transcript-format');
const { isSettled, readManifest, readDescriptions } = require('./frame-describe');

/**
 * Builds the annotations map + header status for one recording, or returns
 * null when an earlier stage hasn't settled yet.
 *
 * @param {{group: string, sessionId: string, baseName: string}} rec
 * @returns {{annotations: Map<number, Array>, screenStatus: string}|null}
 */
function collectContext(rec) {
  const { group, sessionId, baseName } = rec;
  if (!fs.existsSync(scanPath(group, sessionId, baseName))) return null;

  const manifest = readManifest(framesDir(group, sessionId, baseName));
  if (!manifest) return null;

  if (manifest.videoAvailable === null) {
    return { annotations: new Map(), screenStatus: 'none needed' };
  }
  if (manifest.videoAvailable === false) {
    return {
      annotations: new Map(),
      screenStatus: `unavailable — source video not found in input/ (${manifest.requested} line(s) needed context)`,
    };
  }

  const saved = readDescriptions(descriptionsPath(group, sessionId, baseName));
  if (!manifest.frames.every((f) => isSettled(saved[f.file]))) return null;

  const annotations = new Map();
  let notVisible = 0;
  let failed = 0;
  for (const frame of manifest.frames) {
    const d = saved[frame.file];
    if (d.text == null) { failed++; continue; }
    if (!d.visible || !d.text) { notVisible++; continue; }
    if (!annotations.has(frame.line)) annotations.set(frame.line, []);
    annotations.get(frame.line).push({ timestampSeconds: frame.timestampSeconds, text: d.text });
  }

  const added = manifest.frames.length - notVisible - failed;
  const missed = manifest.requested - manifest.frames.length; // ffmpeg produced no frame
  const extras = [
    notVisible && `${notVisible} not visible`,
    failed && `${failed} could not be described`,
    missed && `${missed} could not be captured`,
  ].filter(Boolean);
  const screenStatus = `${added} note(s) added (${manifest.requested} frame(s) requested` +
    (extras.length ? `, ${extras.join(', ')}` : '') + ')';

  return { annotations, screenStatus };
}

/**
 * Removes `dir` if it exists and is empty.
 * @param {string} dir
 */
function removeIfEmpty(dir) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

/**
 * Deletes every intermediate for one recording (see step 4 in the header).
 * @param {{group: string, sessionId: string, baseName: string}} rec
 */
function cleanupRecording(rec) {
  const { group, sessionId, baseName } = rec;
  const translateDir = path.join(transcriptsDir(group, sessionId), 'translate');

  if (fs.existsSync(translateDir)) {
    // <name>.json, legacy <name>_translate.txt, and chunk parts <name>__partNN.*
    const partPrefix = `${baseName}__part`;
    for (const f of fs.readdirSync(translateDir)) {
      const stem = f.replace(/\.[^.]+$/, '');
      if (stem === baseName || stem === `${baseName}_translate` || f.startsWith(partPrefix)) {
        fs.rmSync(path.join(translateDir, f), { force: true });
      }
    }
    removeIfEmpty(translateDir);
    removeIfEmpty(transcriptsDir(group, sessionId));
  }

  fs.rmSync(workDir(group, sessionId, baseName), { recursive: true, force: true });
  removeIfEmpty(path.join(sessionDir(group, sessionId), '_work'));
}

/**
 * @param {{group: string, sessionId: string, baseName: string, jsonPath: string}} rec
 * @param {string} progress
 * @returns {'skipped'|'waiting'|'written'|'failed'}
 */
function processOneRecording(rec, progress) {
  const { group, sessionId, baseName, jsonPath } = rec;
  const label = `${group}/${sessionId}/${baseName}`;
  const finalPath = contextualTranscriptPath(group, sessionId, baseName);

  if (fs.existsSync(finalPath)) {
    // Final exists but intermediates survived (e.g. crash after rename) — finish cleanup.
    cleanupRecording(rec);
    return 'skipped';
  }

  const context = collectContext(rec);
  if (!context) {
    logger.info(`  ${progress} …  Waiting on earlier stages: ${label}`);
    return 'waiting';
  }

  let result;
  try {
    result = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    logger.error(`  ${progress} ✗  Could not read transcript JSON for ${label}: ${err.message}`);
    return 'failed';
  }

  const text = formatContextualTranscript(result, `${baseName}.mp3`, context);
  const tmpPath = `${finalPath}.tmp`;
  fs.writeFileSync(tmpPath, text, 'utf8');
  fs.renameSync(tmpPath, finalPath);

  cleanupRecording(rec);
  logger.info(`  ${progress} ✓  ${path.basename(finalPath)} — screen context: ${context.screenStatus}`);
  return 'written';
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  logger.info('============================================================');
  logger.info(' Stage 7 — Inject Screen Context → contextual transcript');
  logger.info('============================================================');

  const recordings = listTranslatedRecordings();
  const tally = { skipped: 0, waiting: 0, written: 0, failed: 0 };

  for (let i = 0; i < recordings.length; i++) {
    tally[processOneRecording(recordings[i], `[${i + 1}/${recordings.length}]`)]++;
  }

  logger.info('\n============================================================');
  logger.info(` Done. ${tally.written} written` +
    (tally.waiting ? `, ${tally.waiting} waiting on earlier stages (re-run to finish)` : '') +
    (tally.failed ? `, ${tally.failed} failed` : '') + '.');
  logger.info(' Final files: output/<group>/<session-id>/<name>-contextual.txt');
  logger.info('============================================================\n');
}

module.exports = { main, processOneRecording, collectContext, cleanupRecording };

if (require.main === module) {
  main().catch((err) => {
    logger.error('\n[fatal error]', err.message || err);
    process.exit(1);
  });
}

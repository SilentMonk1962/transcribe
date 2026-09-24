'use strict';
const logger = require('./lib/logger');

/**
 * vision-capture.js — Stage 3 of vision-assist (see HANDOVER.md for the full
 * 5-stage design, and src/meeting-notes.js for Stage 2, which produces the
 * flags.json this stage consumes).
 *
 * For every session that Stage 2 flagged points needing visual confirmation,
 * this grabs EXACTLY those timestamps as still frames from the ORIGINAL
 * SOURCE VIDEO — not the audio, the actual video file in input/. This only
 * works if the source video is still there; in normal usage it's often
 * already been cleaned up after conversion. That's expected and handled
 * gracefully: this stage never fails the run over a missing video, it just
 * records that visual confirmation wasn't possible for that session and
 * moves on. Stage 5 (vision-patch.js) reads that outcome and says so plainly
 * in the final notes rather than silently omitting anything.
 *
 * RESUME LOGIC:
 *   A session is skipped if output/<group>/<session-id>/screenshots/manifest.json
 *   already exists — that file is written in ALL outcomes (frames captured,
 *   zero flags, or video missing), so re-runs never redo work needlessly.
 *
 * RESILIENCE:
 *   Layer 1 — Resume:   see above.
 *   Layer 2 — Per-flag: one ffmpeg failure logs and skips just that frame,
 *                       never aborts the session or the run.
 *   Layer 3 — Missing video: skip visual capture for that session only,
 *                       record why in manifest.json, keep going.
 *
 * Output: output/<group>/<session-id>/screenshots/frame_HH-MM-SS.jpg
 *         output/<group>/<session-id>/screenshots/manifest.json
 *
 * Usage:
 *   node src/vision-capture.js
 */

require('dotenv').config();

const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs');
const path = require('path');
const {
  ensureDir,
  notesDir,
  screenshotsDir,
  listAllSessions,
} = require('./lib/session-paths');
const { formatLabel } = require('./lib/format');
const { findInputVideoByName } = require('./lib/input-walk');

ffmpeg.setFfmpegPath(ffmpegPath);

const INPUT_DIR = path.resolve(process.env.INPUT_DIR || './input');

/**
 * Extracts exactly one frame at `atSeconds` into outPath.
 * @param {string} videoPath
 * @param {string} outPath
 * @param {number} atSeconds
 * @returns {Promise<void>}
 */
function extractFrame(videoPath, outPath, atSeconds) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .seekInput(atSeconds)
      .frames(1)
      .output(outPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run();
  });
}

/**
 * Finds this session's original source video in input/ — RECURSIVELY (fixed
 * 2026-08-06): convert.js treats any sub-folder under input/ as a group, and
 * the old flat root-only lookup could never find a grouped video. Now matches
 * the recording's base filename against every known video extension at any
 * depth, mirroring convert.js's own recursive discovery (shared walker in
 * src/lib/input-walk.js).
 * @param {string} recordingBaseName
 * @returns {string|null} absolute path, or null if not found
 */
function findSourceVideo(recordingBaseName) {
  return findInputVideoByName(INPUT_DIR, recordingBaseName);
}

/**
 * Processes one session: reads its flags.json, captures frames if possible,
 * always writes manifest.json recording the outcome.
 *
 * @param {string} group
 * @param {string} sessionId
 * @param {string} progress - "[1/4]"
 * @returns {Promise<'skipped'|'no-flags'|'video-missing'|'captured'>}
 */
async function processOneSession(group, sessionId, progress) {
  const flagsPath = path.join(notesDir(group, sessionId), 'flags.json');
  if (!fs.existsSync(flagsPath)) {
    // Stage 2 hasn't produced a draft for this session yet — nothing to do.
    return 'skipped';
  }

  const shotsDir = screenshotsDir(group, sessionId);
  const manifestPath = path.join(shotsDir, 'manifest.json');

  // ── LAYER 1: Resume ────────────────────────────────────────────────────
  if (fs.existsSync(manifestPath)) {
    logger.info(`  ${progress} ⏭  Already done, skipping: ${group}/${sessionId}`);
    return 'skipped';
  }

  let recordingBaseName = null;
  let flags = [];
  try {
    const parsedFlags = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));
    recordingBaseName = parsedFlags.recordingBaseName;
    flags = parsedFlags.flags;
  } catch (err) {
    logger.warn(`  ${progress} ⚠  Could not parse flags.json for ${group}/${sessionId} (${err.message}) — skipping.`);
    return 'skipped';
  }
  ensureDir(shotsDir);
  if (!flags || flags.length === 0) {
    fs.writeFileSync(manifestPath, JSON.stringify({
      videoAvailable: null,
      reason: 'No vision-assist flags for this session.',
      frames: [],
    }, null, 2), 'utf8');
    logger.info(`  ${progress} —  No vision checks flagged: ${group}/${sessionId}`);
    return 'no-flags';
  }

  const sourceVideo = findSourceVideo(recordingBaseName);

  if (!sourceVideo) {
    fs.writeFileSync(manifestPath, JSON.stringify({
      videoAvailable: false,
      reason: `Source video for "${recordingBaseName}" is no longer in input/.`,
      frames: [],
    }, null, 2), 'utf8');
    logger.warn(`  ${progress} ⚠  Source video missing for ${group}/${sessionId} ` +
      `(${flags.length} vision check(s) requested, none possible) — noted in manifest, continuing.`);
    return 'video-missing';
  }

  logger.info(`  ${progress} 📸 Capturing ${flags.length} flagged frame(s): ${group}/${sessionId}`);

  const frames = [];
  for (const flag of flags) {
    const label = formatLabel(flag.timestampSeconds);
    const fileName = `frame_${label}.jpg`;
    const outPath = path.join(shotsDir, fileName);

    try {
      await extractFrame(sourceVideo, outPath, flag.timestampSeconds);
    } catch (err) {
      // ── LAYER 2: Per-flag — log and move to the next flag ────────────────
      logger.error(`  ${progress} ✗  ffmpeg error at ${label.replace(/-/g, ':')}: ${err.message}`);
      continue;
    }

    if (!fs.existsSync(outPath)) {
      // Timestamp past end-of-video or otherwise unproducable — skip it.
      logger.warn(`  ${progress} ⚠  No frame produced at ${label.replace(/-/g, ':')} (past end of video?)`);
      continue;
    }

    frames.push({
      timestampSeconds: flag.timestampSeconds,
      label: label.replace(/-/g, ':'),
      file: fileName,
      whatToLookFor: flag.whatToLookFor,
      problemNumber: flag.problemNumber,
    });
  }

  fs.writeFileSync(manifestPath, JSON.stringify({
    videoAvailable: true,
    frames,
  }, null, 2), 'utf8');

  logger.info(`  ${progress} ✓  ${frames.length}/${flags.length} frame(s) captured: ${group}/${sessionId}`);
  return 'captured';
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  logger.info('============================================================');
  logger.info(' Vision-Assist Stage 3 — Targeted Frame Capture');
  logger.info('============================================================');
  logger.info(`Input dir (source videos) : ${INPUT_DIR}`);
  logger.info('');

  const sessions = listAllSessions(); // {group, sessionId}

  if (sessions.length === 0) {
    logger.error('[error] No sessions found under output/<group>/<session-id>/. Run npm run meeting-notes first.');
    process.exit(1);
  }

  logger.info(`[info] ${sessions.length} session(s) to check.\n`);

  const total = sessions.length;
  const tally = { skipped: 0, 'no-flags': 0, 'video-missing': 0, captured: 0 };

  for (let i = 0; i < sessions.length; i++) {
    const progress = `[${i + 1}/${total}]`;
    const { group, sessionId } = sessions[i];
    const outcome = await processOneSession(group, sessionId, progress);
    tally[outcome] = (tally[outcome] || 0) + 1;
  }

  logger.info('\n============================================================');
  logger.info(' Done.');
  logger.info(`   Captured        : ${tally.captured}`);
  logger.info(`   No flags needed : ${tally['no-flags']}`);
  logger.info(`   Video missing   : ${tally['video-missing']}`);
  logger.info(`   Skipped/resumed : ${tally.skipped}`);
  logger.info('============================================================\n');
}

module.exports = { main, processOneSession, formatLabel, findSourceVideo };

if (require.main === module) {
  main().catch((err) => {
    logger.error('\n[fatal error]', err.message || err);
    process.exit(1);
  });
}

'use strict';
const logger = require('./lib/logger');

/**
 * frame-capture.js — Stage 5 of the pipeline (see src/pipeline.js).
 *
 * For every recording that Stage 4 (context-scan.js) marked as needing screen
 * context, grabs EXACTLY those timestamps as still frames from the ORIGINAL
 * SOURCE VIDEO in input/ (not the audio). If the video is no longer there,
 * this stage never fails the run — it records why in manifest.json and Stage 7
 * (context-inject.js) states "screen context unavailable" in the transcript
 * header instead of silently dropping it.
 *
 * Each frame also carries the spoken line it explains, so Stage 6 can describe
 * the frame in the context of what was actually said.
 *
 * RESUME: a recording is skipped if _work/<name>/frames/manifest.json exists —
 * written in ALL outcomes (frames captured, nothing requested, video missing).
 *
 * RESILIENCE:
 *   - one ffmpeg failure skips only that frame, never the recording or run
 *   - a missing source video skips only that recording
 *
 * Output: output/<group>/<session-id>/_work/<name>/frames/frame_L<line>_HH-MM-SS.jpg
 *         output/<group>/<session-id>/_work/<name>/frames/manifest.json
 *
 * Usage:
 *   node src/frame-capture.js
 */

require('dotenv').config();

const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs');
const path = require('path');
const { config } = require('./lib/config');
const {
  ensureDir,
  scanPath,
  framesDir,
  contextualTranscriptPath,
  listTranslatedRecordings,
} = require('./lib/session-paths');
const { transcriptEntries } = require('./lib/transcript-format');
const { formatLabel } = require('./lib/format');
const { findInputVideoByName } = require('./lib/input-walk');

ffmpeg.setFfmpegPath(ffmpegPath);

const INPUT_DIR = config.inputDir();

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
 * Writes the manifest for one recording (every outcome writes one).
 * @param {string} dir
 * @param {object} manifest
 */
function writeManifest(dir, manifest) {
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

/**
 * Captures the requested frames for one recording.
 *
 * @param {{group: string, sessionId: string, baseName: string, jsonPath: string}} rec
 * @param {string} progress - "[1/4]"
 * @returns {Promise<'waiting'|'skipped'|'no-requests'|'video-missing'|'captured'>}
 */
async function processOneRecording(rec, progress) {
  const { group, sessionId, baseName, jsonPath } = rec;
  const label = `${group}/${sessionId}/${baseName}`;
  const dir = framesDir(group, sessionId, baseName);

  if (fs.existsSync(contextualTranscriptPath(group, sessionId, baseName))) return 'skipped';
  if (fs.existsSync(path.join(dir, 'manifest.json'))) {
    logger.info(`  ${progress} ⏭  Already captured: ${label}`);
    return 'skipped';
  }

  // Stage 4 must finish first.
  const scanFile = scanPath(group, sessionId, baseName);
  if (!fs.existsSync(scanFile)) return 'waiting';

  let requests;
  try {
    requests = JSON.parse(fs.readFileSync(scanFile, 'utf8')).requests || [];
  } catch (err) {
    logger.warn(`  ${progress} ⚠  Could not parse scan.json for ${label} (${err.message}) — skipping.`);
    return 'waiting';
  }

  if (requests.length === 0) {
    writeManifest(dir, { videoAvailable: null, reason: 'No lines needed screen context.', requested: 0, frames: [] });
    logger.info(`  ${progress} —  No screen context needed: ${label}`);
    return 'no-requests';
  }

  const sourceVideo = findInputVideoByName(INPUT_DIR, baseName);
  if (!sourceVideo) {
    writeManifest(dir, {
      videoAvailable: false,
      reason: `Source video "${baseName}" not found in input/.`,
      requested: requests.length,
      frames: [],
    });
    logger.warn(`  ${progress} ⚠  Source video missing for ${label} ` +
      `(${requests.length} frame(s) requested) — noted, continuing.`);
    return 'video-missing';
  }

  // Spoken text per line — gives Stage 6 the words the frame must explain.
  let entries = [];
  try {
    entries = transcriptEntries(JSON.parse(fs.readFileSync(jsonPath, 'utf8')));
  } catch {
    /* description still works from whatToLookFor alone */
  }

  ensureDir(dir);
  logger.info(`  ${progress} 📸 Capturing ${requests.length} frame(s): ${label}`);

  const frames = [];
  for (const req of requests) {
    const time = formatLabel(req.timestampSeconds);
    const fileName = `frame_L${req.line}_${time}.jpg`;
    const outPath = path.join(dir, fileName);

    try {
      await extractFrame(sourceVideo, outPath, req.timestampSeconds);
    } catch (err) {
      logger.error(`  ${progress} ✗  ffmpeg error at ${time.replace(/-/g, ':')}: ${err.message}`);
      continue;
    }
    if (!fs.existsSync(outPath)) {
      logger.warn(`  ${progress} ⚠  No frame produced at ${time.replace(/-/g, ':')} (past end of video?)`);
      continue;
    }

    frames.push({
      line: req.line,
      timestampSeconds: req.timestampSeconds,
      file: fileName,
      whatToLookFor: req.whatToLookFor,
      spokenText: entries[req.line]?.text || '',
      speaker: entries[req.line]?.speaker || null,
    });
  }

  writeManifest(dir, { videoAvailable: true, requested: requests.length, frames });
  logger.info(`  ${progress} ✓  ${frames.length}/${requests.length} frame(s) captured: ${label}`);
  return 'captured';
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  logger.info('============================================================');
  logger.info(' Stage 5 — Frame Capture');
  logger.info('============================================================');
  logger.info(`Input dir (source videos) : ${INPUT_DIR}\n`);

  const recordings = listTranslatedRecordings();
  const tally = { waiting: 0, skipped: 0, 'no-requests': 0, 'video-missing': 0, captured: 0 };

  for (let i = 0; i < recordings.length; i++) {
    const outcome = await processOneRecording(recordings[i], `[${i + 1}/${recordings.length}]`);
    tally[outcome]++;
  }

  logger.info('\n============================================================');
  logger.info(' Done.');
  logger.info(`   Captured          : ${tally.captured}`);
  logger.info(`   No context needed : ${tally['no-requests']}`);
  logger.info(`   Video missing     : ${tally['video-missing']}`);
  logger.info(`   Skipped/resumed   : ${tally.skipped}`);
  if (tally.waiting > 0) logger.info(`   Waiting on scan   : ${tally.waiting}`);
  logger.info('============================================================\n');
}

module.exports = { main, processOneRecording };

if (require.main === module) {
  main().catch((err) => {
    logger.error('\n[fatal error]', err.message || err);
    process.exit(1);
  });
}

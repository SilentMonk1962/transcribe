'use strict';
const logger = require('./lib/logger');

/**
 * convert.js — Stage 1: video → audio.
 *
 * For every video in input/:
 *   1. Resolves its group (from the folder) + session (may ask the same-day
 *      question once; see lib/sessions.js).
 *   2. Skips it if its final contextual transcript already exists — no
 *      ffmpeg work is ever redone for a finished recording.
 *   3. Otherwise writes audio/<name>.mp3 (16 kHz mono MP3 — what Sarvam
 *      wants). Recordings longer than SARVAM_CHUNK_MINUTES (default 60) are
 *      split into audio/_chunks/<name>/ parts instead (lib/chunking.js).
 *
 * Usage: node src/convert.js
 */

require('dotenv').config();

const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const path = require('path');
const fs = require('fs');
const { config, ensureDir } = require('./lib/config');
const { resolveSession, contextualTranscriptPath, DEFAULT_GROUP } = require('./lib/sessions');
const { walkInputVideos, VIDEO_EXTENSIONS } = require('./lib/input-walk');
const {
  chunkThresholdSeconds,
  getAudioDurationSeconds,
  hasManifest,
  splitAudioIntoChunks,
} = require('./lib/chunking');

ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * Converts one video to speech-optimised MP3.
 * @param {string} inputPath
 * @param {string} outputPath
 * @returns {Promise<void>}
 */
function convertVideoToAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioChannels(1)         // mono is enough for speech
      .audioFrequency(16000)    // Sarvam's preferred sample rate
      .audioCodec('libmp3lame')
      .audioBitrate('64k')
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', reject)
      .run();
  });
}

/**
 * Stage entry point.
 * @returns {Promise<{converted: number, skipped: number, failed: number}>}
 */
async function run() {
  const inputDir = config.inputDir();
  const audioDir = config.audioDir();
  ensureDir(audioDir);

  const videos = walkInputVideos(inputDir);
  const tally = { converted: 0, skipped: 0, failed: 0 };
  if (videos.length === 0) {
    logger.info(`[convert] No videos in ${inputDir} (supported: ${VIDEO_EXTENSIONS.join(', ')}).`);
    return tally;
  }

  for (const { fullPath, relDir, baseName } of videos) {
    const session = await resolveSession(baseName, { explicitGroup: relDir || DEFAULT_GROUP });
    const label = `${session.group}/${session.effectiveSessionId}/${baseName}`;
    const outputPath = path.join(audioDir, `${baseName}.mp3`);

    // Finished, or audio already prepared → nothing to do.
    if (fs.existsSync(contextualTranscriptPath(session.group, session.effectiveSessionId, baseName))
      || hasManifest(audioDir, baseName)
      || fs.existsSync(outputPath)) {
      tally.skipped++;
      continue;
    }

    try {
      logger.info(`  [convert] ${label}`);
      await convertVideoToAudio(fullPath, outputPath);

      // Long recording → split into chunks, then drop the full file so it is
      // never transcribed a second time alongside its parts.
      const seconds = await getAudioDurationSeconds(outputPath);
      if (seconds > chunkThresholdSeconds()) {
        logger.info(`  [convert] ${(seconds / 60).toFixed(1)} min — splitting into chunks.`);
        await splitAudioIntoChunks({ fullAudioPath: outputPath, audioDir, baseName, session });
        fs.unlinkSync(outputPath);
      }
      tally.converted++;
    } catch (err) {
      fs.rmSync(outputPath, { force: true }); // never leave a half-written mp3 that looks "done"
      logger.error(`  [convert] ✗ ${label}: ${err.message}`);
      tally.failed++;
    }
  }

  logger.info(`[convert] ${tally.converted} converted, ${tally.skipped} skipped` +
    (tally.failed ? `, ${tally.failed} failed` : '') + '.');
  return tally;
}

module.exports = { run };

if (require.main === module) {
  run().catch((err) => {
    logger.error('\n[fatal error]', err.message || err);
    process.exit(1);
  });
}

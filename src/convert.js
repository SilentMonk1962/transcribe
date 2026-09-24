'use strict';
const logger = require('./lib/logger');

/**
 * convert.js
 * Extracts audio from video files using ffmpeg.
 * Output: MP3 @ 16kHz mono — optimal for Sarvam STT Batch API.
 */

const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const path = require('path');
const fs = require('fs');
const { resolveSession, DEFAULT_GROUP } = require('./lib/session-paths');
const { VIDEO_EXTENSIONS } = require('./lib/constants');
const { walkInputVideosDetailed } = require('./lib/input-walk');
const {
  chunkThresholdSeconds,
  getAudioDurationSeconds,
  hasManifest,
  readManifest,
  chunkAudioPaths,
  splitAudioIntoChunks,
} = require('./lib/chunking');

// Point fluent-ffmpeg to the bundled ffmpeg binary (no system install needed)
ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * Converts a single video file to MP3 audio.
 *
 * @param {string} inputPath  - Absolute path to the video file
 * @param {string} outputPath - Absolute path for the output .mp3 file
 * @returns {Promise<string>}  - Resolves with outputPath on success
 */
function convertVideoToAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    logger.info(`  [convert] ${path.basename(inputPath)} → ${path.basename(outputPath)}`);

    ffmpeg(inputPath)
      .noVideo()                // strip video track — audio only
      .audioChannels(1)         // mono: reduces file size, sufficient for speech
      .audioFrequency(16000)    // 16kHz: Sarvam STT preferred sample rate
      .audioCodec('libmp3lame') // MP3 codec — supported by Sarvam Batch API
      .audioBitrate('64k')      // 64kbps is enough for speech clarity
      .output(outputPath)
      .on('end', () => {
        logger.info(`  [convert] ✓ Done: ${path.basename(outputPath)}`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        logger.error(`  [convert] ✗ Failed: ${path.basename(inputPath)} — ${err.message}`);
        reject(err);
      })
      .run();
  });
}

/**
 * Scans the inputDir for video files and converts each to MP3 in audioDir.
 * Skips files that have already been converted (idempotent).
 *
 * @param {string} inputDir - Directory containing raw video files
 * @param {string} audioDir - Directory where MP3 files will be saved
 * @returns {Promise<string[]>} - Array of converted MP3 file paths
 */
async function convertAll(inputDir, audioDir) {
  // Ensure the audio output directory exists
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
  }

  // Recursively find all video files in inputDir (shared walker from
  // lib/input-walk.js, which also powers budget.js and frame-capture.js).
  // A sub-folder under input/ IS a group: the folder name becomes the group
  // slug, and every video inside it belongs to that group. Videos at the
  // input/ root fall into the default "ungrouped" bucket, each kept as its
  // own isolated session. See the session-paths.js header for how the
  // folder-derived group is persisted so every later stage honors it.
  const videoFiles = walkInputVideosDetailed(inputDir); // {fullPath, relDir}

  if (videoFiles.length === 0) {
    logger.warn(`[convert] No video files found in: ${inputDir}`);
    logger.warn(`[convert] Supported formats: ${VIDEO_EXTENSIONS.join(', ')}`);
    return [];
  }

  logger.info(`[convert] Found ${videoFiles.length} video file(s) to process.`);

  const audioPaths = [];

  for (const { fullPath: inputPath, relDir } of videoFiles) {
    const videoFile = path.basename(inputPath);
    const baseName = path.basename(videoFile, path.extname(videoFile));
    const outputPath = path.join(audioDir, `${baseName}.mp3`);

    // Group comes from the sub-folder the video sits in ("" = input/ root →
    // default ungrouped). Explicit group is persisted by resolveSession() so
    // every later stage (transcribe/merge-chunks/context-*) reuses it.
    const explicitGroup = relDir && relDir.length > 0
      ? relDir
      : DEFAULT_GROUP;

    // Resolve group + session-id as early as possible — this is the first
    // stage a new recording passes through, so this is where the same-day
    // collision prompt (if any) surfaces. The decision is cached in
    // output/<group>/session-links.json, so every later stage for this same
    // recording reuses the answer without re-prompting.
    const session = await resolveSession(baseName, { explicitGroup });
    logger.info(
      `  [convert] [session] ${baseName} -> group="${session.group}" ` +
      `session-id="${session.effectiveSessionId}"` +
      (session.effectiveSessionId !== session.sessionId ? ' (merged, same-day)' : '')
    );

    // Skip if this recording was already chunked in a previous run — reuse
    // the existing chunk files instead of re-splitting (chunking.js's own
    // resume layer, same philosophy as every other stage in this project).
    if (hasManifest(audioDir, baseName)) {
      const existingManifest = readManifest(audioDir, baseName);
      logger.info(
        `  [convert] Skipping (already chunked into ${existingManifest.chunks.length} part(s)): ${baseName}`
      );
      audioPaths.push(...chunkAudioPaths(existingManifest, audioDir));
      continue;
    }

    // Skip if already converted (and never needed chunking) — avoids re-processing on re-runs
    if (fs.existsSync(outputPath)) {
      logger.info(`  [convert] Skipping (already exists): ${path.basename(outputPath)}`);
      audioPaths.push(outputPath);
      continue;
    }

    try {
      const result = await convertVideoToAudio(inputPath, outputPath);

      // Long recordings: one Sarvam API key comfortably covers roughly one
      // 60-minute session. Split anything longer into fixed chunks BEFORE
      // transcription so no single Sarvam job — and no single key — ever
      // has to carry an oversized file. See src/lib/chunking.js for the
      // full rationale (fallback-key handling lives in transcribe.js).
      const durationSeconds = await getAudioDurationSeconds(result);
      const thresholdSeconds = chunkThresholdSeconds();

      if (durationSeconds > thresholdSeconds) {
        logger.info(
          `  [convert] ${baseName} is ${(durationSeconds / 60).toFixed(1)} min ` +
          `(> ${(thresholdSeconds / 60).toFixed(0)}-min threshold) — splitting into chunks.`
        );
        const manifest = await splitAudioIntoChunks({
          fullAudioPath: result,
          audioDir,
          baseName,
          session,
          chunkSeconds: thresholdSeconds,
        });
        // Remove the full intermediate file now that chunks exist — it must
        // not sit flat in audioDir, or later stages' flat *.mp3 scans
        // (index.js --transcribe-only resume) would treat
        // it as a THIRD, redundant copy of this recording alongside its
        // chunks.
        fs.unlinkSync(result);
        audioPaths.push(...chunkAudioPaths(manifest, audioDir));
      } else {
        audioPaths.push(result);
      }
    } catch (err) {
      // Log and continue — don't abort the entire batch for one bad file
      logger.error(`  [convert] Skipping ${videoFile} due to error: ${err.message}`);
    }
  }

  logger.info(`[convert] Conversion complete. ${audioPaths.length} audio file(s) ready.`);
  return audioPaths;
}

module.exports = { convertAll, convertVideoToAudio };

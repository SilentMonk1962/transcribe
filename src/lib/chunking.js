'use strict';
const logger = require('./logger');

/**
 * chunking.js — duration probing + fixed-length splitting of long audio, so
 * no single Sarvam job (or key) carries an oversized file and a credit
 * failure only costs the current chunk.
 *
 * Layout:
 *   audio/_chunks/<name>/manifest.json      chunk map + the session identity
 *   audio/_chunks/<name>/<name>__part01.mp3  resolved ONCE by convert.js
 *
 * Chunks never resolve their own session from their "__partNN" filename —
 * they reuse the manifest's, so all parts land in one session.
 * Merging the per-chunk transcripts happens in transcribe.js.
 */

const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// SARVAM_CHUNK_MINUTES (default 60; fractions allowed, e.g. 1.5 = 90 s).
function chunkThresholdSeconds() {
  const minutes = parseFloat(process.env.SARVAM_CHUNK_MINUTES || '60');
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60;
}

const CHUNKS_SUBDIR = '_chunks';
const MANIFEST_FILENAME = 'manifest.json';

// ─── Duration probing ──────────────────────────────────────────────────────

/**
 * Returns the duration of an audio/video file in seconds via ffprobe.
 *
 * @param {string} filePath
 * @returns {Promise<number>}
 */
function getAudioDurationSeconds(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const duration = metadata && metadata.format && metadata.format.duration;
      if (duration == null || Number.isNaN(Number(duration))) {
        return reject(new Error(`ffprobe returned no duration for ${filePath}`));
      }
      resolve(Number(duration));
    });
  });
}

// ─── Paths ──────────────────────────────────────────────────────────────────

/** @returns {string} audio/_chunks/<baseName>/ */
function chunkDir(audioDir, baseName) {
  return path.join(audioDir, CHUNKS_SUBDIR, baseName);
}

/** @returns {string} audio/_chunks/<baseName>/manifest.json */
function manifestPath(audioDir, baseName) {
  return path.join(chunkDir(audioDir, baseName), MANIFEST_FILENAME);
}

function hasManifest(audioDir, baseName) {
  return fs.existsSync(manifestPath(audioDir, baseName));
}

function readManifest(audioDir, baseName) {
  const p = manifestPath(audioDir, baseName);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeManifest(audioDir, baseName, manifest) {
  const dir = chunkDir(audioDir, baseName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath(audioDir, baseName), JSON.stringify(manifest, null, 2), 'utf8');
}

/**
 * Absolute paths to every chunk audio file in a manifest, in chunk order.
 * @param {object} manifest
 * @param {string} audioDir
 * @returns {string[]}
 */
function chunkAudioPaths(manifest, audioDir) {
  const dir = chunkDir(audioDir, manifest.originalBaseName);
  return manifest.chunks
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((c) => path.join(dir, c.file));
}

/**
 * Finds every manifest currently on disk under audio/_chunks/.
 * @param {string} audioDir
 * @returns {object[]} array of manifest objects
 */
function listAllChunkManifests(audioDir) {
  const root = path.join(audioDir, CHUNKS_SUBDIR);
  if (!fs.existsSync(root)) return [];
  const names = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const manifests = [];
  for (const name of names) {
    const m = readManifest(audioDir, name);
    if (m) manifests.push(m);
  }
  return manifests;
}

// ─── Splitting ──────────────────────────────────────────────────────────────

/**
 * Extracts one time-bounded segment from an audio file using stream copy
 * (no re-encode — fast, lossless, since the source is already the correct
 * codec/bitrate/sample-rate for Sarvam).
 *
 * @param {string} sourcePath
 * @param {string} outputPath
 * @param {number} startSeconds
 * @param {number} durationSeconds
 * @returns {Promise<void>}
 */
function extractSegment(sourcePath, outputPath, startSeconds, durationSeconds) {
  return new Promise((resolve, reject) => {
    ffmpeg(sourcePath)
      .setStartTime(startSeconds)
      .duration(durationSeconds)
      .audioCodec('copy')
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run();
  });
}

/**
 * Splits a full audio file into fixed-length chunks and writes a manifest
 * recording the ALREADY-RESOLVED session identity for the original
 * recording (see file header — every chunk reuses this, never re-resolves
 * its own).
 *
 * @param {object} opts
 * @param {string} opts.fullAudioPath  - the complete (pre-split) mp3
 * @param {string} opts.audioDir       - AUDIO_DIR
 * @param {string} opts.baseName       - original recording's base filename
 * @param {{group: string, sessionId: string, effectiveSessionId: string}} opts.session
 * @param {number} [opts.chunkSeconds] - defaults to chunkThresholdSeconds()
 * @returns {Promise<object>} the manifest written
 */
async function splitAudioIntoChunks(opts) {
  const {
    fullAudioPath,
    audioDir,
    baseName,
    session,
    chunkSeconds = chunkThresholdSeconds(),
  } = opts;

  const totalDurationSeconds = await getAudioDurationSeconds(fullAudioPath);
  const totalChunks = Math.ceil(totalDurationSeconds / chunkSeconds);

  const dir = chunkDir(audioDir, baseName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const chunks = [];
  for (let i = 0; i < totalChunks; i++) {
    const index = i + 1;
    const startOffsetSeconds = i * chunkSeconds;
    const durationSeconds = Math.min(chunkSeconds, totalDurationSeconds - startOffsetSeconds);
    const fileName = `${baseName}__part${String(index).padStart(2, '0')}.mp3`;
    const outputPath = path.join(dir, fileName);

    logger.info(
      `  [chunking] Part ${index}/${totalChunks}: ${(durationSeconds / 60).toFixed(1)} min ` +
      `(offset ${(startOffsetSeconds / 60).toFixed(1)} min) → ${fileName}`
    );
    await extractSegment(fullAudioPath, outputPath, startOffsetSeconds, durationSeconds);

    chunks.push({ index, total: totalChunks, file: fileName, startOffsetSeconds, durationSeconds });
  }

  const manifest = {
    originalBaseName: baseName,
    group: session.group,
    sessionId: session.sessionId,
    effectiveSessionId: session.effectiveSessionId,
    chunkSeconds,
    totalDurationSeconds,
    createdAt: new Date().toISOString(),
    chunks,
  };
  writeManifest(audioDir, baseName, manifest);
  return manifest;
}

module.exports = {
  chunkThresholdSeconds,
  getAudioDurationSeconds,
  chunkDir,
  hasManifest,
  chunkAudioPaths,
  listAllChunkManifests,
  splitAudioIntoChunks,
};

'use strict';
const logger = require('./logger');

/**
 * chunking.js — duration probing + fixed-length audio chunking for long
 * recordings, so no single Sarvam job (and therefore no single API key) has
 * to carry an oversized file.
 *
 * WHY THIS EXISTS:
 *   One Sarvam key comfortably covers roughly one 60-minute session. A video
 *   longer than that is split into fixed 60-minute audio chunks BEFORE
 *   transcription, so:
 *     - each Sarvam job (transcribe.js) stays a normal, resumable size
 *     - if the primary key runs dry mid-recording, only the remaining
 *       chunks need the fallback key — completed chunks are untouched
 *     - a credit failure mid-file no longer means re-paying for the whole
 *       recording, same resume philosophy as every other stage here
 *
 * WHERE CHUNKS LIVE:
 *   audio/_chunks/<originalBaseName>/
 *     manifest.json                        (this recording's chunk map)
 *     <originalBaseName>__part01.mp3
 *     <originalBaseName>__part02.mp3
 *     ...
 *
 *   Deliberately NOT flat in audio/ — index.js's
 *   --transcribe-only resume does a flat directory scan for *.mp3 in
 *   audio/. Keeping chunk files in a subfolder means those scans never see
 *   them as independent items by accident (which would otherwise try to
 *   session-resolve "MyRecording__part02" as its own unrelated recording).
 *   Callers that DO need to see chunks (transcribe.js, index.js's
 *   --transcribe-only resume, merge-chunks.js) go through
 *   the explicit helpers below instead of a raw directory scan.
 *
 * SESSION IDENTITY:
 *   The manifest embeds the group/session-id ALREADY resolved (once, by
 *   convert.js, for the original recording) via session-paths.js's
 *   resolveSession(). Every chunk of one recording reuses that exact same
 *   session identity — chunks never independently call resolveSession() on
 *   their own filename. This matters because a recording with no
 *   extractable timestamp falls back to using its whole filename as the
 *   session-id (see session-paths.js); if each chunk re-resolved its own
 *   session from ITS OWN filename ("...__part01" vs "...__part02"), those
 *   would incorrectly become separate sessions. Reusing the manifest's
 *   pre-resolved session sidesteps that entirely, for every recording,
 *   timestamped or not.
 *
 * WHAT THIS FILE DOES NOT DO:
 *   It never calls Sarvam or OpenAI. It never merges transcripts
 *   (see src/merge-chunks.js for that). It only probes duration and splits
 *   audio — pure local ffmpeg/ffprobe work.
 */

const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Default 60 minutes — overridable via SARVAM_CHUNK_MINUTES in .env (see
// .env.example). Read lazily (not at module load) so tests can override
// process.env before calling into this module.
function chunkThresholdSeconds() {
  // parseFloat, not parseInt — SARVAM_CHUNK_MINUTES is allowed to be
  // fractional (e.g. "1.5" = 90 seconds); parseInt would silently truncate
  // that to 1 instead of honoring it.
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

/**
 * Given an audio file path, determines whether it's a chunk (lives under
 * audio/_chunks/<baseName>/) and if so returns its manifest + own chunk
 * entry. Returns null for a normal, non-chunked audio file.
 *
 * @param {string} audioDir
 * @param {string} filePath
 * @returns {{manifest: object, chunkEntry: object}|null}
 */
function findManifestForChunkFile(audioDir, filePath) {
  const root = path.join(audioDir, CHUNKS_SUBDIR);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) return null;

  const parentDir = path.basename(path.dirname(resolved));
  const manifest = readManifest(audioDir, parentDir);
  if (!manifest) return null;

  const fileName = path.basename(resolved);
  const chunkEntry = manifest.chunks.find((c) => c.file === fileName);
  if (!chunkEntry) return null;

  return { manifest, chunkEntry };
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
  manifestPath,
  hasManifest,
  readManifest,
  writeManifest,
  chunkAudioPaths,
  listAllChunkManifests,
  findManifestForChunkFile,
  splitAudioIntoChunks,
};

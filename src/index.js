'use strict';
const logger = require('./lib/logger');

/**
 * index.js — Stage 1+2 orchestrator: video → audio → transcript
 *
 * These are stages 1–2 of the full pipeline (see src/pipeline.js for the
 * complete list run end-to-end). Each stage is independently runnable and
 * has its own resume logic:
 *
 *   1. convert       (this file, --convert-only)    video  → audio
 *   2. transcribe    (this file, --transcribe-only)  audio  → English transcript JSON
 *   3–7. merge-chunks → context-scan → frame-capture → frame-describe →
 *        context-inject  (see src/pipeline.js)
 *
 * Usage:
 *   node src/index.js                   → convert videos → transcribe
 *   node src/index.js --convert-only    → only run video-to-audio conversion
 *   node src/index.js --transcribe-only → skip conversion, transcribe existing ./audio/ files
 *   npm run pipeline                    → run the full pipeline in one go (see src/pipeline.js)
 *
 * Drop your video files (.mp4, .mov, .mkv, etc.) into ./input/ before running.
 * Sarvam JSON is saved under output/<group>/<session-id>/transcripts/translate/
 * (an intermediate — context-inject.js deletes it after writing the final
 * <name>-contextual.txt). Group and session-id are resolved automatically
 * (see src/lib/session-paths.js).
 */

require('dotenv').config(); // Load .env variables into process.env

const path = require('path');
const fs = require('fs');

const { config } = require('./lib/config');
const { convertAll } = require('./convert');
const { transcribeAll } = require('./transcribe');
const { listAllChunkManifests, chunkAudioPaths } = require('./lib/chunking');

// ─── Config: resolved from .env or defaults ───────────────────────────────────
const INPUT_DIR = config.inputDir();
const AUDIO_DIR = config.audioDir();
const OUTPUT_DIR = config.outputDir();
const NUM_SPEAKERS = config.numSpeakers();

// ─── CLI flags ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const CONVERT_ONLY = args.includes('--convert-only');
const TRANSCRIBE_ONLY = args.includes('--transcribe-only');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns all audio files currently ready for transcription in AUDIO_DIR —
 * both normal flat .mp3 files AND, for any recording already chunked by a
 * previous convert run, its chunk files under audio/_chunks/ (see
 * src/lib/chunking.js; a flat scan alone would miss those, since they're
 * deliberately kept out of the flat directory). Used when running in
 * --transcribe-only mode, i.e. resuming after conversion already happened.
 *
 * @returns {string[]} Array of absolute MP3 paths
 */
function getExistingAudioFiles() {
  if (!fs.existsSync(AUDIO_DIR)) {
    return [];
  }
  const flatFiles = fs
    .readdirSync(AUDIO_DIR)
    .filter((f) => f.toLowerCase().endsWith('.mp3'))
    .map((f) => path.join(AUDIO_DIR, f));

  const chunkFiles = listAllChunkManifests(AUDIO_DIR)
    .flatMap((manifest) => chunkAudioPaths(manifest, AUDIO_DIR));

  return [...flatFiles, ...chunkFiles];
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  logger.info('============================================================');
  logger.info(' Transcribe Audio Recordings — Sarvam AI Integration');
  logger.info('============================================================');
  logger.info(`Input dir  : ${INPUT_DIR}`);
  logger.info(`Audio dir  : ${AUDIO_DIR}`);
  logger.info(`Output dir : ${OUTPUT_DIR}`);
  logger.info(`Speakers   : up to ${NUM_SPEAKERS}`);
  logger.info('');

  let audioPaths = [];

  // ── Step 1: Video → Audio conversion ───────────────────────────────────────
  if (!TRANSCRIBE_ONLY) {
    logger.info('[step 1/2] Converting videos to audio...');
    audioPaths = await convertAll(INPUT_DIR, AUDIO_DIR);
  } else {
    logger.info('[step 1/2] Skipped (--transcribe-only flag set).');
    audioPaths = getExistingAudioFiles();
    logger.info(`[step 1/2] Found ${audioPaths.length} existing audio file(s) in ${AUDIO_DIR}`);
  }

  if (audioPaths.length === 0) {
    // As a single pipeline stage, "nothing new" is not an error — earlier
    // runs may have finished everything (or only legacy transcripts remain).
    if (CONVERT_ONLY || TRANSCRIBE_ONLY) {
      logger.info('\n[info] No audio files to process — nothing to do for this stage.');
      return;
    }
    logger.error('\n[error] No audio files to process. Add video files to ./input/ and re-run.');
    process.exit(1);
  }

  if (CONVERT_ONLY) {
    logger.info('\n[step 2/2] Skipped (--convert-only flag set).');
    logger.info(`\nDone. ${audioPaths.length} audio file(s) saved to: ${AUDIO_DIR}`);
    return;
  }

  // ── Step 2: Transcribe via Sarvam Batch API ─────────────────────────────────
  // Sarvam keys come from the shared pool (lib/sarvam-keys.js) — SARVAM_API_KEYS
  // comma list, or the legacy SARVAM_API_KEY / SARVAM_API_KEY_FALLBACK pair.
  // transcribeAll() throws a clear message if no keys are configured.
  logger.info('\n[step 2/2] Submitting to Sarvam AI for transcription...');

  await transcribeAll(audioPaths, {
    numSpeakers: NUM_SPEAKERS,
    audioDir: AUDIO_DIR,
  });

  // ── Summary ─────────────────────────────────────────────────────────────────
  logger.info('\n============================================================');
  logger.info(' All done!');
  logger.info(`\n English transcript JSON saved under: output/<group>/<session-id>/transcripts/translate/`);
  logger.info(' Run "npm run pipeline" (or the remaining stage scripts) for the contextual transcript.');
  logger.info('============================================================\n');
}

main().catch((err) => {
  logger.error('\n[fatal error]', err.message || err);
  process.exit(1);
});

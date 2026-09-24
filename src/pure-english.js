'use strict';
const logger = require('./lib/logger');

/**
 * pure-english.js — Stage 3 of the modular pipeline (see src/pipeline.js).
 * Produces pure English transcriptions for all recordings.
 *
 * STRATEGY (zero wasted credits):
 *   - Sessions that already have a completed translate JSON in this session's
 *     transcripts/translate/ folder are COPIED directly — no Sarvam API call made.
 *   - Sessions missing translate output are submitted to Sarvam Batch API
 *     using the SAME shared Sarvam key pool as transcribe.js (lib/sarvam-keys.js).
 *
 * RESILIENCE:
 *   Layer 1 — Resume:      Checks transcripts/pure-english/{name}.json before any
 *                          action. Already-done files are skipped unconditionally.
 *   Layer 2 — Per-file:    1 audio file = 1 Sarvam job. Credit failure stops only
 *                          the current file; all previous files are already saved.
 *   Layer 3 — Key rotation: on credit exhaustion the shared key pool rotates to
 *                          the next key and retries the same file; when every key
 *                          is used up it prints a clean message and exits (code 2).
 *
 * Output: output/<group>/<session-id>/transcripts/pure-english/{name}.json
 *         + {name}-pure-english.txt
 *   Group + session-id are resolved per file via src/lib/session-paths.js.
 *
 * Usage:
 *   node src/pure-english.js
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { config } = require('./lib/config');
const { resolveSession, transcriptsModeDir, ensureDir } = require('./lib/session-paths');
const { listAllChunkManifests } = require('./lib/chunking');
const { SarvamKeyPool } = require('./lib/sarvam-keys');
const { isCreditError } = require('./lib/credit-errors');
const { withSarvamKeyRetry } = require('./lib/credit-runner');
const { formatTranscript } = require('./lib/transcript-format');

// ─── Paths ────────────────────────────────────────────────────────────────────
const AUDIO_DIR = config.audioDir();
// NOTE: translate/pure-english output dirs are no longer a single global
// folder — each audio file resolves its own
// output/<group>/<session-id>/transcripts/{translate,pure-english}/ via
// session-paths.js. See processOneFile() below.

// ─── Config ───────────────────────────────────────────────────────────────────
const NUM_SPEAKERS = config.numSpeakers();
const SARVAM_MODEL = config.sarvamModel();

// ─── Core: process one file ───────────────────────────────────────────────────

/**
 * Produces a pure English output for one audio file.
 *
 * Priority order:
 *   1. Already done (output/pure-english/{name}.json exists) → skip
 *   2. Existing translate JSON (output/translate/{name}.json exists) → copy, free
 *   3. Submit to Sarvam Batch API with mode=translate → uses the shared key pool
 *
 * @param {import('sarvamai').SarvamAIClient|null} client - Sarvam client (null if no key configured)
 * @param {string}              audioPath
 * @param {number}              numSpeakers
 * @param {string}              progress  - "[1/4]"
 * @returns {Promise<'skipped'|'copied'|'transcribed'|'failed'>}
 */
async function processOneFile(client, audioPath, numSpeakers, progress) {
  const baseName = path.basename(audioPath, path.extname(audioPath));

  // Resolve this recording's group + session-id (cached from the convert/
  // transcribe stages — will not re-prompt for same-day collisions).
  const session = await resolveSession(baseName);
  const translateDir = transcriptsModeDir(session.group, session.effectiveSessionId, 'translate');
  const pureEngDir    = transcriptsModeDir(session.group, session.effectiveSessionId, 'pure-english');
  ensureDir(pureEngDir);

  const finalJson    = path.join(pureEngDir, `${baseName}.json`);
  const finalTxt     = path.join(pureEngDir, `${baseName}-pure-english.txt`);
  const existingJson = path.join(translateDir, `${baseName}.json`);

  // ── LAYER 1: Resume — already fully done ───────────────────────────────────
  if (fs.existsSync(finalJson)) {
    logger.info(`  ${progress} ⏭  Already done, skipping: ${baseName}`);
    return 'skipped';
  }

  // ── FREE PATH: copy from existing translate output ─────────────────────────
  if (fs.existsSync(existingJson)) {
    logger.info(`  ${progress} 📋 Copying from existing translate output: ${baseName}`);
    fs.copyFileSync(existingJson, finalJson);
    const result = JSON.parse(fs.readFileSync(finalJson, 'utf8'));
    fs.writeFileSync(finalTxt, formatTranscript(result, path.basename(audioPath), 'pure-english'), 'utf8');
    logger.info(`  ${progress} ✓  Copied → ${path.basename(finalTxt)}`);
    return 'copied';
  }

  // ── SARVAM PATH: submit to API ─────────────────────────────────────────────
  if (!client) {
    logger.error(`  ${progress} ✗  No Sarvam key available. Set SARVAM_API_KEYS in .env`);
    logger.error(`       Skipping: ${baseName}`);
    return 'skipped';
  }

  // A chunked recording's synthetic entry (see main() below) has no real
  // file on disk — it only exists to give this stage something to key the
  // FREE PATH lookup off of. If we get here for one, merge-chunks hasn't
  // produced transcripts/translate/<name>.json yet — run it first rather
  // than letting this fail on a confusing ENOENT from the upload call.
  if (!fs.existsSync(audioPath)) {
    logger.error(`  ${progress} ✗  No merged translate transcript yet for: ${baseName}`);
    logger.error(`       Run "npm run merge-chunks" first (this is a chunked recording).`);
    return 'skipped';
  }

  logger.info(`  ${progress} 🔄 Submitting to Sarvam (translate mode): ${baseName}`);

  try {
    // ── LAYER 2: One file per job ──────────────────────────────────────────
    const job = await client.speechToTextJob.createJob({
      model: SARVAM_MODEL,
      mode: 'translate',       // pure English output
      withDiarization: true,
      numSpeakers: numSpeakers,
    });

    await job.uploadFiles([audioPath]);
    await job.start();

    logger.info(`  ${progress} ⏳ Processing... (may take several minutes)`);
    await job.waitUntilComplete();

    const fileResults = await job.getFileResults();

    // Check for job-level credit failure
    if (fileResults.failed && fileResults.failed.length > 0) {
      const errMsg = fileResults.failed[0].error_message || 'Unknown error';
      if (isCreditError(errMsg)) {
        const err = new Error(errMsg);
        err.isCreditError = true;
        throw err;
      }
      logger.error(`  ${progress} ✗  Sarvam rejected file: ${errMsg}`);
      return 'failed';
    }

    // Download into temp folder
    const tempDir = path.join(pureEngDir, `_tmp_${baseName}`);
    fs.mkdirSync(tempDir, { recursive: true });
    try {
      await job.downloadOutputs(tempDir);
    } catch (err) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw err;
    }

    // Move the downloaded JSON to final location (SDK names it after source file)
    const downloaded = fs.readdirSync(tempDir).filter((f) => f.endsWith('.json'));
    if (downloaded.length > 0) {
      fs.renameSync(path.join(tempDir, downloaded[0]), finalJson);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });

    // Write formatted .txt
    let result;
    try {
      result = JSON.parse(fs.readFileSync(finalJson, 'utf8'));
    } catch (err) {
      logger.error(`  ${progress} ✗  Could not read/parse Sarvam output for ${baseName}: ${err.message}`);
      return 'failed'; // nothing to resume on — the re-run will fetch it again
    }
    fs.writeFileSync(finalTxt, formatTranscript(result, path.basename(audioPath), 'pure-english'), 'utf8');
    logger.info(`  ${progress} ✓  Done → ${path.basename(finalTxt)}`);
    return 'transcribed';

  } catch (err) {
    // ── LAYER 3: Credit error detection at exception level ─────────────────
    if (err.isCreditError || isCreditError(err.message) || isCreditError(String(err.status))) {
      err.isCreditError = true;
      throw err;
    }
    logger.error(`  ${progress} ✗  Error: ${err.message}`);
    return 'failed';
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  logger.info('============================================================');
  logger.info(' Pure English Transcription — Sarvam AI');
  logger.info('============================================================');

  // Collect audio files
  if (!fs.existsSync(AUDIO_DIR)) {
    logger.error(`[error] Audio directory not found: ${AUDIO_DIR}`);
    process.exit(1);
  }
  const flatAudioPaths = fs.readdirSync(AUDIO_DIR)
    .filter((f) => f.toLowerCase().endsWith('.mp3'))
    .map((f) => path.join(AUDIO_DIR, f));

  // Chunked recordings (see src/lib/chunking.js) don't leave a flat mp3 in
  // AUDIO_DIR — their original file was split into audio/_chunks/<name>/
  // and removed by convert.js. Represent each one as a single synthetic
  // entry keyed by its ORIGINAL basename, so this stage still sees exactly
  // "one item per session" like the non-chunked case. This file never
  // exists on disk — it doesn't need to. By the time this stage runs
  // (merge-chunks runs before it in the pipeline), the merged
  // transcripts/translate/<name>.json already exists, so the FREE PATH
  // below copies it without ever touching this path or calling Sarvam.
  const chunkedBaseNames = listAllChunkManifests(AUDIO_DIR).map((m) => m.originalBaseName);
  const syntheticPaths = chunkedBaseNames.map((name) => path.join(AUDIO_DIR, `${name}.mp3`));

  const audioPaths = [...flatAudioPaths, ...syntheticPaths].sort();

  if (audioPaths.length === 0) {
    logger.error('[error] No .mp3 files found in audio/. Run npm run convert-only first.');
    process.exit(1);
  }

  // Sarvam key pool — shared with transcribe.js. Files that already have
  // translate output don't need a client at all.
  const pool = new SarvamKeyPool();

  if (pool.total === 0) {
    logger.warn('[warn] No Sarvam keys configured (set SARVAM_API_KEYS in .env)');
    logger.warn('       Files with existing translate output will still be copied for free.');
    logger.warn('       Set a key for files that need a new Sarvam API call.\n');
  } else {
    logger.info(`[info] ${pool.total} Sarvam key(s) configured (rotates automatically on credit exhaustion).`);
  }

  logger.info(`[info] ${audioPaths.length} audio file(s) found.`);
  logger.info(`[info] Output → output/<group>/<session-id>/transcripts/pure-english/\n`);

  const total = audioPaths.length;
  let doneCount = 0;
  let failedCount = 0;

  for (let i = 0; i < audioPaths.length; i++) {
    const progress = `[${i + 1}/${total}]`;
    // Retry/rotate logic lives in withSarvamKeyRetry (lib/credit-runner.js):
    // the same file retries on the next key after a credit error, and when
    // every key is spent it prints the resume box and exits with code 2.
    const result = await withSarvamKeyRetry({
      pool,
      serviceLabel: 'Sarvam',
      topUpUrl: 'https://dashboard.sarvam.ai/',
      resumeCmd: 'npm run pure-english',
      currentItem: path.basename(audioPaths[i]),
      doneCount,
      totalCount: total,
      attempt: (retryClient) =>
        processOneFile(retryClient, audioPaths[i], NUM_SPEAKERS, progress),
    });
    if (result === 'copied' || result === 'transcribed') doneCount++;
    if (result === 'failed') failedCount++;
  }

  logger.info('\n============================================================');
  logger.info(` Done. Pure English transcriptions saved under:`);
  logger.info(` output/<group>/<session-id>/transcripts/pure-english/`);
  logger.info(
    ` ${doneCount} done` +
    (failedCount > 0 ? `, ${failedCount} failed (will be retried on the next run)` : '') +
    '.'
  );
  logger.info('============================================================\n');
}

main().catch((err) => {
  logger.error('\n[fatal error]', err.message || err);
  process.exit(1);
});

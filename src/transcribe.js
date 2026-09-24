'use strict';
const logger = require('./lib/logger');

/**
 * transcribe.js
 * Submits audio files to the Sarvam AI Batch Speech-to-Text API.
 *
 * RESILIENCE LAYERS:
 *   Layer 1 — Resume:       Each file's output is named after the source audio file.
 *                            On re-run, already-completed files are skipped automatically.
 *   Layer 2 — Per-file jobs: 1 file = 1 Sarvam job. If credits die mid-way, only the
 *                            current file fails. All previous files are already saved.
 *   Layer 3 — Key rotation:  All Sarvam keys come from ONE pool (lib/sarvam-keys.js —
 *                            SARVAM_API_KEYS comma list, or legacy SARVAM_API_KEY +
 *                            SARVAM_API_KEY_FALLBACK). On credit exhaustion the pool
 *                            rotates to the next key and the SAME file retries
 *                            automatically. When every key is exhausted it prints a
 *                            clean, human-readable message and exits (code 2).
 *
 * Runs ONE pass per file by default (mode = "translate" — full English
 * translation; the Hinglish "codemix" pass is skipped unless
 * SARVAM_TRANSLATE_ONLY=0, see src/lib/modes.js — the codemix output is not
 * consumed by any downstream stage, so translate-only halves billed
 * audio-minutes).
 *
 * Output per file: raw JSON from Sarvam + a formatted .txt transcript
 */

const fs = require('fs');
const path = require('path');
const { config } = require('./lib/config');
const { resolveSession, transcriptsModeDir, ensureDir } = require('./lib/session-paths');
const { findManifestForChunkFile } = require('./lib/chunking');
const { SarvamKeyPool } = require('./lib/sarvam-keys');
const { isCreditError } = require('./lib/credit-errors');
const { withSarvamKeyRetry } = require('./lib/credit-runner');
const { translationModes } = require('./lib/modes');

/**
 * Resolves the group/session-id for ONE audio file, chunk-aware.
 *
 * A chunk file (audio/_chunks/<baseName>/<baseName>__partNN.mp3) must NEVER
 * independently call resolveSession() on its own filename — that would
 * treat each chunk as its own unrelated recording (see chunking.js header
 * for why). Instead it reuses the session identity already resolved once,
 * by convert.js, for the ORIGINAL recording and stored in the manifest.
 * Non-chunked files fall through to the normal resolveSession() path,
 * unchanged.
 *
 * @param {string} audioDir
 * @param {string} audioPath
 * @returns {Promise<{group: string, sessionId: string, effectiveSessionId: string, hasTimestamp: boolean, isChunk: boolean, chunkEntry?: object}>}
 */
async function resolveSessionForAudioFile(audioDir, audioPath) {
  const chunkInfo = findManifestForChunkFile(audioDir, audioPath);
  if (chunkInfo) {
    const { manifest, chunkEntry } = chunkInfo;
    return {
      group: manifest.group,
      sessionId: manifest.sessionId,
      effectiveSessionId: manifest.effectiveSessionId,
      hasTimestamp: true,
      isChunk: true,
      chunkEntry,
    };
  }
  const baseName = path.basename(audioPath, path.extname(audioPath));
  const session = await resolveSession(baseName);
  return { ...session, isChunk: false };
}

// ─── Transcript formatter ─────────────────────────────────────────────────────
// Shared implementation in lib/transcript-format.js — re-exported here so
// merge-chunks.js keeps its long-standing `require('./transcribe')` import.
const { formatTranscript } = require('./lib/transcript-format');

// ─── Core: single-file, single-mode job ───────────────────────────────────────

/**
 * Processes ONE audio file in ONE mode (codemix or translate).
 *
 * Layer 1 — Resume: checks if output JSON already exists; skips if so.
 * Layer 2 — Per-file: creates a fresh Sarvam job for just this one file.
 * Layer 3 — Credit errors: caught and re-thrown with isCreditError flag set
 *            (the caller, transcribeAll, handles rotation + clean exit).
 *
 * @param {import('sarvamai').SarvamAIClient} client - Initialised SDK client
 * @param {string}   audioPath    - Absolute path to the MP3 file
 * @param {string}   mode         - "codemix" or "translate"
 * @param {string}   jobOutputDir - Resolved per-session transcripts/<mode>/ directory
 * @param {number}   numSpeakers  - Max expected speakers
 * @param {string}   progress     - Display string e.g. "[1/4]"
 * @returns {Promise<'done'|'skipped'|'failed'>}
 */
async function processOneFile(client, audioPath, mode, jobOutputDir, numSpeakers, progress) {
  const modeLabel = mode === 'codemix' ? 'Codemix' : 'Translate';
  const baseName = path.basename(audioPath, path.extname(audioPath));

  ensureDir(jobOutputDir);

  // ── LAYER 1: Resume check ──────────────────────────────────────────────────
  // Output JSON is named after the source audio file — if it exists, we're done.
  const finalJsonPath = path.join(jobOutputDir, `${baseName}.json`);
  if (fs.existsSync(finalJsonPath)) {
    logger.info(`  ${progress} [${modeLabel}] ⏭  Skipping (already done): ${baseName}`);
    return 'skipped';
  }

  logger.info(`  ${progress} [${modeLabel}] Submitting: ${baseName}`);

  try {
    // ── LAYER 2: One file per job ──────────────────────────────────────────
    const job = await client.speechToTextJob.createJob({
      model: config.sarvamModel(),
      mode: mode,
      withDiarization: true,
      numSpeakers: numSpeakers,
    });

    await job.uploadFiles([audioPath]); // only this one file — SDK takes a plain array
    await job.start();

    logger.info(`  ${progress} [${modeLabel}] Processing... (may take several minutes)`);
    await job.waitUntilComplete();

    // Check if Sarvam reports a file-level failure
    const fileResults = await job.getFileResults();

    if (fileResults.failed && fileResults.failed.length > 0) {
      const errMsg = fileResults.failed[0].error_message || 'Unknown error';

      // ── LAYER 3: Credit error at job-result level ──────────────────────
      if (isCreditError(errMsg)) {
        const err = new Error(errMsg);
        err.isCreditError = true;
        throw err;
      }

      logger.error(`  ${progress} [${modeLabel}] ✗ Sarvam rejected file: ${errMsg}`);
      return 'failed'; // failed but not a credit error — reported, retried on next run
    }

    // Download into a temp folder — SDK names the file after the source audio
    const tempDir = path.join(jobOutputDir, `_tmp_${baseName}`);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      await job.downloadOutputs(tempDir);
    } catch (err) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw err;
    }

    // Find whatever .json the SDK dropped (name varies by SDK version)
    const downloadedFiles = fs.readdirSync(tempDir).filter((f) => f.endsWith('.json'));
    if (downloadedFiles.length > 0) {
      fs.renameSync(path.join(tempDir, downloadedFiles[0]), finalJsonPath);
    }

    // Clean up temp dir — rmSync handles non-empty dirs (rmdirSync does not)
    fs.rmSync(tempDir, { recursive: true, force: true });

    // Parse and write human-readable .txt
    let raw, result;
    try {
      raw = fs.readFileSync(finalJsonPath, 'utf8');
      result = JSON.parse(raw);
    } catch (err) {
      logger.error(`  ${progress} [${modeLabel}] ✗ Could not read/parse Sarvam output for ${baseName}: ${err.message}`);
      return 'failed'; // nothing to resume on — the re-run will fetch it again
    }
    const formatted = formatTranscript(result, path.basename(audioPath), mode);
    const txtPath = path.join(jobOutputDir, `${baseName}_${mode}.txt`);
    fs.writeFileSync(txtPath, formatted, 'utf8');

    logger.info(`  ${progress} [${modeLabel}] ✓ Done → ${baseName}_${mode}.txt`);
    return 'done';

  } catch (err) {
    // ── LAYER 3: Credit error at API/exception level ───────────────────────
    if (err.isCreditError || isCreditError(err.message) || isCreditError(String(err.status))) {
      err.isCreditError = true; // ensure flag is set before re-throw
      throw err;
    }

    // Any other error: log cleanly and report as failed (not "done") — the
    // run summary distinguishes these, and resume re-attempts them next run.
    logger.error(`  ${progress} [${modeLabel}] ✗ Error processing ${baseName}: ${err.message}`);
    return 'failed';
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Transcribes all audio files in both codemix and translate modes.
 * Processes one file at a time. On credit exhaustion the shared SarvamKeyPool
 * rotates to the next key and the SAME file retries automatically; when every
 * key is exhausted it prints the clean resume guide and exits with code 2
 * (pipeline.js treats 2 as "stopped intentionally").
 *
 * @param {string[]} audioPaths - Array of absolute MP3 paths (may include
 *                                chunk files under audio/_chunks/, see
 *                                src/lib/chunking.js)
 * @param {object}   options
 * @param {number}   [options.numSpeakers] - Max speakers per recording (default 8)
 * @param {string}   options.audioDir      - AUDIO_DIR, needed to detect chunk files
 *
 * NOTE ON PATHS: output directory is no longer a single global folder. Each
 * audio file resolves its own output/<group>/<session-id>/transcripts/<mode>/
 * folder via resolveSessionForAudioFile() above — chunk files reuse their
 * original recording's already-resolved session instead of re-resolving
 * from their own (suffixed) filename.
 */
async function transcribeAll(audioPaths, options = {}) {
  const { numSpeakers = 8, audioDir } = options;

  const pool = new SarvamKeyPool();
  if (pool.total === 0) {
    throw new Error(
      'No Sarvam API keys found. Set SARVAM_API_KEYS (comma-separated list) — or ' +
      'the legacy SARVAM_API_KEY (+ optional SARVAM_API_KEY_FALLBACK) — in your .env file.'
    );
  }
  if (!audioPaths || audioPaths.length === 0) {
    throw new Error('No audio files provided for transcription.');
  }

  const total = audioPaths.length;

  logger.info(`\n[sarvam] ${total} file(s) to process.`);
  const modes = translationModes();
  logger.info(`[sarvam] Modes: ${modes.join(' + ')} (translate-only is the default; set SARVAM_TRANSLATE_ONLY=0 for the codemix pass too)`);
  logger.info(`[sarvam] Speakers: up to ${numSpeakers}`);
  logger.info(`[sarvam] Keys: ${pool.total} configured (rotates automatically on credit exhaustion)`);
  logger.info(`[sarvam] Resume: already-completed files will be skipped.\n`);

  // Process each mode for all files, one mode at a time.
  // Each file is an independent job — a credit failure only stops the current file.

  for (const mode of modes) {
    const modeLabel = mode === 'codemix' ? 'Codemix' : 'Translate';
    logger.info(`\n── ${modeLabel} pass ──────────────────────────────────────`);

    let doneCount = 0;
    let failedCount = 0;

    for (let i = 0; i < audioPaths.length; i++) {
      const progress = `[${i + 1}/${total}]`;
      const session = await resolveSessionForAudioFile(audioDir, audioPaths[i]);
      const jobOutputDir = transcriptsModeDir(session.group, session.effectiveSessionId, mode);

      // Retry/rotate logic lives in withSarvamKeyRetry (lib/credit-runner.js):
      // on a credit error the SAME file/mode retries on the next key, and when
      // every key is spent it prints the resume box and exits with code 2.
      const result = await withSarvamKeyRetry({
        pool,
        serviceLabel: 'Sarvam',
        topUpUrl: 'https://dashboard.sarvam.ai/',
        resumeCmd: 'npm run transcribe-only',
        currentItem: path.basename(audioPaths[i]),
        doneCount,
        totalCount: total,
        detailLines: [
          `Mode     : ${modeLabel}`,
          `Keys     : all ${pool.total} in the pool are exhausted.`,
        ],
        attempt: (retryClient) =>
          processOneFile(retryClient, audioPaths[i], mode, jobOutputDir, numSpeakers, progress),
      });
      if (result === 'done') doneCount++;
      if (result === 'failed') failedCount++;
    }

    logger.info(
      `\n[sarvam:${modeLabel}] Pass complete.` +
      ` ${doneCount} done` +
      (failedCount > 0 ? `, ${failedCount} failed (will be retried on the next run)` : '') +
      '.'
    );
  }

  logger.info(`\n[sarvam] All done. Transcripts saved under: output/<group>/<session-id>/transcripts/`);
}

module.exports = { transcribeAll, formatTranscript, resolveSessionForAudioFile };

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
 * Runs exactly ONE pass per file: mode = "translate" (full English
 * translation). The Hinglish "codemix" pass was removed — it only bloated each
 * session folder with a near-duplicate transcript.
 *
 * Output per file: raw Sarvam JSON only (transcripts/translate/<name>.json).
 * It is an INTERMEDIATE — the human-readable deliverable is written later by
 * context-inject.js as <name>-contextual.txt, after which this JSON is deleted.
 * A recording whose contextual transcript already exists is never re-billed.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('./lib/config');
const {
  resolveSession,
  transcriptsModeDir,
  contextualTranscriptPath,
  ensureDir,
} = require('./lib/session-paths');
const { findManifestForChunkFile } = require('./lib/chunking');
const { SarvamKeyPool } = require('./lib/sarvam-keys');
const { isCreditError } = require('./lib/credit-errors');
const { withSarvamKeyRetry } = require('./lib/credit-runner');

// The only Sarvam pass the pipeline runs (codemix removed — see header).
const MODE = 'translate';

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
 * @returns {Promise<{group: string, sessionId: string, effectiveSessionId: string, hasTimestamp: boolean, isChunk: boolean, recordingBaseName: string, chunkEntry?: object}>}
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
      // The ORIGINAL recording's name — the final contextual transcript is
      // keyed by it, never by the chunk's suffixed name.
      recordingBaseName: manifest.originalBaseName,
      chunkEntry,
    };
  }
  const baseName = path.basename(audioPath, path.extname(audioPath));
  const session = await resolveSession(baseName);
  return { ...session, isChunk: false, recordingBaseName: baseName };
}

// ─── Core: single-file, single-mode job ───────────────────────────────────────

/**
 * Processes ONE audio file in translate mode.
 *
 * Layer 1 — Resume: skips if the output JSON already exists, OR if the
 *            recording's final contextual transcript exists (the JSON is
 *            deleted after the final is written — see context-inject.js).
 * Layer 2 — Per-file: creates a fresh Sarvam job for just this one file.
 * Layer 3 — Credit errors: caught and re-thrown with isCreditError flag set
 *            (the caller, transcribeAll, handles rotation + clean exit).
 *
 * @param {import('sarvamai').SarvamAIClient} client - Initialised SDK client
 * @param {string}   audioPath    - Absolute path to the MP3 file
 * @param {string}   jobOutputDir - Resolved per-session transcripts/translate/ directory
 * @param {string}   finalPath    - This recording's <name>-contextual.txt path
 * @param {number}   numSpeakers  - Max expected speakers
 * @param {string}   progress     - Display string e.g. "[1/4]"
 * @returns {Promise<'done'|'skipped'|'failed'>}
 */
async function processOneFile(client, audioPath, jobOutputDir, finalPath, numSpeakers, progress) {
  const modeLabel = 'Translate';
  const baseName = path.basename(audioPath, path.extname(audioPath));

  // ── LAYER 1: Resume check ──────────────────────────────────────────────────
  // Final deliverable already written → intermediates were cleaned up on
  // purpose; never re-bill Sarvam for this recording.
  if (fs.existsSync(finalPath)) {
    logger.info(`  ${progress} [${modeLabel}] ⏭  Skipping (contextual transcript exists): ${baseName}`);
    return 'skipped';
  }

  ensureDir(jobOutputDir);

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
      mode: MODE,
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

    // Validate the JSON now — a corrupt file must not look "done" to resume.
    try {
      JSON.parse(fs.readFileSync(finalJsonPath, 'utf8'));
    } catch (err) {
      logger.error(`  ${progress} [${modeLabel}] ✗ Could not read/parse Sarvam output for ${baseName}: ${err.message}`);
      fs.rmSync(finalJsonPath, { force: true });
      return 'failed'; // re-run will fetch it again
    }

    logger.info(`  ${progress} [${modeLabel}] ✓ Done → ${baseName}.json`);
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
 * Transcribes all audio files in translate (English) mode.
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
 * audio file resolves its own output/<group>/<session-id>/transcripts/translate/
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
  logger.info(`[sarvam] Mode: translate (English)`);
  logger.info(`[sarvam] Speakers: up to ${numSpeakers}`);
  logger.info(`[sarvam] Keys: ${pool.total} configured (rotates automatically on credit exhaustion)`);
  logger.info(`[sarvam] Resume: already-completed files will be skipped.\n`);

  // Each file is an independent job — a credit failure only stops the current file.
  let doneCount = 0;
  let failedCount = 0;

  for (let i = 0; i < audioPaths.length; i++) {
    const progress = `[${i + 1}/${total}]`;
    const session = await resolveSessionForAudioFile(audioDir, audioPaths[i]);
    const jobOutputDir = transcriptsModeDir(session.group, session.effectiveSessionId, MODE);
    const finalPath = contextualTranscriptPath(
      session.group, session.effectiveSessionId, session.recordingBaseName
    );

    // Retry/rotate logic lives in withSarvamKeyRetry (lib/credit-runner.js):
    // on a credit error the SAME file retries on the next key, and when
    // every key is spent it prints the resume box and exits with code 2.
    const result = await withSarvamKeyRetry({
      pool,
      serviceLabel: 'Sarvam',
      topUpUrl: 'https://dashboard.sarvam.ai/',
      resumeCmd: 'npm run transcribe-only',
      currentItem: path.basename(audioPaths[i]),
      doneCount,
      totalCount: total,
      detailLines: [`Keys     : all ${pool.total} in the pool are exhausted.`],
      attempt: (retryClient) =>
        processOneFile(retryClient, audioPaths[i], jobOutputDir, finalPath, numSpeakers, progress),
    });
    if (result === 'done') doneCount++;
    if (result === 'failed') failedCount++;
  }

  logger.info(
    `\n[sarvam] Pass complete.` +
    ` ${doneCount} done` +
    (failedCount > 0 ? `, ${failedCount} failed (will be retried on the next run)` : '') +
    '.'
  );

  logger.info(`\n[sarvam] All done. Transcripts saved under: output/<group>/<session-id>/transcripts/`);
}

module.exports = { transcribeAll, resolveSessionForAudioFile };

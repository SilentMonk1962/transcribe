'use strict';
const logger = require('./lib/logger');

/**
 * merge-chunks.js — new pipeline stage, runs between transcribe and
 * pure-english (see src/pipeline.js). Stitches the per-chunk transcripts
 * produced by transcribe.js for a >60-minute recording (see
 * src/lib/chunking.js) back into ONE continuous transcript, written to the
 * exact path a normal, non-chunked session would use. This is deliberate:
 * it means pure-english.js, meeting-notes.js, verify-notes.js, and every
 * vision-assist stage need ZERO changes to handle chunked recordings — they
 * only ever see one codemix/translate transcript per session, exactly like
 * before chunking existed.
 *
 * WHAT IT DOES, per chunk manifest (audio/_chunks/<name>/manifest.json):
 *   1. For each mode (codemix, translate), waits until every chunk's own
 *      transcript JSON exists (written by transcribe.js under
 *      transcripts/<mode>/<name>__partNN.json). If any are still missing —
 *      e.g. the run stopped partway on a credit error with no fallback
 *      configured — this manifest+mode is skipped for now, not failed, so
 *      a later re-run (after transcribe finishes) picks it up cleanly.
 *   2. Concatenates the chunks' diarized entries and timestamp arrays in
 *      order, offsetting every timestamp by that chunk's startOffsetSeconds
 *      so the merged transcript reads as one continuous timeline instead
 *      of restarting at 00:00 every ~60 minutes.
 *   3. Writes the merged JSON + formatted .txt to
 *      transcripts/<mode>/<originalBaseName>.json / _<mode>.txt — same
 *      location and shape transcribe.js would use for a single, non-chunked
 *      file, via the same formatTranscript() it already uses (imported, not
 *      duplicated).
 *
 * RESUME: if the merged output already exists, that manifest+mode is
 * skipped — merging never re-runs once done, same philosophy as every
 * other stage in this project.
 *
 * KNOWN LIMITATION — speaker IDs across chunk boundaries: each chunk was
 * transcribed as an independent Sarvam job, so diarization speaker_id
 * numbering is NOT guaranteed to stay consistent from one chunk to the
 * next (e.g. "Speaker 1" in chunk 2 is not necessarily the same physical
 * person as "Speaker 1" in chunk 1). This merge does not attempt
 * cross-chunk speaker reconciliation — flagged here plainly rather than
 * silently guessed at. Timestamps and transcript text are unaffected and
 * fully reliable.
 *
 * Usage:
 *   node src/merge-chunks.js
 *   npm run merge-chunks
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { config } = require('./lib/config');
const { transcriptsModeDir, ensureDir } = require('./lib/session-paths');
const { formatTranscript } = require('./transcribe');
const { listAllChunkManifests } = require('./lib/chunking');
const { translationModes } = require('./lib/modes');

const AUDIO_DIR = config.audioDir();
const MODES = translationModes();

/**
 * Returns a deep copy of one chunk's parsed transcript JSON with every
 * timestamp field shifted forward by that chunk's startOffsetSeconds. The
 * source chunk JSON on disk is never modified — only the in-memory copy
 * used to build the merged result.
 *
 * @param {object} chunkResult - parsed JSON from one chunk's transcript
 * @param {number} offsetSeconds
 * @returns {object} offset-adjusted copy
 */
function offsetTimestamps(chunkResult, offsetSeconds) {
  const copy = JSON.parse(JSON.stringify(chunkResult));

  if (copy.diarized_transcript && Array.isArray(copy.diarized_transcript.entries)) {
    for (const entry of copy.diarized_transcript.entries) {
      if (entry.start_time_seconds != null) entry.start_time_seconds += offsetSeconds;
      if (entry.end_time_seconds != null) entry.end_time_seconds += offsetSeconds;
    }
  }

  if (copy.timestamps) {
    if (Array.isArray(copy.timestamps.start_time_seconds)) {
      copy.timestamps.start_time_seconds = copy.timestamps.start_time_seconds.map((s) => s + offsetSeconds);
    }
    if (Array.isArray(copy.timestamps.end_time_seconds)) {
      copy.timestamps.end_time_seconds = copy.timestamps.end_time_seconds.map((s) => s + offsetSeconds);
    }
  }

  return copy;
}

/**
 * Merges N already offset-adjusted chunk transcript JSONs (in chunk order)
 * into one combined result object shaped exactly like a normal single-file
 * Sarvam result — same top-level keys formatTranscript() already knows how
 * to read, so nothing downstream needs to change.
 *
 * @param {object[]} chunkResults - in chunk order, already run through offsetTimestamps()
 * @returns {object}
 */
function mergeChunkResults(chunkResults) {
  const withLanguage = chunkResults.find((r) => r.language_code);
  const merged = {
    language_code: withLanguage ? withLanguage.language_code : null,
    diarized_transcript: { entries: [] },
    timestamps: { chunks: [], start_time_seconds: [], end_time_seconds: [] },
    transcript: '',
  };

  const transcriptParts = [];
  let hasAnyDiarized = false;
  let hasAnyTimestampChunks = false;

  for (const result of chunkResults) {
    if (result.diarized_transcript && Array.isArray(result.diarized_transcript.entries)) {
      hasAnyDiarized = true;
      merged.diarized_transcript.entries.push(...result.diarized_transcript.entries);
    }
    if (result.timestamps && Array.isArray(result.timestamps.chunks)) {
      hasAnyTimestampChunks = true;
      merged.timestamps.chunks.push(...result.timestamps.chunks);
      merged.timestamps.start_time_seconds.push(...(result.timestamps.start_time_seconds || []));
      merged.timestamps.end_time_seconds.push(...(result.timestamps.end_time_seconds || []));
    }
    if (result.transcript) transcriptParts.push(result.transcript);
  }

  // Only include these keys if at least one chunk actually had them —
  // mirrors what a real single-file Sarvam result looks like (formatTranscript()
  // already handles either shape being absent).
  if (!hasAnyDiarized) delete merged.diarized_transcript;
  if (!hasAnyTimestampChunks) delete merged.timestamps;
  merged.transcript = transcriptParts.join(' ');

  return merged;
}

/**
 * Attempts to merge one manifest's chunks for one mode.
 *
 * @param {object} manifest
 * @param {'codemix'|'translate'} mode
 * @returns {'merged'|'skipped-done'|'waiting'}
 */
function mergeOneManifestMode(manifest, mode) {
  const { originalBaseName, group, effectiveSessionId, chunks } = manifest;
  const modeDir = transcriptsModeDir(group, effectiveSessionId, mode);
  ensureDir(modeDir);

  const mergedJsonPath = path.join(modeDir, `${originalBaseName}.json`);
  const mergedTxtPath = path.join(modeDir, `${originalBaseName}_${mode}.txt`);

  // ── Resume: already merged ──────────────────────────────────────────────
  if (fs.existsSync(mergedJsonPath)) {
    return 'skipped-done';
  }

  const orderedChunks = chunks.slice().sort((a, b) => a.index - b.index);
  const chunkResults = [];

  for (const chunk of orderedChunks) {
    const chunkBaseName = path.basename(chunk.file, path.extname(chunk.file));
    const chunkJsonPath = path.join(modeDir, `${chunkBaseName}.json`);
    if (!fs.existsSync(chunkJsonPath)) {
      logger.info(
        `  [merge-chunks] Waiting on chunk ${chunk.index}/${chunk.total} (${mode}) for ` +
        `"${originalBaseName}" — ${chunkBaseName}.json not transcribed yet.`
      );
      return 'waiting';
    }
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(chunkJsonPath, 'utf8'));
    } catch (err) {
      logger.error(
        `  [merge-chunks] ✗  Could not parse ${chunkBaseName}.json for "${originalBaseName}" (${err.message}) — ` +
        `treating as not ready; re-run after the chunk is re-transcribed.`
      );
      return 'waiting';
    }
    chunkResults.push(offsetTimestamps(raw, chunk.startOffsetSeconds));
  }

  const merged = mergeChunkResults(chunkResults);
  fs.writeFileSync(mergedJsonPath, JSON.stringify(merged, null, 2), 'utf8');

  const formatted = formatTranscript(merged, `${originalBaseName}.mp3`, mode);
  fs.writeFileSync(mergedTxtPath, formatted, 'utf8');

  logger.info(`  [merge-chunks] ✓ Merged ${orderedChunks.length} chunk(s) → ${originalBaseName}_${mode}.txt`);
  return 'merged';
}

async function main() {
  logger.info('============================================================');
  logger.info(' Merge Chunks — stitching split recordings back into one transcript');
  logger.info('============================================================');

  const manifests = listAllChunkManifests(AUDIO_DIR);

  if (manifests.length === 0) {
    logger.info('[merge-chunks] No chunked recordings found. Nothing to do.\n');
    return;
  }

  logger.info(`[merge-chunks] ${manifests.length} chunked recording(s) found.\n`);

  let mergedCount = 0;
  let waitingCount = 0;
  let skippedCount = 0;

  for (const manifest of manifests) {
    logger.info(`── ${manifest.originalBaseName} (${manifest.chunks.length} chunk(s)) ──`);
    for (const mode of MODES) {
      const result = mergeOneManifestMode(manifest, mode);
      if (result === 'merged') mergedCount++;
      if (result === 'waiting') waitingCount++;
      if (result === 'skipped-done') skippedCount++;
    }
  }

  logger.info('\n============================================================');
  logger.info(
    ` Done. ${mergedCount} merged, ${skippedCount} already up to date` +
    (waitingCount > 0
      ? `, ${waitingCount} still waiting on chunk transcription — re-run after transcribe finishes.`
      : '.')
  );
  logger.info('============================================================\n');
}

module.exports = { main, mergeOneManifestMode, mergeChunkResults, offsetTimestamps };

if (require.main === module) {
  main().catch((err) => {
    logger.error('\n[fatal error]', err.message || err);
    process.exit(1);
  });
}

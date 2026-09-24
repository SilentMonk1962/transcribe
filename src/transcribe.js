'use strict';
const logger = require('./lib/logger');

/**
 * transcribe.js — Stage 2: audio → English transcript JSON (Sarvam, translate
 * mode, speaker diarization).
 *
 * Per audio file (flat audio/*.mp3 and chunk parts under audio/_chunks/):
 *   - skipped if the recording's final contextual transcript exists, or its
 *     transcript JSON is already on disk (resume — nothing is billed twice)
 *   - otherwise one Sarvam job, output to
 *     output/<group>/<session>/transcripts/translate/<name>.json
 *
 * Then, for each chunked recording whose parts are ALL transcribed, the
 * parts are merged into one <name>.json with timestamps shifted onto one
 * continuous timeline. Note: speaker numbers are not reconciled across
 * chunks (each part is diarized on its own).
 *
 * Credits: keys rotate on exhaustion; when all are spent the run exits with
 * code 2 (lib/credit.js). A non-credit failure skips only that file.
 *
 * Usage: node src/transcribe.js
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { config, ensureDir } = require('./lib/config');
const { resolveSession, translateDir, contextualTranscriptPath } = require('./lib/sessions');
const { listAllChunkManifests, chunkAudioPaths } = require('./lib/chunking');
const { SarvamKeyPool } = require('./lib/sarvam-keys');
const { isCreditError, withSarvamKeyRetry } = require('./lib/credit');

/**
 * Builds the work list. Chunk parts carry their manifest's session; flat
 * files resolve theirs (already persisted by convert.js).
 *
 * @param {string} audioDir
 * @returns {Promise<Array<{audioPath: string, baseName: string, recording: string, session: object}>>}
 */
async function listAudioItems(audioDir) {
  const items = [];
  if (!fs.existsSync(audioDir)) return items;

  for (const f of fs.readdirSync(audioDir).filter((n) => n.toLowerCase().endsWith('.mp3')).sort()) {
    const baseName = path.basename(f, path.extname(f));
    items.push({ audioPath: path.join(audioDir, f), baseName, recording: baseName, session: await resolveSession(baseName) });
  }
  for (const m of listAllChunkManifests(audioDir)) {
    const session = { group: m.group, sessionId: m.sessionId, effectiveSessionId: m.effectiveSessionId };
    for (const audioPath of chunkAudioPaths(m, audioDir)) {
      items.push({ audioPath, baseName: path.basename(audioPath, '.mp3'), recording: m.originalBaseName, session });
    }
  }
  return items;
}

/**
 * Runs one Sarvam job for one audio file and saves its JSON.
 * Throws an `.isCreditError` error on billing failure (caller rotates keys).
 *
 * @returns {Promise<'done'|'failed'>}
 */
async function transcribeOne(client, audioPath, outJson, label) {
  try {
    const job = await client.speechToTextJob.createJob({
      model: config.sarvamModel(),
      mode: 'translate',
      withDiarization: true,
      numSpeakers: config.numSpeakers(),
    });
    await job.uploadFiles([audioPath]);
    await job.start();
    logger.info(`  [transcribe] Processing ${label} (may take several minutes)…`);
    await job.waitUntilComplete();

    const results = await job.getFileResults();
    if (results.failed?.length > 0) {
      const msg = results.failed[0].error_message || 'Unknown error';
      if (isCreditError(msg)) throw Object.assign(new Error(msg), { isCreditError: true });
      logger.error(`  [transcribe] ✗ Sarvam rejected ${label}: ${msg}`);
      return 'failed';
    }

    // The SDK names the downloaded file itself — download to a temp dir, take the JSON.
    const tmp = `${outJson}.tmpdir`;
    ensureDir(tmp);
    try {
      await job.downloadOutputs(tmp);
      const json = fs.readdirSync(tmp).find((f) => f.endsWith('.json'));
      if (!json) throw new Error('Sarvam returned no JSON output');
      JSON.parse(fs.readFileSync(path.join(tmp, json), 'utf8')); // corrupt output must not look "done"
      fs.renameSync(path.join(tmp, json), outJson);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    logger.info(`  [transcribe] ✓ ${label}`);
    return 'done';
  } catch (err) {
    if (err.isCreditError || isCreditError(err.message) || isCreditError(String(err.status))) {
      err.isCreditError = true;
      throw err;
    }
    logger.error(`  [transcribe] ✗ ${label}: ${err.message}`);
    return 'failed';
  }
}

// ─── Chunk merge ──────────────────────────────────────────────────────────────

/** Shifts every timestamp in a chunk result by the chunk's start offset. */
function offsetTimestamps(result, offset) {
  const copy = JSON.parse(JSON.stringify(result));
  for (const e of copy.diarized_transcript?.entries || []) {
    if (e.start_time_seconds != null) e.start_time_seconds += offset;
    if (e.end_time_seconds != null) e.end_time_seconds += offset;
  }
  if (copy.timestamps) {
    copy.timestamps.start_time_seconds = (copy.timestamps.start_time_seconds || []).map((s) => s + offset);
    copy.timestamps.end_time_seconds = (copy.timestamps.end_time_seconds || []).map((s) => s + offset);
  }
  return copy;
}

/** Combines offset chunk results into one Sarvam-shaped result. */
function mergeChunkResults(results) {
  const merged = {
    language_code: results.find((r) => r.language_code)?.language_code || null,
    transcript: results.map((r) => r.transcript).filter(Boolean).join(' '),
  };
  const entries = results.flatMap((r) => r.diarized_transcript?.entries || []);
  if (entries.length) merged.diarized_transcript = { entries };
  const ts = results.filter((r) => Array.isArray(r.timestamps?.chunks));
  if (ts.length) {
    merged.timestamps = {
      chunks: ts.flatMap((r) => r.timestamps.chunks),
      start_time_seconds: ts.flatMap((r) => r.timestamps.start_time_seconds),
      end_time_seconds: ts.flatMap((r) => r.timestamps.end_time_seconds),
    };
  }
  return merged;
}

/**
 * Merges one chunked recording once every part is transcribed.
 * @returns {'merged'|'done'|'waiting'}
 */
function mergeManifest(m) {
  const dir = translateDir(m.group, m.effectiveSessionId);
  const outJson = path.join(dir, `${m.originalBaseName}.json`);
  if (fs.existsSync(outJson) || fs.existsSync(contextualTranscriptPath(m.group, m.effectiveSessionId, m.originalBaseName))) {
    return 'done';
  }

  const results = [];
  for (const c of m.chunks.slice().sort((a, b) => a.index - b.index)) {
    const partJson = path.join(dir, `${path.basename(c.file, '.mp3')}.json`);
    try {
      results.push(offsetTimestamps(JSON.parse(fs.readFileSync(partJson, 'utf8')), c.startOffsetSeconds));
    } catch {
      return 'waiting'; // part missing or unreadable — next run picks it up
    }
  }
  fs.writeFileSync(outJson, JSON.stringify(mergeChunkResults(results), null, 2), 'utf8');
  logger.info(`  [transcribe] ✓ Merged ${results.length} chunk(s) → ${m.originalBaseName}`);
  return 'merged';
}

// ─── Stage entry point ────────────────────────────────────────────────────────

/**
 * @returns {Promise<{done: number, skipped: number, failed: number, waiting: number}>}
 */
async function run() {
  const audioDir = config.audioDir();
  const items = await listAudioItems(audioDir);
  const tally = { done: 0, skipped: 0, failed: 0, waiting: 0 };

  // Work out what still needs Sarvam before touching the key pool.
  const todo = items.filter(({ baseName, recording, session }) => {
    const dir = translateDir(session.group, session.effectiveSessionId);
    const finished = fs.existsSync(contextualTranscriptPath(session.group, session.effectiveSessionId, recording))
      || fs.existsSync(path.join(dir, `${recording}.json`))   // merged / single transcript exists
      || fs.existsSync(path.join(dir, `${baseName}.json`));   // this chunk part exists
    if (finished) tally.skipped++;
    return !finished;
  });

  if (todo.length > 0) {
    const pool = new SarvamKeyPool();
    if (pool.total === 0) throw new Error('No Sarvam keys found. Set SARVAM_API_KEYS in .env.');
    logger.info(`[transcribe] ${todo.length} file(s) to transcribe · ${pool.total} key(s) in pool.`);

    for (const { audioPath, baseName, session } of todo) {
      const dir = translateDir(session.group, session.effectiveSessionId);
      ensureDir(dir);
      const label = `${session.group}/${session.effectiveSessionId}/${baseName}`;
      const outcome = await withSarvamKeyRetry(pool, label, (client) =>
        transcribeOne(client, audioPath, path.join(dir, `${baseName}.json`), label));
      tally[outcome]++;
    }
  }

  for (const m of listAllChunkManifests(audioDir)) {
    if (mergeManifest(m) === 'waiting') tally.waiting++;
  }

  logger.info(`[transcribe] ${tally.done} transcribed, ${tally.skipped} skipped` +
    (tally.failed ? `, ${tally.failed} failed (retried next run)` : '') +
    (tally.waiting ? `, ${tally.waiting} chunked recording(s) waiting on parts` : '') + '.');
  return tally;
}

module.exports = { run, mergeChunkResults, offsetTimestamps };

if (require.main === module) {
  run().catch((err) => {
    logger.error('\n[fatal error]', err.message || err);
    process.exit(1);
  });
}

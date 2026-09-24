'use strict';
const logger = require('./lib/logger');

/**
 * context-scan.js — Stage 4 of the pipeline (see src/pipeline.js).
 *
 * Reads each finished English transcript (TEXT ONLY — no images yet) and asks
 * OpenAI which lines only make full sense if you could SEE the screen at that
 * moment: deictic references ("this button", "here", "that colour", "the
 * second tab"), unnamed on-screen errors, layout/spacing complaints, etc.
 *
 * Example:
 *   Line  L42 [12:04 → 12:11] Speaker 2: "This button looks off here."
 *   Model → { line: 42, timestampSeconds: 727, whatToLookFor: "the button
 *             Speaker 2 calls 'off' — its label, colour and position" }
 *
 * Stage 5 (frame-capture.js) grabs exactly those timestamps from the source
 * video; Stage 6 (frame-describe.js) describes each frame; Stage 7
 * (context-inject.js) writes the description under line 42.
 *
 * BATCHING: long transcripts are sent in fixed windows of
 * CONTEXT_SCAN_BATCH_LINES lines (default 150) so no call ever approaches the
 * model's input limit. Line numbers are GLOBAL (transcriptEntries() index),
 * so batches never collide.
 *
 * HALLUCINATION GUARDS (every model answer is validated, never trusted):
 *   - a line number outside the current batch is dropped
 *   - a timestamp outside that line's own [start, end] is clamped to the
 *     line's midpoint
 *   - an empty "whatToLookFor" is dropped
 *   - duplicate (line, second) pairs are collapsed
 *   A malformed response for a batch → the recording is NOT marked done, so
 *   the next run retries it.
 *
 * RESUME: a recording is skipped if _work/<name>/scan.json already exists, or
 * if its final <name>-contextual.txt exists.
 *
 * CREDIT SAFETY: an OpenAI quota/billing error stops the run with exit code 2
 * (see lib/credit-runner.js); recordings already scanned stay done.
 *
 * Output: output/<group>/<session-id>/_work/<name>/scan.json
 *
 * Usage:
 *   node src/context-scan.js
 */

require('dotenv').config();

const OpenAI = require('openai');
const fs = require('fs');
const { config } = require('./lib/config');
const {
  ensureDir,
  workDir,
  scanPath,
  contextualTranscriptPath,
  listTranslatedRecordings,
} = require('./lib/session-paths');
const { transcriptEntries } = require('./lib/transcript-format');
const { formatTime } = require('./lib/format');
const { toCreditErrorOrNull } = require('./lib/credit-errors');
const { exitOnCreditExhaustion } = require('./lib/credit-runner');

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = config.openaiModel();
const BATCH_LINES = config.contextScanBatchLines();

const SYSTEM_PROMPT = `You review transcripts of screen-shared product/UX meetings about a fintech application. Speakers are looking at the application on screen while they talk.

Your job: find the transcript lines that CANNOT be fully understood from the words alone, because the speaker is referring to something visible on screen. Typical signals:
- deictic references: "this", "that", "here", "there", "this one", "the one on the left"
- an on-screen element that is referred to but not named (a button, field, tab, banner, modal, table, chart)
- visual properties that are judged but not stated: colour, spacing, alignment, size, overlap, cut-off text
- an error or message on screen that is mentioned but not read out word for word

Do NOT pick a line when:
- the words already say exactly what is on screen
- the reference is to something not on screen (a past meeting, a document, a person)
- it is small talk, audio checks, or scheduling

Choose as many lines as are genuinely needed, including zero. Accuracy over recall.

Respond ONLY with a JSON object of this exact shape:
{"requests":[{"line":<int>,"timestampSeconds":<int>,"whatToLookFor":"<one sentence naming exactly what to identify on screen>"}]}

"line" is the L-number shown. "timestampSeconds" is a whole second inside that line's [start → end] range where the thing is most likely visible. Use {"requests":[]} when nothing qualifies.`;

/**
 * Renders one batch of lines for the prompt, e.g.
 *   L42 [12:04 → 12:11] Speaker 2: This button looks off here.
 *
 * @param {Array<{index: number, entry: object}>} batch
 * @returns {string}
 */
function renderBatch(batch) {
  return batch.map(({ index, entry }) => {
    const timing = `[${formatTime(entry.start)} → ${formatTime(entry.end)}]`;
    const speaker = entry.speaker ? ` ${entry.speaker}:` : '';
    return `L${index} ${timing}${speaker} ${entry.text}`;
  }).join('\n');
}

/**
 * Validates and normalizes the model's raw requests for one batch (see the
 * HALLUCINATION GUARDS in the file header).
 *
 * @param {Array} raw - model-returned requests
 * @param {Map<number, object>} byIndex - this batch's entries, keyed by global index
 * @returns {Array<{line: number, timestampSeconds: number, whatToLookFor: string}>}
 */
function sanitizeRequests(raw, byIndex) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(raw) ? raw : []) {
    const line = Number.parseInt(r?.line, 10);
    const entry = byIndex.get(line);
    const what = typeof r?.whatToLookFor === 'string' ? r.whatToLookFor.trim() : '';
    if (!entry || !what) continue;

    // Keep the timestamp inside the line it belongs to; otherwise use the midpoint.
    let ts = Math.round(Number(r?.timestampSeconds));
    if (!Number.isFinite(ts) || ts < Math.floor(entry.start) || ts > Math.ceil(entry.end)) {
      ts = Math.round((entry.start + entry.end) / 2);
    }

    const key = `${line}:${ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ line, timestampSeconds: ts, whatToLookFor: what });
  }
  return out;
}

/**
 * Sends one batch to OpenAI and returns its sanitized requests.
 * Throws on a malformed response so the recording is retried next run.
 *
 * @param {OpenAI} client
 * @param {Array<{index: number, entry: object}>} batch
 * @returns {Promise<Array<{line: number, timestampSeconds: number, whatToLookFor: string}>>}
 */
async function scanBatch(client, batch) {
  const response = await client.chat.completions.create({
    model: OPENAI_MODEL,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: renderBatch(batch) },
    ],
  });

  const content = response.choices[0]?.message?.content || '';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`model returned invalid JSON (${err.message})`);
  }
  return sanitizeRequests(parsed.requests, new Map(batch.map((b) => [b.index, b.entry])));
}

/**
 * Scans one recording end-to-end and writes scan.json.
 *
 * @param {OpenAI} client
 * @param {{group: string, sessionId: string, baseName: string, jsonPath: string}} rec
 * @param {string} progress - "[1/4]"
 * @returns {Promise<'skipped'|'scanned'|'failed'>}
 */
async function processOneRecording(client, rec, progress) {
  const { group, sessionId, baseName, jsonPath } = rec;
  const label = `${group}/${sessionId}/${baseName}`;
  const outPath = scanPath(group, sessionId, baseName);

  // ── Resume ────────────────────────────────────────────────────────────────
  if (fs.existsSync(contextualTranscriptPath(group, sessionId, baseName)) || fs.existsSync(outPath)) {
    logger.info(`  ${progress} ⏭  Already scanned: ${label}`);
    return 'skipped';
  }

  let result;
  try {
    result = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    logger.error(`  ${progress} ✗  Could not read transcript JSON for ${label}: ${err.message}`);
    return 'failed';
  }

  // Only timed lines can be matched to a video frame.
  const timed = transcriptEntries(result)
    .map((entry, index) => ({ index, entry }))
    .filter(({ entry }) => entry.start != null && entry.end != null);

  const requests = [];
  if (timed.length > 0) {
    const batches = Math.ceil(timed.length / BATCH_LINES);
    logger.info(`  ${progress} 🔎 Scanning ${timed.length} line(s) in ${batches} batch(es): ${label}`);
    for (let b = 0; b < batches; b++) {
      const batch = timed.slice(b * BATCH_LINES, (b + 1) * BATCH_LINES);
      try {
        requests.push(...await scanBatch(client, batch));
      } catch (err) {
        const creditErr = toCreditErrorOrNull(err);
        if (creditErr) {
          creditErr.currentItem = label;
          throw creditErr;
        }
        // Not marked done → retried on the next run.
        logger.error(`  ${progress} ✗  Batch ${b + 1}/${batches} failed for ${label}: ${err.message}`);
        return 'failed';
      }
    }
  } else {
    logger.warn(`  ${progress} ⚠  No timed lines in ${label} — screen context not possible.`);
  }

  ensureDir(workDir(group, sessionId, baseName));
  fs.writeFileSync(outPath, JSON.stringify({
    recordingBaseName: baseName,
    model: OPENAI_MODEL,
    scannedAt: new Date().toISOString(),
    requests,
  }, null, 2), 'utf8');

  logger.info(`  ${progress} ✓  ${requests.length} line(s) need screen context: ${label}`);
  return 'scanned';
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  logger.info('============================================================');
  logger.info(' Stage 4 — Context Scan (which lines need the screen?)');
  logger.info('============================================================');

  if (!OPENAI_KEY) {
    logger.error('[error] OPENAI_API_KEY is not set in .env');
    logger.error('  Add your key from https://platform.openai.com/');
    process.exit(1);
  }

  const recordings = listTranslatedRecordings();
  if (recordings.length === 0) {
    logger.info('[info] No English transcripts waiting. Nothing to do.\n');
    return;
  }

  logger.info(`[info] Model       : ${OPENAI_MODEL}`);
  logger.info(`[info] Batch size  : ${BATCH_LINES} line(s)`);
  logger.info(`[info] Recordings  : ${recordings.length}\n`);

  const client = new OpenAI({ apiKey: OPENAI_KEY });
  const tally = { skipped: 0, scanned: 0, failed: 0 };

  for (let i = 0; i < recordings.length; i++) {
    try {
      const outcome = await processOneRecording(client, recordings[i], `[${i + 1}/${recordings.length}]`);
      tally[outcome]++;
    } catch (err) {
      exitOnCreditExhaustion(err, {
        serviceLabel: 'OpenAI',
        topUpUrl: 'https://platform.openai.com/account/billing',
        resumeCmd: 'npm run context-scan',
        currentItem: err.currentItem || recordings[i].baseName,
        doneCount: tally.scanned + tally.skipped,
        totalCount: recordings.length,
      });
      throw err;
    }
  }

  logger.info('\n============================================================');
  logger.info(` Done. ${tally.scanned} scanned, ${tally.skipped} already done` +
    (tally.failed > 0 ? `, ${tally.failed} failed (retried next run)` : '') + '.');
  logger.info('============================================================\n');
}

module.exports = { main, processOneRecording, sanitizeRequests, renderBatch };

if (require.main === module) {
  main().catch((err) => {
    logger.error('\n[fatal error]', err.message || err);
    process.exit(1);
  });
}

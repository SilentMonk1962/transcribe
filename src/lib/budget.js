'use strict';
const logger = require('./logger');

/**
 * budget.js — pre-run spend estimate + y/N consent, over ONLY the work that
 * is still pending (see status.js). Finished recordings cost ₹0 and are just
 * listed.
 *
 * Example (one new 60-min recording, defaults):
 *   Sarvam  60 min × ₹45/hr                  ≈ ₹45
 *   OpenAI  scan ~13k tokens + 10 frames     ≈ ₹0.5
 *   Total                                    ≈ ₹45.5
 *
 * Rates in .env: SARVAM_PRICE_PER_HOUR_INR, USD_INR_RATE,
 * OPENAI_PRICE_INPUT_PER_M, OPENAI_PRICE_OUTPUT_PER_M (USD per 1M tokens),
 * OPENAI_ASSUMED_FRAMES_PER_SESSION (frames can't be known before the scan).
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { config } = require('./config');
const { getAudioDurationSeconds } = require('./chunking');
const { transcriptEntries } = require('./transcript-format');

function num(env, fallback) {
  const n = parseFloat(process.env[env]);
  return Number.isFinite(n) ? n : fallback;
}

// Fixed heuristics — rough by design.
const SPOKEN_TOKENS_PER_MIN = 180;
const SCAN_LINES_PER_MIN = 4;
const SCAN_OVERHEAD_TOKENS_PER_BATCH = 1200;
const SCAN_OUTPUT_TOKENS = 500;
const FRAME_INPUT_TOKENS = 650;
const FRAME_OUTPUT_TOKENS = 100;

/** Minutes of audio: ffprobe for a video, last timestamp for a transcript. */
async function minutesOf(item) {
  if (item.state === 'new') {
    try {
      return (await getAudioDurationSeconds(item.videoPath)) / 60;
    } catch (err) {
      logger.warn(`[budget] Could not probe ${path.basename(item.videoPath)} (${err.message}) — counted as 0 min.`);
      return 0;
    }
  }
  try {
    const entries = transcriptEntries(JSON.parse(fs.readFileSync(item.jsonPath, 'utf8')));
    return Math.max(0, ...entries.map((e) => e.end || 0)) / 60;
  } catch {
    return 0;
  }
}

/**
 * @param {Array<object>} items - status.snapshot() rows that will be worked on
 *   ('new', or 'transcribed' with a video; video-less rows cost nothing)
 * @returns {Promise<object>}
 */
async function estimateCost(items) {
  const r = {
    sarvamInrPerHour: num('SARVAM_PRICE_PER_HOUR_INR', 45),
    usdInr: num('USD_INR_RATE', 95.4),
    inPerM: num('OPENAI_PRICE_INPUT_PER_M', 0.20),
    outPerM: num('OPENAI_PRICE_OUTPUT_PER_M', 1.20),
    frames: num('OPENAI_ASSUMED_FRAMES_PER_SESSION', 10),
  };
  const openaiUsd = (inTok, outTok) => (inTok / 1e6) * r.inPerM + (outTok / 1e6) * r.outPerM;

  let sarvamMinutes = 0;
  let openaiUsdTotal = 0;
  let contextCount = 0;
  for (const item of items) {
    const minutes = await minutesOf(item);
    if (item.state === 'new') sarvamMinutes += minutes;
    if (!item.videoPath) continue; // no video → no scan/frames
    contextCount++;
    const batches = Math.max(1, Math.ceil((minutes * SCAN_LINES_PER_MIN) / config.contextScanBatchLines()));
    openaiUsdTotal += openaiUsd(minutes * SPOKEN_TOKENS_PER_MIN + batches * SCAN_OVERHEAD_TOKENS_PER_BATCH, SCAN_OUTPUT_TOKENS);
    openaiUsdTotal += r.frames * openaiUsd(FRAME_INPUT_TOKENS, FRAME_OUTPUT_TOKENS);
  }

  const sarvamInr = (sarvamMinutes / 60) * r.sarvamInrPerHour;
  const openaiInr = openaiUsdTotal * r.usdInr;
  return {
    rates: r,
    sarvamMinutes,
    sarvamInr,
    openaiInr,
    contextCount,
    assumedFrames: contextCount * r.frames,
    totalInr: sarvamInr + openaiInr,
  };
}

const inr = (v) => (v >= 100 ? `₹${Math.round(v)}` : `₹${v.toFixed(1)}`);

/** Human-readable breakdown for the consent prompt. */
function formatEstimate(e, counts) {
  const lines = [
    'ESTIMATED SPEND (pending work only)',
    `Recordings : ${counts.new} new · ${counts.transcribed} transcribed · ${counts.done} already done (₹0)`,
    `Sarvam     : ${e.sarvamMinutes.toFixed(0)} min × ₹${e.rates.sarvamInrPerHour}/hr → ${inr(e.sarvamInr)}`,
    `OpenAI     : ${config.openaiModel()}, ${e.contextCount} recording(s), ~${e.assumedFrames} frame(s) assumed → ${inr(e.openaiInr)}`,
    `TOTAL      : ≈ ${inr(e.totalInr)}`,
  ];
  const w = Math.max(...lines.map((l) => l.length)) + 2;
  return [`╔${'═'.repeat(w)}╗`, ...lines.map((l) => `║ ${l.padEnd(w - 1)}║`), `╚${'═'.repeat(w)}╝`].join('\n');
}

/**
 * y/N question. Non-interactive runs return `fallback` (never a silent yes
 * unless the caller passes one).
 */
function askYesNo(question, fallback = false) {
  if (!process.stdin.isTTY) return Promise.resolve(fallback);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (a) => {
      rl.close();
      resolve(['y', 'yes'].includes(a.trim().toLowerCase()));
    });
  });
}

module.exports = { estimateCost, formatEstimate, askYesNo, inr };

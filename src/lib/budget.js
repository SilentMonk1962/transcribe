'use strict';
const logger = require('./logger');

/**
 * budget.js — pre-run spend estimate + interactive budget consent for the
 * full pipeline (src/pipeline.js). The pipeline only proceeds on an explicit
 * "yes": "This transcription is estimated to cost xyz cents. Would you like
 * me to continue?"
 *
 * WHAT IT ESTIMATES (all rough, deliberately simple):
 *   - Sarvam : billed audio-minutes × ₹45/hr (one English pass per recording).
 *   - OpenAI scan (stage 4, text only): input ≈ spoken tokens per minute of
 *              audio + prompt overhead per batch; output ≈ a small JSON list.
 *   - OpenAI vision (stage 6): how many lines need the screen cannot be known
 *              before the scan runs, so the total uses an ASSUMED number of
 *              frames per session, explicitly labeled as an assumption.
 *
 * Example (one 60-min recording, defaults):
 *   Sarvam  60 min × ₹45/hr                       ≈ ₹45
 *   Scan    ~13.2k in + ~0.5k out tokens          ≈ ₹0.3
 *   Vision  10 assumed frames × ~0.75k tokens     ≈ ₹0.2
 *   Total                                         ≈ ₹45.5
 *
 * ALL RATES AND HEURISTICS are overridable via .env (see .env.example).
 *
 * Non-interactive safety: when stdin is not a TTY, askBudgetConsent()
 * refuses (returns false) instead of defaulting to proceed — an unattended
 * run can never silently spend. pipeline.js treats --yes as the explicit
 * opt-out for automation.
 */

require('dotenv').config();

const path = require('path');
const readline = require('readline');
const { config } = require('./config');
const { getAudioDurationSeconds } = require('./chunking');

// ─── Rates (USD unless noted; per 1M tokens for OpenAI) ───────────────────────
// Every value is overridable via .env; the env names are the ones documented
// in .env.example.

function num(env, fallback) {
  const v = process.env[env];
  const n = parseFloat(v);
  return v != null && Number.isFinite(n) ? n : fallback;
}

const RATES = {
  sarvamInrPerHour: num('SARVAM_PRICE_PER_HOUR_INR', 45),
  usdInr: num('USD_INR_RATE', 95.4),
  openaiInputPerM: num('OPENAI_PRICE_INPUT_PER_M', 0.20),
  openaiOutputPerM: num('OPENAI_PRICE_OUTPUT_PER_M', 1.20),
};

// ─── Estimation heuristics (see file header — rough by design) ───────────────

const HEURISTICS = {
  // Rough speaking pace — tokens of transcript per minute of audio.
  spokenTokensPerMin: num('SPOKEN_TOKENS_PER_MIN', 180),
  // Stage 4 — system prompt + line numbering/timing per batch call.
  scanOverheadTokensPerBatch: num('SCAN_PROMPT_OVERHEAD_TOKENS', 1200),
  // Stage 4 — roughly how many transcript lines one minute of audio yields
  // (used only to estimate the number of batch calls).
  scanLinesPerMin: num('SCAN_LINES_PER_MIN', 4),
  scanOutputTokensPerSession: num('SCAN_OUTPUT_TOKENS_PER_SESSION', 500),
  // Stage 6 — frames can't be known before the scan, so this is an explicit
  // ASSUMPTION, labeled as such in the prompt.
  openaiAssumedFramesPerSession: num('OPENAI_ASSUMED_FRAMES_PER_SESSION', 10),
  openaiImageInputTokens: num('OPENAI_IMAGE_INPUT_TOKENS', 500),
  openaiTextInputTokensPerFrame: num('OPENAI_TEXT_INPUT_TOKENS_PER_FRAME', 150),
  openaiCaptionOutputTokens: num('OPENAI_CAPTION_OUTPUT_TOKENS', 100),
};

/**
 * Probes every input video's duration (ffprobe; works on video files) and
 * computes the estimated spend across all paid services for a full pipeline
 * run over those recordings. Never makes an API call — local math only.
 *
 * @param {string[]} videoPaths - absolute paths to the recordings in input/
 * @returns {Promise<object>} estimate with per-service USD/INR parts, totals,
 *   display strings, and the raw inputs used (for the breakdown printout).
 */
async function estimateCost(videoPaths) {
  let totalSeconds = 0;
  let probed = 0;
  for (const v of videoPaths) {
    try {
      totalSeconds += await getAudioDurationSeconds(v);
      probed++;
    } catch (err) {
      logger.warn(`[budget] Could not probe ${path.basename(v)} (${err.message}) — excluded from estimate.`);
    }
  }

  const sessions = videoPaths.length;
  const totalMinutes = totalSeconds / 60;

  // ── Sarvam: billed audio-minutes × ₹45/hr, converted to USD ────────────────
  const sarvamBilledMinutes = totalMinutes;
  const sarvamInr = (sarvamBilledMinutes / 60) * RATES.sarvamInrPerHour;
  const sarvamUsd = sarvamInr / RATES.usdInr;

  // ── OpenAI scan (stage 4): whole transcript once + per-batch overhead ──────
  const scanBatches = sessions > 0
    ? Math.max(sessions, Math.ceil((totalMinutes * HEURISTICS.scanLinesPerMin) / config.contextScanBatchLines()))
    : 0;
  const scanInputTokens =
    totalMinutes * HEURISTICS.spokenTokensPerMin + scanBatches * HEURISTICS.scanOverheadTokensPerBatch;
  const scanOutputTokens = sessions * HEURISTICS.scanOutputTokensPerSession;
  const scanUsd =
    (scanInputTokens / 1e6) * RATES.openaiInputPerM +
    (scanOutputTokens / 1e6) * RATES.openaiOutputPerM;

  // ── OpenAI vision (stage 6): assumed frames, labeled ───────────────────────
  const openaiFrames = sessions * HEURISTICS.openaiAssumedFramesPerSession;
  const visionInputTokensPerFrame =
    HEURISTICS.openaiImageInputTokens + HEURISTICS.openaiTextInputTokensPerFrame;
  const visionUsd =
    openaiFrames * (
      (visionInputTokensPerFrame / 1e6) * RATES.openaiInputPerM +
      (HEURISTICS.openaiCaptionOutputTokens / 1e6) * RATES.openaiOutputPerM
    );

  const totalUsd = sarvamUsd + scanUsd + visionUsd;
  const totalInr = totalUsd * RATES.usdInr;

  return {
    sessions,
    probed,
    totalMinutes,
    sarvamBilledMinutes,
    sarvamInr,
    sarvamUsd,
    scanBatches,
    scanUsd,
    visionUsd,
    openaiFrames,
    totalUsd,
    totalInr,
    displayCents: formatCents(totalUsd),
  };
}

/**
 * Rounds a USD amount to a "N cents" display string (one decimal below 10c).
 * @param {number} usd
 * @returns {string} e.g. "82 cents", "0.4 cents"
 */
function formatCents(usd) {
  const cents = usd * 100;
  if (cents >= 10) return `${Math.round(cents)} cents`;
  return `${cents.toFixed(1)} cents`;
}

function formatInr(inr) {
  return inr >= 100 ? `₹${Math.round(inr)}` : `₹${inr.toFixed(1)}`;
}

/**
 * Renders the human-readable breakdown shown before the consent prompt.
 * @param {object} e - result of estimateCost()
 * @returns {string}
 */
function formatEstimate(e) {
  const openaiModel = config.openaiModel();
  const toInr = (usd) => formatInr(usd * RATES.usdInr);
  const content = [
    '  ESTIMATED SPEND FOR THIS RUN (rough estimate)  ',
    '─────────────────────────────────────────────────',
    `  Recordings : ${e.sessions}  ·  Audio: ${e.totalMinutes.toFixed(0)} min total (${e.probed}/${e.sessions} probed)`,
    '─────────────────────────────────────────────────',
    `  Sarvam saaras:v3  ₹${RATES.sarvamInrPerHour}/hour  (English pass only)`,
    `    × ${e.sarvamBilledMinutes.toFixed(0)} billed audio-min → ${formatInr(e.sarvamInr)} (≈ $${e.sarvamUsd.toFixed(2)})`,
    `  OpenAI ${openaiModel}  $${RATES.openaiInputPerM}/M in + $${RATES.openaiOutputPerM}/M out`,
    `    Context scan  : ≈ ${toInr(e.scanUsd)}  (${e.scanBatches} batch call(s), text only)`,
    `    Screen frames : ≈ ${toInr(e.visionUsd)}  (assumed ${e.openaiFrames} frame(s))`,
    '─────────────────────────────────────────────────',
    `  ESTIMATED TOTAL : ~${e.displayCents}  (≈ ${formatInr(e.totalInr)})`,
    '  Resume logic skips already-completed recordings,',
    '  so actual spend is usually LOWER than this.',
  ];
  const width = Math.max(...content.map((l) => l.length)) + 2;
  const pad = (l) => `║${l.padEnd(width)}║`;
  const rule = `╠${'═'.repeat(width)}╣`;
  const top = `╔${'═'.repeat(width)}╗`;
  const bottom = `╚${'═'.repeat(width)}╝`;
  return [top, ...content.map(pad), bottom].join('\n');
}

/**
 * Keyed budget consent. Returns true ONLY on an explicit 'y'/'yes'.
 * Non-interactive (stdin not a TTY): refuses and explains --yes, so an
 * unattended run can never silently spend.
 *
 * @param {string} promptText - the final question, e.g. "…cost ~82 cents. Would you like me to continue?"
 * @returns {Promise<boolean>}
 */
function askBudgetConsent(promptText) {
  if (!process.stdin.isTTY) {
    logger.info('\n[budget] Non-interactive run (stdin is not a TTY). Pass --yes to run without a budget prompt.');
    return Promise.resolve(false);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${promptText} [y/N] `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === 'y' || a === 'yes');
    });
  });
}

module.exports = { RATES, HEURISTICS, estimateCost, formatEstimate, formatCents, askBudgetConsent };

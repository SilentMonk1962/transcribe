'use strict';
const logger = require('./logger');

/**
 * budget.js — pre-run spend estimate + interactive budget consent for the
 * full pipeline (src/pipeline.js). Built 2026-08-06 per explicit user request:
 * "take a keyed consent on the CLI from the user about the budget… mention
 * Sarvam saaras v3 at ₹45/hour, DeepSeek v4 Pro pricing, and OpenAI Luna
 * pricing, then ask: 'This transcription is estimated to cost xyz cents.
 * Would you like me to continue?' — only run the pipeline if the user says yes."
 *
 * WHAT IT ESTIMATES (all rough, deliberately simple):
 *   - Sarvam  : audio-minutes actually billed. Depends on WHICH passes run —
 *               translationModes() from lib/modes.js is the single source of
 *               truth, so the estimate can never disagree with what
 *               transcribe.js will actually do. Translate-only (the default)
 *               bills 1× audio; the optional codemix pass bills 2×.
 *   - DeepSeek: token-based, 3 calls per session (Stage 2a index + 2b draft +
 *               2.5 verify) — input ≈ spoken tokens per minute of audio plus
 *               prompt overhead, output ≈ notes/structured data length.
 *   - OpenAI  : captioning only runs if Stage 2 raises vision flags, which
 *               cannot be known before notes exist. So the total includes an
 *               ASSUMED number of flagged frames per session, explicitly
 *               labeled as an assumption. Per-frame cost is tiny.
 *
 * ALL RATES AND HEURISTICS are overridable via .env (see .env.example) so a
 * provider price change never needs a code change.
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
const { translationModes } = require('./modes');

// ─── Rates (USD unless noted; per 1M tokens for the LLMs) ─────────────────────
// Aug-2026 list prices — sources cross-checked in HANDOVER.md (§ Budget
// consent). Every value is overridable via .env; the env names are the ones
// documented in .env.example.

function num(env, fallback) {
  const v = process.env[env];
  const n = parseFloat(v);
  return v != null && Number.isFinite(n) ? n : fallback;
}

const RATES = {
  sarvamInrPerHour: num('SARVAM_PRICE_PER_HOUR_INR', 45),
  usdInr: num('USD_INR_RATE', 95.4),
  deepseekInputPerM: num('DEEPSEEK_PRICE_INPUT_PER_M', 0.435),
  deepseekOutputPerM: num('DEEPSEEK_PRICE_OUTPUT_PER_M', 0.87),
  openaiInputPerM: num('OPENAI_PRICE_INPUT_PER_M', 0.20),
  openaiOutputPerM: num('OPENAI_PRICE_OUTPUT_PER_M', 1.20),
};

// ─── Estimation heuristics (see file header — rough by design) ───────────────

const HEURISTICS = {
  // Rough speaking pace — ~180 words per minute of audio. The transcript
  // feeding DeepSeek is dense Hindi-English, so this is a floor, not exact.
  spokenTokensPerMin: num('SPOKEN_TOKENS_PER_MIN', 180),
  // Index + draft + verification passes (Stage 2a/2b/2.5) — see HANDOVER.md
  // § Hallucination resilience. Was 1 call before that build; update this if
  // the per-session call count ever changes again.
  deepseekCallsPerSession: num('DEEPSEEK_CALLS_PER_SESSION', 3),
  deepseekOverheadTokensPerCall: num('DEEPSEEK_PROMPT_OVERHEAD_TOKENS', 1500),
  deepseekOutputTokensPerSession: num('DEEPSEEK_OUTPUT_TOKENS_PER_SESSION', 4000),
  // Vision flags can't be known before notes exist, so this is an explicit
  // ASSUMPTION: 2 flagged frames per session, labeled as such in the prompt.
  openaiAssumedFramesPerSession: num('OPENAI_ASSUMED_FRAMES_PER_SESSION', 2),
  openaiImageInputTokens: num('OPENAI_IMAGE_INPUT_TOKENS', 500),
  openaiTextInputTokensPerFrame: num('OPENAI_TEXT_INPUT_TOKENS_PER_FRAME', 50),
  openaiCaptionOutputTokens: num('OPENAI_CAPTION_OUTPUT_TOKENS', 150),
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
  const modes = translationModes();
  const passes = modes.length;

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
  const avgMinutes = sessions > 0 ? totalMinutes / sessions : 0;

  // ── Sarvam: billed audio-minutes × ₹45/hr, converted to USD ────────────────
  const sarvamBilledMinutes = totalMinutes * passes;
  const sarvamInr = (sarvamBilledMinutes / 60) * RATES.sarvamInrPerHour;
  const sarvamUsd = sarvamInr / RATES.usdInr;

  // ── DeepSeek: 3 calls/session, input ≈ transcript + overhead ───────────────
  const transcriptTokensPerSession = avgMinutes * HEURISTICS.spokenTokensPerMin;
  const deepseekInputTokensPerSession =
    HEURISTICS.deepseekCallsPerSession *
    (transcriptTokensPerSession + HEURISTICS.deepseekOverheadTokensPerCall);
  const deepseekUsd =
    sessions * (
      (deepseekInputTokensPerSession / 1e6) * RATES.deepseekInputPerM +
      (HEURISTICS.deepseekOutputTokensPerSession / 1e6) * RATES.deepseekOutputPerM
    );

  // ── OpenAI Luna: only if vision flags fire — assumed frames, labeled ───────
  const openaiFrames = sessions * HEURISTICS.openaiAssumedFramesPerSession;
  const openaiInputTokensPerFrame =
    HEURISTICS.openaiImageInputTokens + HEURISTICS.openaiTextInputTokensPerFrame;
  const openaiUsd =
    openaiFrames * (
      (openaiInputTokensPerFrame / 1e6) * RATES.openaiInputPerM +
      (HEURISTICS.openaiCaptionOutputTokens / 1e6) * RATES.openaiOutputPerM
    );

  const totalUsd = sarvamUsd + deepseekUsd + openaiUsd;
  const totalInr = totalUsd * RATES.usdInr;

  return {
    modes,
    passes,
    sessions,
    probed,
    totalMinutes,
    sarvamBilledMinutes,
    sarvamInr,
    sarvamUsd,
    deepseekUsd,
    openaiUsd,
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
  const deepseekModel = config.deepseekModel();
  const openaiModel = config.openaiModel();
  const content = [
    '  ESTIMATED SPEND FOR THIS RUN (rough estimate)  ',
    '─────────────────────────────────────────────────',
    `  Recordings : ${e.sessions}  ·  Audio: ${e.totalMinutes.toFixed(0)} min total (${e.probed}/${e.sessions} probed)`,
    `  Passes     : ${e.passes} (${e.modes.join(' + ')})`,
    '─────────────────────────────────────────────────',
    `  Sarvam saaras:v3  ₹${RATES.sarvamInrPerHour}/hour`,
    `    × ${e.sarvamBilledMinutes.toFixed(0)} billed audio-min → ${formatInr(e.sarvamInr)} (≈ $${e.sarvamUsd.toFixed(2)})`,
    `  DeepSeek ${deepseekModel}`,
    `    $${RATES.deepseekInputPerM}/M in + $${RATES.deepseekOutputPerM}/M out`,
    `    ≈ $${e.deepseekUsd.toFixed(3)}  (3 calls/session: index + draft + verify)`,
    `  OpenAI ${openaiModel}  (only if vision checks fire)`,
    `    $${RATES.openaiInputPerM}/M in + $${RATES.openaiOutputPerM}/M out`,
    `    ≈ $${e.openaiUsd.toFixed(4)}  (assumed ${e.openaiFrames} flagged frame(s))`,
    '─────────────────────────────────────────────────',
    `  ESTIMATED TOTAL : ~${e.displayCents}  (≈ ${formatInr(e.totalInr)})`,
    '  Resume logic skips already-completed sessions,',
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

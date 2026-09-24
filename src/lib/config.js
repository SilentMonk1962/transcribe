'use strict';

/**
 * config.js — single source of truth for environment-driven configuration.
 *
 * WHY THIS EXISTS:
 *   Every stage previously read process.env (and applied its own default) at
 *   module-load time — INPUT_DIR, AUDIO_DIR, OUTPUT_DIR, NUM_SPEAKERS, and the
 *   provider model names each existed in several places. If two stages ever disagreed on a
 *   default, behavior would drift silently. This module centralizes every
 *   knob; all accessors are LAZY (read at call time), so tests or callers can
 *   set process.env between calls and see the new value.
 *
 * ALL DEFAULTS (with the .env.example documentation) live here and nowhere
 * else. Provider model names are overridable via env:
 *   - SARVAM_MODEL      (default 'saaras:v3')
 *   - OPENAI_MODEL      (default 'gpt-5.6-luna')
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function num(name, fallback) {
  const v = process.env[name];
  const n = parseFloat(v);
  return v != null && Number.isFinite(n) ? n : fallback;
}

function int(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
}

function str(name, fallback) {
  const v = (process.env[name] || '').trim();
  return v !== '' ? v : fallback;
}

function resolveDir(name, fallback) {
  return path.resolve(str(name, fallback));
}

const config = {
  /** Directory holding the source recordings to convert. */
  inputDir: () => resolveDir('INPUT_DIR', path.join(PROJECT_ROOT, 'input')),
  /** Directory holding converted (and chunked) audio. */
  audioDir: () => resolveDir('AUDIO_DIR', path.join(PROJECT_ROOT, 'audio')),
  /** Root of the per-session output layout. */
  outputDir: () => resolveDir('OUTPUT_DIR', path.join(PROJECT_ROOT, 'output')),
  /** Catch-all group for recordings not in a folder-derived group. */
  defaultGroup: () => str('DEFAULT_GROUP', 'ungrouped'),
  /** Max expected speakers per recording (Sarvam diarization). */
  numSpeakers: () => int('NUM_SPEAKERS', 8),
  /** Sarvam STT model. */
  sarvamModel: () => str('SARVAM_MODEL', 'saaras:v3'),
  /** OpenAI model for BOTH the text-only context scan (stage 4) and frame description (stage 6). */
  openaiModel: () => str('OPENAI_MODEL', 'gpt-5.6-luna'),
  /** Transcript lines sent per context-scan call (stage 4) — keeps each call well under the input limit. */
  contextScanBatchLines: () => Math.max(1, int('CONTEXT_SCAN_BATCH_LINES', 150)),
};

/**
 * Creates `dir` (and any missing parents) if it doesn't already exist.
 * Shared fs helper (was duplicated across stage files via session-paths).
 * @param {string} dir
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

module.exports = { config, ensureDir, PROJECT_ROOT };

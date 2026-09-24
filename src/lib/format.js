'use strict';

/**
 * format.js — shared formatting utilities used across multiple pipeline stages.
 *
 * Consolidates:
 *   - formatTime()          (was duplicated in transcribe.js, pure-english.js, vision-patch.js)
 *   - formatMMSS()          (meeting-notes.js)
 *   - formatLabel()         (vision-capture.js)
 *   - createDeepSeekClient()(was duplicated in meeting-notes.js, verify-notes.js, vision-patch.js)
 */

const OpenAI = require('openai');

/**
 * Converts a float seconds value to MM:SS string.
 * Example: 125.4 → "02:05"
 *
 * @param {number} seconds
 * @returns {string}
 */
function formatTime(seconds) {
  if (seconds == null) return '??:??';
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/**
 * Converts whole seconds to a filename-safe "HH-MM-SS" label.
 * @param {number} seconds
 * @returns {string}
 */
function formatLabel(seconds) {
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${h}-${m}-${s}`;
}

/**
 * Creates an OpenAI-compatible client pointing at the DeepSeek API.
 *
 * @param {string} apiKey - DeepSeek API key
 * @returns {OpenAI}
 */
function createDeepSeekClient(apiKey) {
  return new OpenAI({
    apiKey,
    baseURL: 'https://api.deepseek.com',
  });
}

module.exports = { formatTime, formatLabel, createDeepSeekClient };

'use strict';

/**
 * format.js — shared formatting utilities used across multiple pipeline stages.
 *
 * Consolidates:
 *   - formatTime()   (transcript timings)
 *   - formatLabel()  (frame filenames — frame-capture.js)
 */

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

module.exports = { formatTime, formatLabel };

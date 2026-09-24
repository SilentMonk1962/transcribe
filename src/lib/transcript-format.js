'use strict';

/**
 * transcript-format.js — single source of truth for rendering Sarvam STT
 * JSON into the human-readable .txt transcript format.
 *
 * WHY THIS EXISTS (2026-08-14 refactor):
 *   transcribe.js and pure-english.js each maintained a near-identical
 *   copy of this function, and they had silently DIVERGED (one used "→",
 *   the other "->"; pure-english dropped the CHUNK TIMESTAMPS section).
 *   Both stages, plus merge-chunks.js (which imports it via transcribe.js),
 *   now share this one implementation.
 *
 * @param {object} result     - Parsed JSON from a Sarvam output file (or a
 *                              merged result from src/merge-chunks.js)
 * @param {string} sourceFile - Original audio filename (for the header)
 * @param {'codemix'|'translate'|'pure-english'} mode
 * @returns {string} formatted text content
 */

const { formatTime } = require('./format');

const MODE_LABELS = {
  codemix: 'Codemix (Hindi + English)',
  translate: 'English Translation',
  'pure-english': 'Pure English Translation',
};

function formatTranscript(result, sourceFile, mode) {
  const lines = [];
  const modeLabel = MODE_LABELS[mode] || mode;

  lines.push('========================================');
  lines.push(`FILE    : ${sourceFile}`);
  lines.push(`MODE    : ${modeLabel}`);
  lines.push(`LANGUAGE: ${result.language_code || 'auto-detected'}`);
  lines.push('========================================');
  lines.push('');

  const diarized = result.diarized_transcript;

  if (diarized && diarized.entries && diarized.entries.length > 0) {
    lines.push('DIARIZED TRANSCRIPT');
    lines.push('-------------------');
    lines.push('');

    for (const entry of diarized.entries) {
      const start = formatTime(entry.start_time_seconds);
      const end = formatTime(entry.end_time_seconds);
      const speaker = `Speaker ${parseInt(entry.speaker_id, 10) + 1}`; // 1-indexed display
      lines.push(`[${start} → ${end}]  ${speaker}:`);
      lines.push(`  ${entry.transcript}`);
      lines.push('');
    }
  } else {
    lines.push('TRANSCRIPT');
    lines.push('----------');
    lines.push('');
    lines.push(result.transcript || '(no transcript returned)');
    lines.push('');
  }

  if (result.timestamps && result.timestamps.chunks && result.timestamps.chunks.length > 0) {
    lines.push('');
    lines.push('CHUNK TIMESTAMPS');
    lines.push('----------------');
    for (let i = 0; i < result.timestamps.chunks.length; i++) {
      const start = formatTime(result.timestamps.start_time_seconds[i]);
      const end = formatTime(result.timestamps.end_time_seconds[i]);
      lines.push(`[${start} → ${end}]  ${result.timestamps.chunks[i]}`);
    }
  }

  return lines.join('\n');
}

module.exports = { formatTranscript, MODE_LABELS };
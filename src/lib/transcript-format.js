'use strict';

/**
 * transcript-format.js — single source of truth for (a) turning a Sarvam STT
 * JSON result into an ordered list of transcript lines, and (b) rendering
 * those lines as the final contextual .txt deliverable.
 *
 * WHY ONE MODULE:
 *   The scan (lib/openai-context.js) numbers the lines it shows the model, and
 *   context.js puts screen context back under those SAME numbers. If
 *   the two stages built the line list differently, a note would land under
 *   the wrong line. Both call transcriptEntries() from here.
 */

const { formatTime } = require('./format');

/**
 * Normalizes a Sarvam result (single-file or merged from chunks by transcribe.js) into
 * ordered transcript lines. Preference order:
 *   1. diarized_transcript.entries  (speaker + timing — the normal case)
 *   2. timestamps.chunks            (timing, no speaker)
 *   3. transcript                   (one untimed block)
 *
 * @param {object} result - parsed Sarvam JSON
 * @returns {Array<{start: number|null, end: number|null, speaker: string|null, text: string}>}
 */
function transcriptEntries(result) {
  const diarized = result.diarized_transcript;
  if (diarized && Array.isArray(diarized.entries) && diarized.entries.length > 0) {
    return diarized.entries.map((e) => ({
      start: e.start_time_seconds ?? null,
      end: e.end_time_seconds ?? null,
      speaker: `Speaker ${parseInt(e.speaker_id, 10) + 1}`, // 1-indexed display
      text: e.transcript || '',
    }));
  }

  const ts = result.timestamps;
  if (ts && Array.isArray(ts.chunks) && ts.chunks.length > 0) {
    return ts.chunks.map((text, i) => ({
      start: ts.start_time_seconds?.[i] ?? null,
      end: ts.end_time_seconds?.[i] ?? null,
      speaker: null,
      text: text || '',
    }));
  }

  return [{ start: null, end: null, speaker: null, text: result.transcript || '(no transcript returned)' }];
}

/**
 * Renders the final contextual transcript.
 *
 * Example output (one line with one screen note):
 *   [12:04 → 12:11]  Speaker 2:
 *     This button looks off here.
 *     [SCREEN @ 12:07] The Submit CTA on the KYC page is grey instead of blue.
 *
 * @param {object} result     - parsed Sarvam JSON
 * @param {string} sourceFile - original audio filename (for the header)
 * @param {object} [opts]
 * @param {Map<number, Array<{timestampSeconds: number, text: string}>>} [opts.annotations]
 *        - screen notes keyed by transcriptEntries() index
 * @param {string} [opts.screenStatus] - one-line header summary of screen context
 * @returns {string} formatted text content
 */
function formatContextualTranscript(result, sourceFile, opts = {}) {
  const annotations = opts.annotations || new Map();
  const lines = [];

  lines.push('========================================');
  lines.push(`FILE    : ${sourceFile}`);
  lines.push('MODE    : English + Screen Context');
  lines.push(`LANGUAGE: ${result.language_code || 'auto-detected'}`);
  if (opts.screenStatus) lines.push(`SCREEN  : ${opts.screenStatus}`);
  lines.push('========================================');
  lines.push('');
  lines.push('TRANSCRIPT');
  lines.push('----------');
  lines.push('');

  transcriptEntries(result).forEach((entry, i) => {
    // Header line: timing (when known) + speaker (when diarized).
    const timing = entry.start != null ? `[${formatTime(entry.start)} → ${formatTime(entry.end)}]` : '';
    const header = [timing, entry.speaker ? `${entry.speaker}:` : ''].filter(Boolean).join('  ');
    if (header) lines.push(header);
    lines.push(`  ${entry.text}`);

    // Screen notes sit directly under the line they explain, in time order.
    const notes = (annotations.get(i) || []).slice().sort((a, b) => a.timestampSeconds - b.timestampSeconds);
    for (const note of notes) {
      lines.push(`  [SCREEN @ ${formatTime(note.timestampSeconds)}] ${note.text}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}

module.exports = { transcriptEntries, formatContextualTranscript };

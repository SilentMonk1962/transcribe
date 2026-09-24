'use strict';

/**
 * logger.js — thin leveled wrapper around console for all pipeline stages.
 *
 * WHY THIS EXISTS (2026-08-14 refactor):
 *   Every stage script had grown its own ad-hoc console.log/warn/error calls
 *   with hand-rolled "[info]"/"[warn]"/"[error]" prefixes. This gives all
 *   stages one consistent surface and one knob: set QUIET=1 to suppress
 *   routine info output (warnings and errors always show) — useful for
 *   cron/scheduled runs that only want problems on screen.
 *
 * API mirrors console.* so call sites are drop-in replacements:
 *   logger.info('…')      → console.log   (suppressed by QUIET=1)
 *   logger.warn('…')      → console.warn  (always shown)
 *   logger.error('…')     → console.error (always shown)
 *   logger.heading('…')   → the "== … ==" banner used by pipeline.js
 */

const QUIET = process.env.QUIET === '1' || process.env.QUIET === 'true';

const logger = {
  info: (...args) => {
    if (!QUIET) console.log(...args);
  },
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  /**
   * The centered "= … =" section banner used at stage start/end.
   * @param {string} text
   */
  heading: (text) => {
    if (QUIET) return;
    console.log('\n' + text.padStart(30 + text.length / 2, '=').padEnd(60, '='));
  },
};

module.exports = logger;
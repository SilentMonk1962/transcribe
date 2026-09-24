'use strict';

/**
 * logger.js — leveled console wrapper. QUIET=1 hides info output; warnings
 * and errors always show.
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
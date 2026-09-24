'use strict';

/**
 * credit-runner.js — shared credit-safety orchestration for every paid-API
 * stage. Extracts the retry/rotate/exit pattern that used to be copy-pasted
 * across the paid-API stage files:
 *
 *   1. transcribe.js      — Sarvam, with a rotating key pool (withSarvamKeyRetry)
 *   2. context-scan.js    — OpenAI, no pool (exitOnCreditExhaustion)
 *   3. frame-describe.js  — OpenAI, no pool (exitOnCreditExhaustion)
 *
 * EXIT-CODE CONTRACT (shared with pipeline.js): every stage that runs out of
 * credits exits with code 2 — "stopped intentionally, top up and re-run" —
 * NEVER code 1 (which means broken). Stages with a key pool rotate to the
 * next key and retry the SAME item before exhausting; stages without a pool
 * print the resume box and stop immediately.
 */

const { printCreditExhausted } = require('./credit-errors');

/**
 * Retries `attempt` on credit exhaustion, rotating through a Sarvam key pool.
 * `attempt` is called with the pool's CURRENT client on every try; on a credit
 * error the pool is marked exhausted, the next key becomes current, and the
 * same item retries automatically. When every key is spent, prints the clean
 * resume box and exits with code 2.
 *
 * @param {object} opts
 * @param {import('./sarvam-keys').SarvamKeyPool} opts.pool - shared key pool
 * @param {(client: import('sarvamai').SarvamAIClient|null) => Promise<*>} opts.attempt
 *        - one item's work; returns any result, throws .isCreditError on billing failure
 * @param {string} opts.serviceLabel  - e.g. "Sarvam"
 * @param {string} opts.topUpUrl      - billing page for the provider
 * @param {string} opts.resumeCmd     - npm script to re-run to resume
 * @param {string} opts.currentItem   - what was being processed when it failed
 * @param {number} opts.doneCount     - completed items so far (for the resume box)
 * @param {number} opts.totalCount    - total items (for the resume box)
 * @param {string[]} [opts.detailLines] - optional extra box rows
 * @returns {Promise<*>} the attempt's result
 */
async function withSarvamKeyRetry({
  pool,
  attempt,
  serviceLabel,
  topUpUrl,
  resumeCmd,
  currentItem,
  doneCount,
  totalCount,
  detailLines = [],
}) {
  for (;;) {
    try {
      return await attempt(pool.currentClient());
    } catch (err) {
      if (!err || !err.isCreditError) throw err;

      const usedKeyNumber = pool.currentIndex + 1;
      pool.markExhausted();

      if (pool.isExhausted()) {
        printCreditExhausted({
          serviceLabel,
          topUpUrl,
          resumeCmd,
          currentItem,
          doneCount,
          totalCount,
          detailLines,
        });
        process.exit(2); // 2 = stopped intentionally (credits exhausted)
      }

      console.log(
        `\n  ⚠  Key ${usedKeyNumber} of ${pool.total} exhausted. Switching to key ` +
        `${pool.currentIndex + 1} and retrying ${currentItem} automatically — ` +
        `no data lost, nothing to redo.\n`
      );
      // loop back — attempt() will receive the newly-current client
    }
  }
}

/**
 * Handles a caught credit error for stages WITHOUT a key pool (OpenAI): prints the clean resume box and exits with code 2. Returns false
 * (and does nothing) when `err` is NOT a credit error, so callers can write
 * `if (exitOnCreditExhaustion(err, opts)) return;` or fall through to rethrow.
 *
 * @param {*} err
 * @param {object} opts - same shape as withSarvamKeyRetry's box fields
 * @returns {boolean} true only when it handled (and exited for) the error
 */
function exitOnCreditExhaustion(err, opts) {
  if (!err || !err.isCreditError) return false;
  printCreditExhausted(opts);
  process.exit(2);
  return true; // unreachable — keeps the contract explicit
}

module.exports = { withSarvamKeyRetry, exitOnCreditExhaustion };
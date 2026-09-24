'use strict';

/**
 * credit-errors.js — shared credit/quota exhaustion detection for every
 * pipeline stage that calls a paid API (Sarvam, DeepSeek, OpenAI).
 *
 * Each stage used to maintain its own copy of isCreditError()/printCreditExhausted()
 * with slightly different keyword sets. This module is the single source of
 * truth: the keyword union below covers Sarvam, DeepSeek, and OpenAI error
 * shapes, so every stage classifies and reports billing failures the same way.
 */

// Anchored patterns (word-boundary regexes, NOT bare substrings) covering the
// billing/credit failure shapes of Sarvam, DeepSeek, and OpenAI. The previous
// keyword lists matched bare strings like "credit", "quota", or "balance"
// anywhere in a message — a mundane error that merely CONTAINED one of those
// words (e.g. "credit-card fields skipped") would misclassify as a credit
// failure, rotate a perfectly good Sarvam key, and exit the whole run with
// code 2. Each pattern below requires actual billing context.
const CREDIT_PATTERNS = [
  /\binsufficient\s+(?:credit|credits|balance|quota|funds?)\b/i,
  /\binsufficient_(?:credit|credits|balance|quota|funds?)\b/i,
  /\b(?:credit|quota|balance)s?\s+(?:limit\s+)?(?:exhausted|insufficient|reached|exceeded)\b/i,
  /\bquota\s+exceeded\b/i,
  /\bout\s+of\s+(?:credit|credits|tokens?)\b/i,
  /\bno\s+(?:more\s+)?credits?\s+(?:available|remaining|left)\b/i,
  /\bpayment\s*required\b/i,
  /\bbilling\s+(?:error|issue|failure|problem|not\s+set\s+up)\b/i,
  // HTTP status codes 402 (Payment Required) / 429 (Too Many Requests / rate
  // limit — key rotation still applies), matched as standalone numbers only.
  /(?:^|[\s(:])(402|429)(?:$|[\s):])/,
];

/**
 * @param {string} msg
 * @returns {boolean}
 */
function isCreditError(msg) {
  if (!msg) return false;
  return CREDIT_PATTERNS.some((re) => re.test(String(msg)));
}

/**
 * Classifies a caught API error: returns a rethrow-able Error with
 * `.isCreditError = true` if it looks like a credit/quota problem, or null if
 * it's some other failure the caller should handle its own way. Centralizes
 * the "unpack message + status from the SDK error shape" dance so stages
 * don't each re-implement it.
 *
 * @param {*} err
 * @returns {Error|null}
 */
function toCreditErrorOrNull(err) {
  const errMsg = err?.message || err?.error?.message || String(err);
  const status = err?.status || err?.error?.status;
  if (isCreditError(errMsg) || isCreditError(String(status))) {
    const creditErr = new Error(errMsg);
    creditErr.isCreditError = true;
    return creditErr;
  }
  return null;
}

/**
 * Prints a clean, friendly credit-exhaustion box and (optionally) exits
 * gracefully. No stack traces. The caller passes everything the box needs;
 * `detailLines` allows stage-specific extra rows (e.g. Sarvam key-rotation
 * state) without forking the whole function.
 *
 * @param {object} opts
 * @param {string} opts.serviceLabel - e.g. "Sarvam", "DeepSeek", "OpenAI"
 * @param {string} opts.topUpUrl     - billing page for the provider
 * @param {string} opts.resumeCmd    - npm script to re-run to resume
 * @param {string} opts.currentItem  - what was being processed when it failed
 * @param {number} opts.doneCount
 * @param {number} opts.totalCount
 * @param {string[]} [opts.detailLines] - optional extra rows under "Stopped on"
 */
function printCreditExhausted({ serviceLabel, topUpUrl, resumeCmd, currentItem, doneCount, totalCount, detailLines = [] }) {
  // Deliberately NOT routed through lib/logger.js: this banner is a stop-the-run
  // notification that must ALWAYS print, even when QUIET=1 suppresses info logs.
  const title = `${String(serviceLabel).toUpperCase()} CREDITS EXHAUSTED`;
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log(`║  ${title.padEnd(58)}║`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Progress : ${String(doneCount).padEnd(2)} of ${String(totalCount).padEnd(3)} item(s) completed              ║`);
  console.log(`║  Stopped on : ${String(currentItem).slice(0, 42).padEnd(42)} ║`);
  for (const line of detailLines) {
    console.log(`║  ${String(line).slice(0, 56).padEnd(56)} ║`);
  }
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  TO RESUME:                                              ║');
  console.log(`║  1. Top up at: ${topUpUrl.padEnd(41)}║`);
  console.log(`║  2. Re-run:  ${resumeCmd.padEnd(44)}║`);
  console.log('║  3. Completed items are skipped automatically.           ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
}

module.exports = { isCreditError, toCreditErrorOrNull, printCreditExhausted };

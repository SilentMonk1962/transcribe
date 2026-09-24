'use strict';

/**
 * credit.js — credit/quota exhaustion handling for every paid-API call
 * (Sarvam, OpenAI).
 *
 * EXIT-CODE CONTRACT: running out of credit exits with code 2 ("stopped on
 * purpose — top up and re-run"), never 1 ("broken"). Sarvam rotates through
 * its key pool first; OpenAI has one key and stops at once. Finished work is
 * always kept, so a re-run resumes where it stopped.
 */

// Patterns need real billing context — a bare "credit" or "quota" in an
// unrelated error must not rotate a good key or stop the run.
const CREDIT_PATTERNS = [
  /\binsufficient\s+(?:credit|credits|balance|quota|funds?)\b/i,
  /\binsufficient_(?:credit|credits|balance|quota|funds?)\b/i,
  /\b(?:credit|quota|balance)s?\s+(?:limit\s+)?(?:exhausted|insufficient|reached|exceeded)\b/i,
  /\bquota\s+exceeded\b/i,
  /\bout\s+of\s+(?:credit|credits|tokens?)\b/i,
  /\bno\s+(?:more\s+)?credits?\s+(?:available|remaining|left)\b/i,
  /\bpayment\s*required\b/i,
  /\bbilling\s+(?:error|issue|failure|problem|not\s+set\s+up)\b/i,
  // HTTP 402 / 429 as standalone numbers only.
  /(?:^|[\s(:])(402|429)(?:$|[\s):])/,
];

/** @returns {boolean} true when the message looks like a billing/quota failure */
function isCreditError(msg) {
  return !!msg && CREDIT_PATTERNS.some((re) => re.test(String(msg)));
}

/**
 * Classifies an SDK error: an Error flagged `.isCreditError` for billing
 * failures, else null (caller handles it as an ordinary error).
 */
function toCreditErrorOrNull(err) {
  const msg = err?.message || err?.error?.message || String(err);
  const status = err?.status || err?.error?.status;
  if (!isCreditError(msg) && !isCreditError(String(status))) return null;
  const creditErr = new Error(msg);
  creditErr.isCreditError = true;
  return creditErr;
}

/**
 * Prints the resume box and exits with code 2. Uses console directly so it
 * always shows, even with QUIET=1.
 *
 * @param {{serviceLabel: string, topUpUrl: string, currentItem: string, detailLines?: string[]}} opts
 */
function exitCreditExhausted({ serviceLabel, topUpUrl, currentItem, detailLines = [] }) {
  const row = (s) => console.log(`║  ${String(s).slice(0, 56).padEnd(56)}║`);
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  row(`${String(serviceLabel).toUpperCase()} CREDITS EXHAUSTED`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  row(`Stopped on : ${currentItem}`);
  detailLines.forEach(row);
  console.log('╠══════════════════════════════════════════════════════════╣');
  row(`1. Top up at: ${topUpUrl}`);
  row('2. Re-run: npm run pipeline');
  row('3. Finished work is skipped automatically.');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  process.exit(2);
}

/**
 * Runs `attempt(client)` with the Sarvam pool's current key; on a credit
 * error rotates to the next key and retries the SAME item. Exits (code 2)
 * once every key is spent.
 *
 * @param {import('./sarvam-keys').SarvamKeyPool} pool
 * @param {string} currentItem
 * @param {(client: object) => Promise<*>} attempt
 */
async function withSarvamKeyRetry(pool, currentItem, attempt) {
  for (;;) {
    try {
      return await attempt(pool.currentClient());
    } catch (err) {
      if (!err?.isCreditError) throw err;
      const used = pool.currentIndex + 1;
      pool.markExhausted();
      if (pool.isExhausted()) {
        exitCreditExhausted({
          serviceLabel: 'Sarvam',
          topUpUrl: 'https://dashboard.sarvam.ai/',
          currentItem,
          detailLines: [`All ${pool.total} key(s) in the pool are exhausted.`],
        });
      }
      console.log(`\n  ⚠  Sarvam key ${used}/${pool.total} exhausted — retrying ${currentItem} on key ${pool.currentIndex + 1}.\n`);
    }
  }
}

module.exports = { isCreditError, toCreditErrorOrNull, exitCreditExhausted, withSarvamKeyRetry };

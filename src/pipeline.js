'use strict';
const logger = require('./lib/logger');

/**
 * pipeline.js — runs everything, in one process:
 *
 *   0. status   what is done / transcribed / new (read-only, lib/status.js)
 *   0. ask      recordings whose source video is gone: finish without screen
 *               context, or hold them until the video is back?
 *   0. budget   estimate for PENDING work only; y/N consent (skipped at ₹0)
 *   1. convert     video → audio                     (src/convert.js)
 *   2. transcribe  audio → English JSON (Sarvam)     (src/transcribe.js)
 *   3. context     scan → frames → describe → final (src/context.js)
 *   4. summary  what is still not done, and why
 *
 * Output: output/<group>/<session-id>/<name>-contextual.txt
 *
 * Flags:
 *   --yes                   skip the budget prompt (automation)
 *   --allow-missing-video   finish video-less recordings without asking
 *
 * Exit codes: 0 ok · 1 error / not approved · 2 credits ran out (re-run to resume)
 *
 * Usage: npm run pipeline [-- --yes]
 */

require('dotenv').config();

const convert = require('./convert');
const transcribe = require('./transcribe');
const context = require('./context');
const { config } = require('./lib/config');
const { snapshot } = require('./lib/status');
const { estimateCost, formatEstimate, askYesNo, inr } = require('./lib/budget');

const YES = process.argv.includes('--yes');
const ALLOW_MISSING_FLAG = process.argv.includes('--allow-missing-video');

const label = (r) => `${r.group}/${r.sessionId}/${r.baseName}`;

function countStates(items) {
  return {
    done: items.filter((r) => r.state === 'done').length,
    transcribed: items.filter((r) => r.state === 'transcribed').length,
    new: items.filter((r) => r.state === 'new').length,
  };
}

/** Lists every recording that is not finished, with the reason. */
function printSummary(items) {
  const open = items.filter((r) => r.state !== 'done');
  logger.info('\n============================================================');
  logger.info(open.length ? ` ${open.length} recording(s) not finished:` : ' All recordings finished.');
  for (const r of open) {
    const why = r.state === 'new' ? 'not transcribed yet (failed, or waiting on chunk parts)'
      : !r.videoPath ? 'held — source video missing from input/'
        : 'screen context incomplete (a step failed)';
    logger.info(`   • ${label(r)} — ${why}`);
  }
  if (open.length) logger.info(' Re-run "npm run pipeline" to retry; finished work is skipped.');
  logger.info(' Final files: output/<group>/<session-id>/<name>-contextual.txt');
  logger.info('============================================================\n');
}

async function main() {
  logger.info('============================================================');
  logger.info(' Contextual transcript pipeline');
  logger.info('============================================================');

  // ── Status: price only what is still pending ───────────────────────────────
  const items = snapshot();
  const counts = countStates(items);
  logger.info(`[status] ${counts.done} done · ${counts.transcribed} transcribed · ${counts.new} new`);

  // ── Missing source videos: ask before anything is finalised ────────────────
  const missing = items.filter((r) => r.state === 'transcribed' && !r.videoPath);
  let allowMissingVideo = ALLOW_MISSING_FLAG;
  if (missing.length && !allowMissingVideo) {
    logger.warn(`\n[status] ${missing.length} recording(s) are ALREADY TRANSCRIBED — no re-transcription, no Sarvam cost.`);
    logger.warn('[status] Only screen context is missing: their source video is not in ' + config.inputDir());
    missing.forEach((r) => logger.warn(`   • ${label(r)}`));
    logger.warn('   y = write their final transcripts now, without screen context (₹0)');
    logger.warn('   N = hold them until you put the videos back in input/<group>/');
    allowMissingVideo = await askYesNo('Finish them without screen context?');
    logger.info(allowMissingVideo ? '[status] Will finish them without screen context.' : '[status] Holding them.');
  }

  const pending = items.filter((r) => r.state === 'new' || (r.state === 'transcribed' && (r.videoPath || allowMissingVideo)));
  if (pending.length === 0) {
    logger.info('\n[status] Nothing to do.');
    printSummary(items);
    return;
  }

  // ── Keys needed for the pending work ───────────────────────────────────────
  const problems = [];
  if (counts.new && !process.env.SARVAM_API_KEYS) problems.push('SARVAM_API_KEYS (transcription) — https://dashboard.sarvam.ai/');
  if (pending.some((r) => r.videoPath) && !process.env.OPENAI_API_KEY) problems.push('OPENAI_API_KEY (screen context) — https://platform.openai.com/');
  if (problems.length) {
    logger.error('[pre-flight] ✗ Missing in .env:\n' + problems.map((p) => `  • ${p}`).join('\n'));
    process.exit(1);
  }

  // ── Budget consent (pending work only; skipped when nothing is billable) ──
  const estimate = await estimateCost(pending);
  logger.info('\n' + formatEstimate(estimate, counts));
  if (estimate.totalInr >= 0.01 && !YES) {
    const ok = await askYesNo(`This run is estimated to cost ≈ ${inr(estimate.totalInr)}. Continue?`);
    if (!ok) {
      logger.info('[budget] Not approved — nothing spent. (Non-interactive? pass --yes.)');
      process.exit(1);
    }
  }

  // ── Stages ─────────────────────────────────────────────────────────────────
  logger.heading(' 1/3 convert ');
  await convert.run();
  logger.heading(' 2/3 transcribe ');
  await transcribe.run();
  logger.heading(' 3/3 context ');
  await context.run({ allowMissingVideo });

  printSummary(snapshot());
}

main().catch((err) => {
  logger.error('\n[fatal error]', err.message || err);
  process.exit(1);
});

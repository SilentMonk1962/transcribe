'use strict';
const logger = require('./lib/logger');

/**
 * pipeline.js — Runs the full modular pipeline end-to-end, one stage at a time:
 *
 *   1. convert         video  → audio               (src/index.js --convert-only)
 *                           — recordings over the chunk threshold (60 min
 *                           default) are auto-split into fixed-length audio
 *                           chunks here, see src/lib/chunking.js
 *   2. transcribe      audio  → English transcript JSON (src/index.js --transcribe-only)
 *                           — Sarvam "translate" mode only (codemix removed);
 *                           chunk-aware; keys come from the shared pool
 *                           (lib/sarvam-keys.js) and rotate on credit exhaustion.
 *   3. merge-chunks     →  stitches a chunked recording's per-chunk transcripts
 *                           into ONE timestamp-corrected transcript
 *                           (src/merge-chunks.js) — no-op otherwise.
 *   4. context-scan     →  OpenAI reads the transcript (text only) and lists
 *                           the lines that need the screen to be understood
 *                           (src/context-scan.js)
 *   5. frame-capture    →  ffmpeg grabs exactly those moments from the source
 *                           video in input/ (src/frame-capture.js)
 *   6. frame-describe   →  OpenAI vision writes a short pen picture of each
 *                           frame (src/frame-describe.js)
 *   7. context-inject   →  writes <name>-contextual.txt with each description
 *                           under its line, then deletes every intermediate
 *                           (src/context-inject.js)
 *
 * FINAL OUTPUT: output/<group>/<session-id>/<name>-contextual.txt — the only
 * file left in a finished session folder.
 *
 * BUDGET CONSENT (stage 0): before ANY stage runs — and before any credit is
 * spent — the pipeline probes the recordings in input/, estimates the spend
 * (Sarvam saaras:v3 at ₹45/hr of billed audio + OpenAI token rates, all
 * overridable via .env — see src/lib/budget.js) and asks for a keyed y/N
 * consent. Non-interactive runs refuse to spend unless --yes is passed.
 * Individual stage scripts are intentionally NOT gated — they're the manual
 * resume path.
 *
 * Every stage is ALSO independently runnable via its own npm script. Each has
 * its own resume logic, so re-running after a partial failure only redoes the
 * work that didn't finish.
 *
 * EXIT CODES:
 *   0 — everything finished
 *   1 — a stage crashed / config error / budget not approved
 *   2 — stopped intentionally because credits ran out. Completed work is
 *       preserved; top up and re-run to continue.
 *
 * Usage:
 *   node src/pipeline.js
 *   node src/pipeline.js --yes          (skip the budget consent — for automation)
 *   npm run pipeline
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { config } = require('./lib/config');
const { estimateCost, formatEstimate, askBudgetConsent } = require('./lib/budget');
const { walkInputVideos } = require('./lib/input-walk');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const INPUT_DIR = config.inputDir();

// --yes: skip the budget consent (used for automation / unattended runs).
const YES_FLAG = process.argv.includes('--yes');

const STAGES = [
  { name: 'convert',         script: 'src/index.js',           args: ['--convert-only'] },
  { name: 'transcribe',      script: 'src/index.js',           args: ['--transcribe-only'] },
  { name: 'merge-chunks',    script: 'src/merge-chunks.js',    args: [] },
  { name: 'context-scan',    script: 'src/context-scan.js',    args: [] },
  { name: 'frame-capture',   script: 'src/frame-capture.js',   args: [] },
  { name: 'frame-describe',  script: 'src/frame-describe.js',  args: [] },
  { name: 'context-inject',  script: 'src/context-inject.js',  args: [] },
];

const ENV_EXPECTATIONS = [
  {
    names: ['SARVAM_API_KEYS', 'SARVAM_API_KEY'],
    why: 'Sarvam transcription (Stage 2).',
    url: 'https://dashboard.sarvam.ai/',
  },
  {
    names: ['OPENAI_API_KEY'],
    why: 'context scan (Stage 4) and frame description (Stage 6).',
    url: 'https://platform.openai.com/',
  },
];

/**
 * Pre-flight env validation — checks every API key a FULL pipeline run needs
 * BEFORE any credits are spent, so a run never dies 40 minutes in because a
 * later stage's key was missing.
 *
 * @returns {string[]} list of human-readable problems; empty when all good.
 */
function validateEnv() {
  const problems = [];
  for (const { names, why, url } of ENV_EXPECTATIONS) {
    const present = names.some((n) => process.env[n] && process.env[n] !== 'your_sarvam_api_key_here');
    if (!present) {
      problems.push(`  • Missing one of [${names.join(', ')}] — needed for ${why}\n    Add it to .env (copy .env.example): ${url}`);
    }
  }

  const inputDir = INPUT_DIR;
  if (!fs.existsSync(inputDir)) {
    problems.push(`  • Input directory not found: ${inputDir}\n    Put your meeting recordings there (or set INPUT_DIR in .env).`);
  }
  return problems;
}

/**
 * Runs one stage as a child process with output streamed live to the
 * console. Returns the child's exit code.
 *
 * EXIT CODES from child stages:
 *   0 — succeeded
 *   2 — stopped intentionally (credit exhaustion) — NOT a crash; caller
 *       decides whether to keep going (pipeline stops here either way, but
 *       reports it as "top up and re-run" rather than "broken").
 *
 * @param {{name: string, script: string, args: string[]}} stage
 * @returns {number} exit code
 */
function runStage(stage) {
  const heading = ` STAGE: ${stage.name} `;
  logger.heading(heading);

  const result = spawnSync('node', [stage.script, ...stage.args], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });

  if (result.error) {
    logger.error(`\n[pipeline] ✗  Could not start stage "${stage.name}": ${result.error.message}`);
    return 1;
  }
  return result.status ?? 0;
}

async function main() {
  logger.info('============================================================');
  logger.info(' Application UX Pipeline — contextual transcripts');
  logger.info('============================================================');
  logger.info(' Stages: ' + STAGES.map((s) => s.name).join(' → '));
  if (YES_FLAG) logger.info(' Budget    : --yes passed — consent skipped');

  // ── Pre-flight: fail fast on missing env before any credits are spent ────
  logger.info('\n[pre-flight] Checking environment…');
  const problems = validateEnv();
  if (problems.length > 0) {
    logger.error('[pre-flight] ✗  The following must be fixed before running:');
    logger.error(problems.join('\n'));
    logger.error('\n[pre-flight] Copy .env.example to .env and fill in your keys, then re-run.');
    process.exit(1);
  }
  logger.info('[pre-flight] ✓  All keys present, input directory found.');

  // ── Stage 0: budget consent — refuse to spend without an explicit yes ────
  if (!YES_FLAG) {
    const videos = walkInputVideos(INPUT_DIR);
    if (videos.length === 0) {
      logger.info('\n[budget] No videos found in input/ — nothing to be billed. Skipping budget check.');
    } else {
      logger.info('\n[budget] Estimating spend for this run…');
      const estimate = await estimateCost(videos);
      logger.info('\n' + formatEstimate(estimate));
      const ok = await askBudgetConsent(
        `This transcription is estimated to cost ~${estimate.displayCents}. Would you like me to continue?`
      );
      if (!ok) {
        logger.info('\n[budget] Budget not approved — exiting without spending anything.');
        logger.info('[budget] Re-run "npm run pipeline" and answer y when you are ready.');
        process.exit(1);
      }
      logger.info('[budget] ✓  Budget approved — starting the pipeline.\n');
    }
  }

  for (const stage of STAGES) {
    const code = runStage(stage);

    if (code === 2) {
      logger.error(`\n[pipeline] ⏸  Stage "${stage.name}" stopped intentionally (credits exhausted).`);
      logger.error(`[pipeline]    Top up your key(s), then re-run "npm run pipeline" — everything`);
      logger.error(`[pipeline]    already completed is skipped automatically (resume logic).`);
      process.exit(2);
    }

    if (code !== 0) {
      logger.error(`\n[pipeline] ✗  Stage "${stage.name}" exited with code ${code}. Stopping pipeline.`);
      logger.error(`[pipeline]    Fix the issue above, then re-run "npm run pipeline" — completed`);
      logger.error(`[pipeline]    stages and files are skipped automatically (resume logic).`);
      process.exit(code);
    }
  }

  logger.info('\n============================================================');
  logger.info(' Pipeline complete. Final contextual transcripts:');
  logger.info('   output/<group>/<session-id>/<name>-contextual.txt');
  logger.info(' (any recording still "waiting" finishes on the next run)');
  logger.info('============================================================\n');
}

main().catch((err) => {
  logger.error('\n[fatal error]', err.message || err);
  process.exit(1);
});

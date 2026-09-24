'use strict';
const logger = require('./lib/logger');

/**
 * pipeline.js — Runs the full modular pipeline end-to-end, one stage at a time:
 *
 *   1. convert         video  → audio               (src/index.js --convert-only)
 *                           — recordings over the chunk threshold (60 min
 *                           default) are auto-split into fixed-length audio
 *                           chunks here, see src/lib/chunking.js
 *   2. transcribe      audio  → English transcript   (src/index.js --transcribe-only)
 *                           — translate-only by DEFAULT (the Hinglish codemix
 *                           pass is opt-in via SARVAM_TRANSLATE_ONLY=0, see
 *                           src/lib/modes.js); chunk-aware; Sarvam keys come
 *                           from the shared pool (lib/sarvam-keys.js):
 *                           SARVAM_API_KEYS comma list first, falling back to
 *                           the legacy SARVAM_API_KEY / SARVAM_API_KEY_FALLBACK
 *                           pair. Keys rotate automatically mid-run on credit
 *                           exhaustion instead of stopping.
 *   3. merge-chunks     →  stitches any chunked recording's per-chunk
 *                           transcripts back into ONE continuous transcript,
 *                           timestamp-corrected (src/merge-chunks.js) — a
 *                           no-op for recordings that were never chunked.
 *                           Every stage after this one is chunking-unaware
 *                           by design: it only ever sees one transcript per
 *                           session, same as before chunking existed.
 *   4. pure-english     →  clean English transcript  (src/pure-english.js)
 *   5. meeting-notes    →  draft notes + vision-assist flags + structured
 *                           session-data.json, grouped so unrelated calls
 *                           never mix (src/meeting-notes.js) — this is
 *                           vision-assist Stage 2 (itself 2 DeepSeek calls
 *                           as of 2026-07-16: an index pass, then an
 *                           index-aware draft pass — see meeting-notes.js header)
 *   6. verify-notes     →  independent DeepSeek cross-check of each draft
 *                           against its full transcript, flagging possible
 *                           hallucinations/omissions to notes/verification.json
 *                           (src/verify-notes.js) — vision-assist Stage 2.5,
 *                           purely advisory, never auto-edits the draft
 *   7. vision-capture   →  targeted frame capture for flagged timestamps only
 *                           (src/vision-capture.js) — vision-assist Stage 3
 *   8. vision-caption   →  independent OpenAI captioning of captured frames
 *                           (src/vision-caption.js) — vision-assist Stage 4
 *   9. vision-patch     →  DeepSeek patches drafts into final.md, or copies
 *                           them through unpatched when there's nothing to
 *                           patch (src/vision-patch.js) — vision-assist Stage 5,
 *                           also appends a note if Stage 2.5 flagged anything
 *  10. export           →  final deliverable. DEFAULT: multi-sheet Excel
 *                           workbook from every session's structured data
 *                           (src/generate-xlsx.js), guaranteed to include
 *                           every problem/topic/gap as a row. With
 *                           --format md, a template-based markdown
 *                           consolidation instead (src/generate-md.js) — no
 *                           LLM call, just session-data.json rendered.
 *
 * BUDGET CONSENT (stage 0, added 2026-08-06): before ANY stage runs — and
 * before any credit is spent — the pipeline probes the recordings in input/,
 * estimates the spend (Sarvam saaras:v3 at ₹45/hr of billed audio, DeepSeek
 * V4 Pro and OpenAI Luna token rates, all overridable via .env — see
 * src/lib/budget.js) and asks for a keyed y/N consent. The pipeline only
 * proceeds on an explicit "yes". Non-interactive runs refuse to spend unless
 * --yes is passed. Individual stage scripts (npm run meeting-notes, etc.)
 * are intentionally NOT gated — they're the manual resume path.
 *
 * Every stage is ALSO independently runnable via its own npm script — this
 * file is a convenience wrapper, not a replacement. Each stage has its own
 * resume logic, so re-running the pipeline after a partial failure only
 * redoes the work that didn't finish.
 *
 * EXIT CODES:
 *   0 — everything finished
 *   1 — a stage crashed / config error / budget not approved (fix and re-run;
 *       resume logic skips done work)
 *   2 — stopped intentionally because credits ran out (all keys exhausted).
 *       Completed sessions are preserved; top up and re-run to continue.
 *
 * Usage:
 *   node src/pipeline.js
 *   node src/pipeline.js --format md
 *   node src/pipeline.js --yes          (skip the budget consent — for automation)
 *   npm run pipeline
 *   npm run pipeline -- --format md
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

const FORMAT = process.argv.includes('--format')
  ? process.argv[process.argv.indexOf('--format') + 1] || 'xlsx'
  : 'xlsx';
if (FORMAT !== 'xlsx' && FORMAT !== 'md') {
  logger.error(`[pipeline] Unknown --format "${FORMAT}" (expected "xlsx" or "md").`);
  process.exit(1);
}

const UNTIL = process.argv.includes('--until')
  ? process.argv[process.argv.indexOf('--until') + 1] || 'all'
  : 'all';
if (UNTIL !== 'all' && UNTIL !== 'transcript') {
  logger.error(`[pipeline] Unknown --until "${UNTIL}" (expected "transcript" or "all").`);
  process.exit(1);
}

// --yes: skip the budget consent (used for automation / unattended runs).
const YES_FLAG = process.argv.includes('--yes');

let STAGES = [
  { name: 'convert',         script: 'src/index.js',           args: ['--convert-only'] },
  { name: 'transcribe',      script: 'src/index.js',           args: ['--transcribe-only'] },
  { name: 'merge-chunks',    script: 'src/merge-chunks.js',     args: [] },
  { name: 'pure-english',    script: 'src/pure-english.js',     args: [] },
  { name: 'meeting-notes',   script: 'src/meeting-notes.js',    args: [] },
  { name: 'verify-notes',    script: 'src/verify-notes.js',     args: [] },
  { name: 'vision-capture',  script: 'src/vision-capture.js',   args: [] },
  { name: 'vision-caption',  script: 'src/vision-caption.js',   args: [] },
  { name: 'vision-patch',    script: 'src/vision-patch.js',     args: [] },
];

if (FORMAT === 'xlsx') {
  STAGES.push({ name: 'export-xlsx', script: 'src/generate-xlsx.js', args: [] });
} else {
  STAGES.push({ name: 'export-md', script: 'src/generate-md.js', args: [] });
}

// --until transcript: stop after the final diarized English transcript
// (convert → transcribe → merge-chunks → pure-english). Never reaches the
// DeepSeek/OpenAI note + vision stages. --until all (default) runs everything.
if (UNTIL === 'transcript') {
  STAGES = STAGES.slice(0, 4);
}

const ENV_EXPECTATIONS = [
  {
    names: ['SARVAM_API_KEYS', 'SARVAM_API_KEY'],
    why: 'Sarvam transcription (Stage 2) and the pure-English pass (Stage 4).',
    url: 'https://dashboard.sarvam.ai/',
  },  {
    names: ['DEEPSEEK_API_KEY'],
    why: 'meeting-notes (Stage 5), verify-notes (Stage 6) and vision-patch (Stage 9).',
    url: 'https://platform.deepseek.com/',
  },
  {
    names: ['OPENAI_API_KEY'],
    why: 'independent frame captioning (Stage 8, vision-caption).',
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
  logger.info(' Application UX Pipeline — full run');
  logger.info('============================================================');
  logger.info(' Stages: ' + STAGES.map((s) => s.name).join(' → '));
  logger.info(' Export format: ' + FORMAT);
  logger.info((UNTIL === 'transcript' ? ' Stop at   : transcript (final diarized English transcript)' : ' Stop at   : all stages'));
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
  if (UNTIL === 'transcript') {
    logger.info(' Transcript stage complete. Final diarized English transcripts:');
    logger.info('   output/<group>/<session-id>/transcripts/pure-english/*.txt');
    logger.info(' (meeting-notes / verify / vision / export stages were NOT run.)');
    logger.info('============================================================\n');
    return;
  }
  logger.info(' Pipeline complete. See ./output for all artifacts:');
  logger.info('   output/<group>/<session-id>/transcripts/{codemix,translate,pure-english}/');
  logger.info('   output/<group>/<session-id>/notes/topic-index.json  — Stage 2a index (cached)');
  logger.info('   output/<group>/<session-id>/notes/draft.md   — Stage 2b draft + flags');
  logger.info('   output/<group>/<session-id>/notes/session-data.json — Stage 2b structured data');
  logger.info('   output/<group>/<session-id>/notes/verification.json — Stage 2.5 advisory check');
  logger.info('   output/<group>/<session-id>/notes/final.md   — Stage 5 patched, read this one');
  logger.info('   output/<group>/<session-id>/screenshots/     — Stage 3 targeted vision-assist frames');
  logger.info('   output/<group>/<session-id>/captions/        — Stage 4 per-frame captions');
  if (FORMAT === 'xlsx') {
    logger.info('   output/<group>/<group>-meeting-notes.xlsx    — one workbook per explicit group (export stage)');
  } else {
    logger.info('   output/<group>/<group>-meeting-notes.md      — one markdown consolidation per explicit group (export stage)');
  }
  logger.info('============================================================\n');
}

main().catch((err) => {
  logger.error('\n[fatal error]', err.message || err);
  process.exit(1);
});

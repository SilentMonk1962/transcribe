'use strict';
const logger = require('./lib/logger');

/**
 * cleanup-legacy.js — ONE-TIME cleanup of session folders produced by the old
 * notes pipeline (DeepSeek notes, codemix, pure-english copy, Excel/markdown
 * exports). Run it once, then run "npm run pipeline" to turn every surviving
 * English transcript into a <name>-contextual.txt.
 *
 * WHAT IT DOES, per output/<group>/<session-id>/:
 *   1. KEEPS the English Sarvam JSON (transcripts/translate/<name>.json) — it
 *      is the input for the new screen-context stages, so no audio is ever
 *      re-billed. If only the pure-english copy exists, it is MOVED into
 *      transcripts/translate/ first (it is the same Sarvam output).
 *   2. DELETES: transcripts/codemix/, transcripts/pure-english/, legacy
 *      transcripts/translate/*_translate.txt, notes/, screenshots/, captions/.
 *   And per group: <group>-meeting-notes.xlsx / .md exports; at the output
 *   root: master-meeting-notes*.md.
 *   session-links.json is kept — later runs need it for session resolution.
 *
 * SAFETY: prints the full list first and asks y/N. --dry-run only prints.
 * --yes skips the prompt (automation). Nothing is touched outside output/.
 *
 * Example:
 *   Session 20260708_110318 holds codemix/, translate/, pure-english/, notes/.
 *   → translate/<name>.json kept; the other folders removed.
 *   → next "npm run pipeline" writes <name>-contextual.txt and removes the JSON.
 *
 * Usage:
 *   node src/cleanup-legacy.js --dry-run
 *   node src/cleanup-legacy.js
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {
  OUTPUT_DIR,
  groupDir,
  sessionDir,
  transcriptsDir,
  listAllGroups,
  listSessionsInGroup,
  ensureDir,
} = require('./lib/session-paths');

const DRY_RUN = process.argv.includes('--dry-run');
const YES = process.argv.includes('--yes');

/** Session sub-folders the new pipeline never produces. */
const LEGACY_SESSION_DIRS = ['notes', 'screenshots', 'captions'];
/** Transcript modes the new pipeline never produces. */
const LEGACY_MODE_DIRS = ['codemix', 'pure-english'];

/**
 * Builds the cleanup plan without touching disk.
 * @returns {{moves: Array<{from: string, to: string}>, deletes: string[]}}
 */
function buildPlan() {
  const moves = [];
  const deletes = [];

  // Old consolidated notes at the output root.
  if (fs.existsSync(OUTPUT_DIR)) {
    for (const f of fs.readdirSync(OUTPUT_DIR)) {
      if (/^master-meeting-notes.*\.md$/.test(f)) deletes.push(path.join(OUTPUT_DIR, f));
    }
  }

  for (const group of listAllGroups()) {
    // Group-level exports from the old xlsx/md stage.
    for (const ext of ['xlsx', 'md']) {
      const p = path.join(groupDir(group), `${group}-meeting-notes.${ext}`);
      if (fs.existsSync(p)) deletes.push(p);
    }

    for (const sessionId of listSessionsInGroup(group)) {
      const tDir = transcriptsDir(group, sessionId);
      const translateDir = path.join(tDir, 'translate');
      const pureDir = path.join(tDir, 'pure-english');

      // 1. Rescue a pure-english JSON when its translate twin is missing.
      if (fs.existsSync(pureDir)) {
        for (const f of fs.readdirSync(pureDir).filter((n) => n.endsWith('.json'))) {
          const target = path.join(translateDir, f);
          if (!fs.existsSync(target)) moves.push({ from: path.join(pureDir, f), to: target });
        }
      }

      // 2. Legacy mode folders + legacy .txt renders in translate/.
      for (const mode of LEGACY_MODE_DIRS) {
        const p = path.join(tDir, mode);
        if (fs.existsSync(p)) deletes.push(p);
      }
      if (fs.existsSync(translateDir)) {
        for (const f of fs.readdirSync(translateDir).filter((n) => n.endsWith('_translate.txt'))) {
          deletes.push(path.join(translateDir, f));
        }
      }

      // 3. Notes + old vision-assist folders.
      for (const d of LEGACY_SESSION_DIRS) {
        const p = path.join(sessionDir(group, sessionId), d);
        if (fs.existsSync(p)) deletes.push(p);
      }
    }
  }
  return { moves, deletes };
}

/**
 * Asks a y/N question; non-TTY refuses (same rule as the budget prompt).
 * @param {string} q
 * @returns {Promise<boolean>}
 */
function confirm(q) {
  if (!process.stdin.isTTY) {
    logger.info('[cleanup] Non-interactive run. Pass --yes to proceed without a prompt.');
    return Promise.resolve(false);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${q} [y/N] `, (a) => {
      rl.close();
      resolve(['y', 'yes'].includes(a.trim().toLowerCase()));
    });
  });
}

async function main() {
  logger.info('============================================================');
  logger.info(' One-time cleanup of legacy notes-pipeline output');
  logger.info('============================================================');
  logger.info(`Output dir : ${OUTPUT_DIR}\n`);

  const { moves, deletes } = buildPlan();
  if (moves.length === 0 && deletes.length === 0) {
    logger.info('[cleanup] Nothing legacy found. Already clean.\n');
    return;
  }

  const rel = (p) => path.relative(OUTPUT_DIR, p);
  for (const m of moves) logger.info(`  MOVE    ${rel(m.from)} → ${rel(m.to)}`);
  for (const d of deletes) logger.info(`  DELETE  ${rel(d)}`);
  logger.info(`\n[cleanup] ${moves.length} move(s), ${deletes.length} deletion(s).`);

  if (DRY_RUN) {
    logger.info('[cleanup] --dry-run: nothing changed.\n');
    return;
  }
  if (!YES && !(await confirm('Apply this cleanup? Deletions cannot be undone.'))) {
    logger.info('[cleanup] Cancelled — nothing changed.\n');
    process.exit(1);
  }

  // Moves first, so no English JSON is lost with its pure-english folder.
  for (const m of moves) {
    ensureDir(path.dirname(m.to));
    fs.renameSync(m.from, m.to);
  }
  for (const d of deletes) fs.rmSync(d, { recursive: true, force: true });

  logger.info('[cleanup] ✓  Done. Now run "npm run pipeline" to build the contextual transcripts.\n');
}

module.exports = { buildPlan };

if (require.main === module) {
  main().catch((err) => {
    logger.error('\n[fatal error]', err.message || err);
    process.exit(1);
  });
}

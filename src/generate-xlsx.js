'use strict';
const logger = require('./lib/logger');

/**
 * generate-xlsx.js — exports every session's structured notes into a detailed
 * Excel workbook that guarantees nothing raised by any party gets missed.
 *
 * Replaces the old master-meeting-notes.md consolidation (removed 2026-08-03):
 * instead of a prose rollup that a second DeepSeek call could silently drop
 * content from, every problem/topic/problem-with-feature/gap is written as a
 * row you can filter, sort, and track in Excel.
 *
 * DATA SOURCE:
 *   Each session's notes/session-data.json (written by meeting-notes.js at
 *   Stage 2, enriched by vision-patch.js at Stage 5). If a session predates
 *   structured data (draft.md exists but no session-data.json), it is derived
 *   from the draft markdown via lib/session-data.js's parseDraftFallback().
 *
 * WORKBOOK SHEETS:
 *   Problems       — every problem across all sessions, with status, who raised
 *                    it, the visual confirmation, and verification flags.
 *   Topics         — every topic/concept explained, with key parameters.
 *   Summary        — per-session counts (# topics, # problems, # features,
 *                    # open items, # verification flags).
 *   Action Items   — every problem that HAS a feature request (things to build).
 *   Gaps & Risks   — Stage 2.5 verification findings (possible hallucinations
 *                    and omissions) so nothing is silently missed.
 *
 * OUTPUT:
 *   output/<group>/<group>-meeting-notes.xlsx      (per group)
 *
 *   There is deliberately NO all-sessions combined workbook anymore. Only
 *   explicit folder-derived groups (sub-folders of input/) produce a workbook;
 *   the default "ungrouped" bucket is skipped so unrelated one-off calls are
 *   never merged into a single notes file.
 *
 * Usage:
 *   node src/generate-xlsx.js
 *   npm run xlsx
 *   npm run pipeline -- --format xlsx   (runs this as the final stage)
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const {
  OUTPUT_DIR,
  DEFAULT_GROUP,
} = require('./lib/session-paths');
const { formatTime } = require('./lib/format');
const { isOpenProblem, collectSessions } = require('./lib/export-common');

/**
 * Builds the multi-sheet workbook for a set of sessions.
 *
 * @param {Array<{group: string, sessionDate: string, data: object}>} sessions
 * @returns {import('xlsx').WorkBook}
 */
function buildWorkbook(sessions) {
  const problemsRows = [['#', 'Group', 'Session Date', 'Problem', 'Description', 'Feature Requested', 'Status', 'Raised By', 'Timestamp', 'Visual Confirmation', 'Verification']];
  const topicsRows = [['#', 'Group', 'Session Date', 'Topic', 'Description', 'Key Parameters', 'Example', 'Raised By']];
  const summaryRows = [['Group', 'Session Date', '# Topics', '# Problems', '# Feature Requests', '# Open Items', '# Verification Flags']];
  const actionRows = [['#', 'Group', 'Session Date', 'Problem', 'Feature Requested', 'Raised By', 'Status']];
  const gapsRows = [['#', 'Group', 'Session Date', 'Type', 'Detail', 'Reason']];

  let pN = 0, tN = 0, aN = 0, gN = 0;

  for (const { group, sessionDate, data } of sessions) {
    const problems = Array.isArray(data.problems) ? data.problems : [];
    const topics = Array.isArray(data.topics) ? data.topics : [];
    const verification = data.verification || {};
    const hallucinated = Array.isArray(verification.hallucinated) ? verification.hallucinated : [];
    const omitted = Array.isArray(verification.omitted) ? verification.omitted : [];

    for (const p of problems) {
      pN++;
      const open = isOpenProblem(p);
      const verifNote = [];
      if (hallucinated.length) verifNote.push(`${hallucinated.length} hallucination(s) flagged`);
      if (omitted.length) verifNote.push(`${omitted.length} omission(s) flagged`);
      problemsRows.push([
        pN,
        group,
        sessionDate,
        p.title || '',
        p.description || '',
        p.featureRequested || '',
        open ? 'Open' : 'Feature Requested',
        p.raisedBy || 'Unclear',
        p.timestampSeconds != null ? formatTime(p.timestampSeconds) : '',
        p.visionConfirmed || '',
        verifNote.join(', '),
      ]);
      if (!open) {
        aN++;
        actionRows.push([aN, group, sessionDate, p.title || '', p.featureRequested || '', p.raisedBy || 'Unclear', 'Feature Requested']);
      }
    }

    for (const t of topics) {
      tN++;
      topicsRows.push([tN, group, sessionDate, t.name || '', t.description || '', t.keyParameters || '', t.example || '', t.raisedBy || 'Unclear']);
    }

    const openCount = problems.filter(isOpenProblem).length;
    const reqCount = problems.length - openCount;
    const flagCount = hallucinated.length + omitted.length;
    summaryRows.push([group, sessionDate, topics.length, problems.length, reqCount, openCount, flagCount]);

    for (const h of hallucinated) {
      gN++;
      gapsRows.push([gN, group, sessionDate, 'Possible hallucination', h.claim || '', h.reason || '']);
    }
    for (const o of omitted) {
      gN++;
      gapsRows.push([gN, group, sessionDate, 'Possible omission', o.gist || '', o.timestampSeconds != null ? `~${formatTime(o.timestampSeconds)}` : '']);
    }
  }

  const wb = XLSX.utils.book_new();
  appendSheet(wb, 'Problems', problemsRows, [5, 22, 14, 45, 70, 50, 18, 14, 10, 70, 24]);
  appendSheet(wb, 'Topics', topicsRows, [5, 22, 14, 40, 70, 45, 35, 14]);
  appendSheet(wb, 'Summary', summaryRows, [22, 14, 10, 10, 18, 12, 20]);
  appendSheet(wb, 'Action Items', actionRows, [5, 22, 14, 45, 50, 14, 18]);
  appendSheet(wb, 'Gaps & Risks', gapsRows, [5, 22, 14, 26, 70, 55]);
  return wb;
}

function appendSheet(wb, name, rows, colWidths) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  if (colWidths) {
    ws['!cols'] = colWidths.map((wch) => ({ wch }));
  }
  XLSX.utils.book_append_sheet(wb, ws, name);
}

async function main() {
  logger.info('============================================================');
  logger.info(' Excel Export — structured meeting notes (replaces master rollup)');
  logger.info('============================================================');

  const sessions = collectSessions();
  if (sessions.length === 0) {
    logger.error('[error] No sessions with structured data found under output/.');
    logger.error('  Run npm run meeting-notes (or the full pipeline) first.');
    process.exit(1);
  }

  logger.info(`[xlsx] ${sessions.length} session(s) found. Building workbook...\n`);

  // Only explicit folder-derived groups get a consolidated workbook. The
  // default "ungrouped" bucket is skipped entirely — those are unrelated
  // one-off calls and must never be merged into a single notes file.
  const groups = [...new Set(sessions.map((s) => s.group))].filter((g) => g !== DEFAULT_GROUP).sort();

  if (groups.length === 0) {
    logger.info('[xlsx] No explicit groups to export (all sessions are ungrouped). Nothing to do.');
    return;
  }

  for (const group of groups) {
    const groupSessions = sessions.filter((s) => s.group === group);
    const groupWb = buildWorkbook(groupSessions);
    const groupDir = path.join(OUTPUT_DIR, group);
    if (!fs.existsSync(groupDir)) fs.mkdirSync(groupDir, { recursive: true });
    const groupPath = path.join(groupDir, `${group}-meeting-notes.xlsx`);
    XLSX.writeFile(groupWb, groupPath);
    logger.info(`[xlsx] ✓  Group       → ${groupPath} (${groupSessions.length} session(s))`);
  }

  logger.info('\n============================================================');
  logger.info(' Done. Open the .xlsx in Excel/Sheets and filter by Group,');
  logger.info(' Status, or Raised By. See the "Gaps & Risks" sheet for any');
  logger.info(' points flagged for human review.');
  logger.info('============================================================\n');
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('\n[fatal error]', err.message || err);
    process.exit(1);
  });
}

module.exports = { main, buildWorkbook };

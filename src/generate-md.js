'use strict';
const logger = require('./lib/logger');

/**
 * generate-md.js — the `--format md` fallback export.
 *
 * Renders every session's structured notes (session-data.json) as markdown
 * consolidations, mirroring generate-xlsx.js sheet-by-sheet:
 *
 *   output/<group>/<group>-meeting-notes.md      (per group)
 *
 *   There is deliberately NO all-sessions combined file anymore. Only explicit
 *   folder-derived groups (sub-folders of input/) produce a consolidation; the
 *   default "ungrouped" bucket is skipped so unrelated one-off calls are never
 *   merged into a single notes file.
 *
 * This is a PURE TEMPLATE render of session-data.json — no LLM call, so it
 * can never silently drop content the way the old DeepSeek master rollup
 * could. The default format is xlsx (generate-xlsx.js); md is the fallback.
 *
 * Usage:
 *   node src/generate-md.js
 *   node src/pipeline.js --format md
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {
  OUTPUT_DIR,
  DEFAULT_GROUP,
} = require('./lib/session-paths');
const { formatTime } = require('./lib/format');
const { isOpenProblem, collectSessions } = require('./lib/export-common');

function renderMarkdown(sessions) {
  const out = [];
  out.push('# Meeting Notes — Structured Rollup');
  out.push('');
  out.push("> Generated from each session's session-data.json. This file is a template");
  out.push('> render — it lists every topic, problem, action item, and gap that was');
  out.push('> extracted. Replace "Speaker N" with real names as needed.');
  out.push('');

  const groups = [...new Set(sessions.map((s) => s.group))].sort();

  if (groups.length === 0) {
    out.push('_No sessions with structured data found._');
    return out.join('\n');
  }

  for (const group of groups) {
    const groupSessions = sessions.filter((s) => s.group === group);
    out.push(`## ${group}`);
    out.push('');

    for (const { sessionDate, data } of groupSessions) {
      out.push(`### Session — ${sessionDate}`);
      out.push('');
      if (data.summary) out.push(`${data.summary}\n`);

      const problems = Array.isArray(data.problems) ? data.problems : [];
      const topics = Array.isArray(data.topics) ? data.topics : [];
      const verification = data.verification || {};
      const hallucinated = Array.isArray(verification.hallucinated) ? verification.hallucinated : [];
      const omitted = Array.isArray(verification.omitted) ? verification.omitted : [];

      if (topics.length > 0) {
        out.push(`**Topics (${topics.length})**`);
        for (const t of topics) {
          out.push(`- **${t.name || '(unnamed)'}** — ${t.description || ''}${t.keyParameters ? ` _Key parameters: ${t.keyParameters}_` : ''}${t.raisedBy ? ` _(raised by ${t.raisedBy})_` : ''}`);
        }
        out.push('');
      }

      if (problems.length > 0) {
        out.push(`**Problems (${problems.length})**`);
        for (const p of problems) {
          const open = isOpenProblem(p);
          const status = open ? 'Open' : 'Feature requested';
          const checkbox = open ? '[ ]' : '[x]';
          out.push(`- ${checkbox} **${p.title || '(untitled)'}** — ${p.description || ''}`);
          if (p.featureRequested) out.push(`  - _Feature requested:_ ${p.featureRequested}`);
          out.push(`  - _Status:_ ${status} · _Raised by:_ ${p.raisedBy || 'Unclear'}${p.timestampSeconds != null ? ` · _at:_ ${formatTime(p.timestampSeconds)}` : ''}`);
          if (p.visionConfirmed) out.push(`  - _Visual confirmation:_ ${p.visionConfirmed}`);
        }
        out.push('');
      }

      if (hallucinated.length > 0 || omitted.length > 0) {
        out.push(`**Gaps & Risks**`);
        for (const h of hallucinated) out.push(`- ⚠ Possible hallucination: ${h.claim || ''}${h.reason ? ` (${h.reason})` : ''}`);
        for (const o of omitted) out.push(`- ⚠ Possible omission: ${o.gist || ''}${o.timestampSeconds != null ? ` (~${formatTime(o.timestampSeconds)})` : ''}`);
        out.push('');
      }
    }
  }

  return out.join('\n');
}

async function main() {
  logger.info('============================================================');
  logger.info(' Markdown Export — structured meeting notes (template render)');
  logger.info('============================================================');

  const sessions = collectSessions();
  if (sessions.length === 0) {
    logger.error('[error] No sessions with structured data found under output/.');
    logger.error('  Run npm run meeting-notes (or the full pipeline) first.');
    process.exit(1);
  }

  logger.info(`[md] ${sessions.length} session(s) found. Building markdown...\n`);

  // Only explicit folder-derived groups get a consolidated markdown file. The
  // default "ungrouped" bucket is skipped entirely — those are unrelated
  // one-off calls and must never be merged into a single notes file.
  const groups = [...new Set(sessions.map((s) => s.group))].filter((g) => g !== DEFAULT_GROUP).sort();

  if (groups.length === 0) {
    logger.info('[md] No explicit groups to export (all sessions are ungrouped). Nothing to do.');
    return;
  }

  for (const group of groups) {
    const groupSessions = sessions.filter((s) => s.group === group);
    const groupDir = path.join(OUTPUT_DIR, group);
    if (!fs.existsSync(groupDir)) fs.mkdirSync(groupDir, { recursive: true });
    const groupPath = path.join(groupDir, `${group}-meeting-notes.md`);
    fs.writeFileSync(groupPath, renderMarkdown(groupSessions), 'utf8');
    logger.info(`[md] ✓  Group       → ${groupPath} (${groupSessions.length} session(s))`);
  }

  logger.info('\n============================================================');
  logger.info(' Done. Replace "Speaker N" placeholders with real names as needed.');
  logger.info('============================================================\n');
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('\n[fatal error]', err.message || err);
    process.exit(1);
  });
}

module.exports = { main, renderMarkdown };

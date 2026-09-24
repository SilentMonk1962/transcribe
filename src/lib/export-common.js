'use strict';

/**
 * export-common.js — shared session collection + helpers for the two
 * template exporters (generate-xlsx.js and generate-md.js).
 *
 * WHY THIS EXISTS (2026-08-14 refactor):
 *   Both exporters previously maintained identical copies of collectSessions()
 *   and isOpenProblem(). If they ever diverged (e.g. one dropping a session
 *   the other kept), the .xlsx and .md deliverables would silently disagree
 *   on what a run produced. They now share this one implementation.
 */

const {
  listAllGroups,
  listSessionsInGroup,
  formatSessionDate,
  extractSessionId,
} = require('./session-paths');
const { readSessionData } = require('./session-data');

/** A problem is "open" when no feature/solution was discussed for it. */
function isOpenProblem(p) {
  return p.status === 'open';
}

/**
 * Walks every group/session and pulls the structured data for each session
 * that has any (from session-data.json, or derived from draft.md).
 *
 * @returns {Array<{group: string, sessionId: string, sessionDate: string, data: object}>}
 */
function collectSessions() {
  const sessions = [];
  for (const group of listAllGroups()) {
    for (const sessionId of listSessionsInGroup(group)) {
      const data = readSessionData(group, sessionId);
      if (!data) continue;
      const extractedId = extractSessionId(sessionId);
      const sessionDate = extractedId ? formatSessionDate(extractedId) : sessionId;
      sessions.push({ group, sessionId, sessionDate, data });
    }
  }
  return sessions;
}

module.exports = { isOpenProblem, collectSessions };
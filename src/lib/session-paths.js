'use strict';

/**
 * session-paths.js — single source of truth for group + session resolution.
 *
 * WHY THIS FILE EXISTS:
 *   Every stage script (convert, transcribe, pure-english, meeting-notes) used
 *   to write into a flat output/<stage>/ directory keyed only by filename.
 *   We are moving to a per-session layout so unrelated recordings — even
 *   within the same group — get their own isolated folder:
 *
 *     output/
 *       <group>/
 *         <session-id>/
 *           transcripts/{codemix,translate,pure-english}/   (per-mode, same
 *                                                             file naming as before)
 *           screenshots/   (vision-assist Stage 3 targeted frames — src/vision-capture.js)
 *           captions/      (vision-assist Stage 4 per-frame captions — src/vision-caption.js)
 *           notes/         draft.md (Stage 2, meeting-notes.js) + flags.json,
 *                                     session-data.json (Stage 2, structured —
 *                                     feeds the XLSX export) + verification.json
 *                                     (Stage 2.5) + final.md (Stage 5, vision-patch.js)
 *         session-links.json        (same-day merge decisions, see below)
 *
 *   Group resolution and same-day collision handling live in
 *   session-links.js (split out 2026-08-14 — see the re-export below);
 *   EVERY stage script imports THIS module and gets both. A prior version
 *   of this project (the now-deleted Electron app) duplicated this exact
 *   logic across files and that duplication caused bugs. Do not repeat.
 *
 * SESSION-ID:
 *   The raw timestamp already embedded in the recording filename, e.g.
 *   "20260708_110318" extracted from
 *   "KYC _FIgma _UI Testing-20260708_110318-Meeting Recording.mp3".
 *   No reformatting — it's already unique and sortable as a string.
 *
 * SAME-DAY COLLISION HANDLING:
 *   Before a new session-id is treated as its own session, we check whether
 *   another session already known in that group shares the same calendar
 *   date (first 8 characters of the session-id: YYYYMMDD). If so, and no
 *   cached decision exists yet in session-links.json, we prompt interactively
 *   via readline: "same session or separate? [S/P] (default: separate)".
 *   The decision is persisted so re-runs never re-ask. Non-interactive runs
 *   (stdin not a TTY) always default to SEPARATE — this matches the stated
 *   default ("usually one video is only for one session").
 */

const fs = require('fs');
const path = require('path');
const { config } = require('./config');
// Group resolution + session-links.json machinery lives in session-links.js
// (moved 2026-08-14 so this module stays focused on paths + discovery). We
// re-export its names below so existing call sites keep working unchanged.
const sessionLinks = require('./session-links');

const OUTPUT_DIR = config.outputDir();

// The catch-all bucket. Recordings that are NOT inside a sub-folder of input/
// (see convert.js) fall here and are ALWAYS kept as isolated per-session
// folders — they are never merged into a consolidated notes file (see
// generate-xlsx.js / generate-md.js).
const DEFAULT_GROUP = config.defaultGroup();

// ─── Directory helper ─────────────────────────────────────────────────────────

/**
 * Creates `dir` (and any missing parents) if it doesn't already exist.
 * @param {string} dir
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Path resolvers ─────────────────────────────────────────────────────────────

function groupDir(group) {
  return path.join(OUTPUT_DIR, group);
}
function sessionDir(group, sessionId) {
  return path.join(groupDir(group), sessionId);
}
function transcriptsDir(group, sessionId) {
  return path.join(sessionDir(group, sessionId), 'transcripts');
}
/** @param {'codemix'|'translate'|'pure-english'} mode */
function transcriptsModeDir(group, sessionId, mode) {
  return path.join(transcriptsDir(group, sessionId), mode);
}
function screenshotsDir(group, sessionId) {
  return path.join(sessionDir(group, sessionId), 'screenshots');
}
function captionsDir(group, sessionId) {
  return path.join(sessionDir(group, sessionId), 'captions');
}
function notesDir(group, sessionId) {
  return path.join(sessionDir(group, sessionId), 'notes');
}
/** Stage 2a cache — chronological topic mentions, feeds Stage 2b's merge step. */
function topicIndexPath(group, sessionId) {
  return path.join(notesDir(group, sessionId), 'topic-index.json');
}
/** Stage 2.5 output — advisory hallucination/omission report, never auto-applied. */
function verificationPath(group, sessionId) {
  return path.join(notesDir(group, sessionId), 'verification.json');
}
/**
 * Stage 2 structured data — machine-readable topics/problems/summary that
 * powers the XLSX export (src/generate-xlsx.js). Written by meeting-notes.js
 * (Stage 2), updated by vision-patch.js (Stage 5) with visual confirmations
 * and verification results.
 */
function sessionDataPath(group, sessionId) {
  return path.join(notesDir(group, sessionId), 'session-data.json');
}

/**
 * All group slugs currently present under output/ (directories only —
 * excludes any stray files).
 * @returns {string[]}
 */
function listAllGroups() {
  if (!fs.existsSync(OUTPUT_DIR)) return [];
  return fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * All session-id directories present under a given group.
 * @param {string} group
 * @returns {string[]}
 */
function listSessionsInGroup(group) {
  const dir = groupDir(group);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * Every session on disk across all groups, as {group, sessionId} pairs.
 * Replaces the identical double-loop that used to be copy-pasted in
 * vision-capture.js, vision-caption.js and vision-patch.js.
 * @returns {Array<{group: string, sessionId: string}>}
 */
function listAllSessions() {
  const sessions = [];
  for (const group of listAllGroups()) {
    for (const sessionId of listSessionsInGroup(group)) {
      sessions.push({ group, sessionId });
    }
  }
  return sessions;
}

/**
 * Walks output/<group>/<session-id>/transcripts/pure-english/*.txt across
 * every group and session on disk. Single source of truth for "what pure
 * English transcripts exist, and which group/session do they belong to" —
 * used by both meeting-notes.js (Stage 2) and verify-notes.js (Stage 2.5) so
 * this discovery loop isn't duplicated a second time.
 *
 * @returns {Array<{txtPath: string, group: string, sessionId: string}>}
 */
function listPureEnglishTranscripts() {
  const results = [];
  for (const group of listAllGroups()) {
    for (const sessionId of listSessionsInGroup(group)) {
      const peDir = transcriptsModeDir(group, sessionId, 'pure-english');
      if (!fs.existsSync(peDir)) continue;
      const txtFiles = fs.readdirSync(peDir)
        .filter((f) => f.endsWith('-pure-english.txt'))
        .sort();
      for (const f of txtFiles) {
        results.push({ txtPath: path.join(peDir, f), group, sessionId });
      }
    }
  }
  return results;
}

module.exports = {
  OUTPUT_DIR,
  DEFAULT_GROUP,
  ensureDir,
  groupDir,
  sessionDir,
  transcriptsDir,
  transcriptsModeDir,
  screenshotsDir,
  captionsDir,
  notesDir,
  topicIndexPath,
  verificationPath,
  sessionDataPath,
  listAllGroups,
  listSessionsInGroup,
  listAllSessions,
  listPureEnglishTranscripts,
  // Re-exported from session-links.js (kept for backward compatibility —
  // see the require at the top of this file).
  ...sessionLinks,
};

'use strict';

/**
 * session-paths.js — single source of truth for group + session resolution.
 *
 * WHY THIS FILE EXISTS:
 *   Every stage script (convert, transcribe, merge-chunks, context-*) used
 *   to write into a flat output/<stage>/ directory keyed only by filename.
 *   We are moving to a per-session layout so unrelated recordings — even
 *   within the same group — get their own isolated folder:
 *
 *     output/
 *       <group>/
 *         <session-id>/
 *           <recording>-contextual.txt     FINAL deliverable — English transcript
 *                                          with [SCREEN @ MM:SS] context inlined
 *                                          (src/context-inject.js). After a
 *                                          successful run this is the ONLY file
 *                                          left in the session folder.
 *           transcripts/translate/         INTERMEDIATE — Sarvam English JSON
 *                                          (+ per-chunk parts). Deleted by
 *                                          context-inject once the final exists.
 *           _work/<recording>/             INTERMEDIATE — screen-context work:
 *             scan.json                    stage 4 (src/context-scan.js)
 *             frames/*.jpg + manifest.json stage 5 (src/frame-capture.js)
 *             descriptions.json            stage 6 (src/frame-describe.js)
 *                                          Deleted by context-inject.
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
// folders.
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
/** @param {'translate'} mode — the only Sarvam pass the pipeline runs. */
function transcriptsModeDir(group, sessionId, mode) {
  return path.join(transcriptsDir(group, sessionId), mode);
}
/**
 * Per-recording scratch folder for the screen-context stages (4–6). Keyed by
 * recording base name because one session can hold several recordings
 * (same-day "same session" merges, see session-links.js).
 */
function workDir(group, sessionId, baseName) {
  return path.join(sessionDir(group, sessionId), '_work', baseName);
}
/** Stage 4 output — lines that need screen context. */
function scanPath(group, sessionId, baseName) {
  return path.join(workDir(group, sessionId, baseName), 'scan.json');
}
/** Stage 5 output folder — extracted frames + manifest.json. */
function framesDir(group, sessionId, baseName) {
  return path.join(workDir(group, sessionId, baseName), 'frames');
}
/** Stage 6 output — one pen-picture description per captured frame. */
function descriptionsPath(group, sessionId, baseName) {
  return path.join(workDir(group, sessionId, baseName), 'descriptions.json');
}
/** FINAL deliverable — the contextual transcript (stage 7). */
function contextualTranscriptPath(group, sessionId, baseName) {
  return path.join(sessionDir(group, sessionId), `${baseName}-contextual.txt`);
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
 * the per-stage discovery loops.
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

// Chunk transcripts (<name>__partNN.json) live next to the merged file —
// they are merge-chunks.js inputs, never recordings in their own right.
const CHUNK_PART_REGEX = /__part\d+$/;

/**
 * Every recording with a finished (merged) English transcript on disk, as
 * {group, sessionId, baseName, jsonPath}. Single discovery loop for stages
 * 4–7 so none of them re-implements it.
 *
 * @returns {Array<{group: string, sessionId: string, baseName: string, jsonPath: string}>}
 */
function listTranslatedRecordings() {
  const results = [];
  for (const { group, sessionId } of listAllSessions()) {
    const dir = transcriptsModeDir(group, sessionId, 'translate');
    if (!fs.existsSync(dir)) continue;
    const baseNames = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.basename(f, '.json'))
      .filter((b) => !CHUNK_PART_REGEX.test(b))
      .sort();
    for (const baseName of baseNames) {
      results.push({ group, sessionId, baseName, jsonPath: path.join(dir, `${baseName}.json`) });
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
  workDir,
  scanPath,
  framesDir,
  descriptionsPath,
  contextualTranscriptPath,
  listAllGroups,
  listSessionsInGroup,
  listAllSessions,
  listTranslatedRecordings,
  // Re-exported from session-links.js (kept for backward compatibility —
  // see the require at the top of this file).
  ...sessionLinks,
};

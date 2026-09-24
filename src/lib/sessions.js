'use strict';
const logger = require('./logger');

/**
 * sessions.js — output layout, group/session resolution and recording
 * discovery. Every stage imports this one module.
 *
 * LAYOUT:
 *   output/<group>/
 *     session-links.json                 same-day merge decisions (below)
 *     <session-id>/
 *       <recording>-contextual.txt       FINAL — the only file left when done
 *       transcripts/translate/           intermediate Sarvam JSON (+ chunk parts)
 *       _work/<recording>/               intermediate screen-context work
 *
 * GROUP = the sub-folder of input/ the video sits in (input/kyc/x.mp4 → "kyc").
 * Videos at the input/ root go to DEFAULT_GROUP ("ungrouped").
 *
 * SESSION-ID = the timestamp inside the recording filename, e.g.
 * "…-20260708_110318-Meeting Recording" → "20260708_110318" (whole filename
 * when there is none).
 *
 * SAME-DAY MERGE: a new recording from the same calendar day as a session
 * already in its group triggers one prompt — "same session or separate?"
 * (non-interactive runs default to separate). The answer is saved in
 * session-links.json, so no stage or later run asks again.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { config, ensureDir } = require('./config');

const OUTPUT_DIR = config.outputDir();
const DEFAULT_GROUP = config.defaultGroup();
const SESSION_ID_REGEX = /(\d{8}_\d{6})/;
// Chunk transcripts (<name>__partNN.json) are merge inputs, never recordings.
const CHUNK_PART_REGEX = /__part\d+$/;

// ─── Paths ────────────────────────────────────────────────────────────────────

const groupDir = (group) => path.join(OUTPUT_DIR, group);
const sessionDir = (group, sessionId) => path.join(groupDir(group), sessionId);
const transcriptsDir = (group, sessionId) => path.join(sessionDir(group, sessionId), 'transcripts');
/** Sarvam English JSON lives here until the final transcript is written. */
const translateDir = (group, sessionId) => path.join(transcriptsDir(group, sessionId), 'translate');
/** Per-recording scratch folder for the context stage (scan, frames, descriptions). */
const workDir = (group, sessionId, baseName) => path.join(sessionDir(group, sessionId), '_work', baseName);
/** FINAL deliverable. */
const contextualTranscriptPath = (group, sessionId, baseName) =>
  path.join(sessionDir(group, sessionId), `${baseName}-contextual.txt`);

// ─── Session-id helpers ───────────────────────────────────────────────────────

function extractSessionId(baseName) {
  const m = baseName.match(SESSION_ID_REGEX);
  return m ? m[1] : null;
}

// ─── session-links.json (cached per process; writes go through the cache) ────

const linksCache = new Map();

function loadSessionLinks(group) {
  if (linksCache.has(group)) return linksCache.get(group);
  const p = path.join(groupDir(group), 'session-links.json');
  let links = {};
  if (fs.existsSync(p)) {
    try {
      links = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      logger.warn(`[warn] Could not parse ${p}: ${err.message}. Treating as empty.`);
    }
  }
  linksCache.set(group, links);
  return links;
}

function saveSessionLinks(group, links) {
  ensureDir(groupDir(group));
  fs.writeFileSync(path.join(groupDir(group), 'session-links.json'), JSON.stringify(links, null, 2), 'utf8');
  linksCache.set(group, links);
}

/** Follows mergedInto pointers to the final session-id (cycle-safe). */
function resolveEffectiveId(id, links) {
  let current = id;
  const seen = new Set();
  while (links[current]?.mergedInto && !seen.has(current)) {
    seen.add(current);
    current = links[current].mergedInto;
  }
  return current;
}

/** All group slugs under output/. */
function listAllGroups() {
  if (!fs.existsSync(OUTPUT_DIR)) return [];
  return fs.readdirSync(OUTPUT_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

/** The group whose session-links.json already holds this session-id, or null. */
function findGroupForSessionId(sessionId) {
  return listAllGroups().find((g) => loadSessionLinks(g)[sessionId]) || null;
}

function promptSameDay(newId, existingId, group) {
  if (!process.stdin.isTTY) {
    logger.info(`[session] ${newId} is same-day as ${existingId} in "${group}" — non-interactive, keeping SEPARATE.`);
    return Promise.resolve('separate');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(
      `[session] Recording ${newId} is from the same day as session ${existingId} in "${group}" — ` +
      'same session or separate? [S/P] (default: separate) ',
      (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === 's' ? 'same' : 'separate');
      }
    );
  });
}

/**
 * READ-ONLY lookup — never prompts, never writes. Used by the pre-run status
 * check and budget, which must not trigger the same-day question.
 *
 * @param {string} baseName
 * @param {string} group
 * @returns {{group: string, sessionId: string, effectiveSessionId: string}}
 */
function peekSession(baseName, group) {
  const sessionId = extractSessionId(baseName) || baseName;
  const links = loadSessionLinks(group);
  return { group, sessionId, effectiveSessionId: links[sessionId] ? resolveEffectiveId(sessionId, links) : sessionId };
}

/**
 * Resolves (and persists) a recording's group + effective session-id.
 * Group priority: explicitGroup (convert.js, from the folder) → group already
 * persisted for this session-id → DEFAULT_GROUP.
 *
 * @param {string} baseName
 * @param {{explicitGroup?: string}} [opts]
 * @returns {Promise<{group: string, sessionId: string, effectiveSessionId: string}>}
 */
async function resolveSession(baseName, opts = {}) {
  const raw = extractSessionId(baseName);
  const sessionId = raw || baseName;
  const group = opts.explicitGroup || findGroupForSessionId(sessionId) || DEFAULT_GROUP;
  const links = loadSessionLinks(group);

  if (links[sessionId]) {
    return { group, sessionId, effectiveSessionId: resolveEffectiveId(sessionId, links) };
  }

  const save = (entry, effectiveSessionId) => {
    links[sessionId] = { group, ...entry };
    saveSessionLinks(group, links);
    return { group, sessionId, effectiveSessionId };
  };

  // No timestamp → no date to compare → always its own session.
  if (!raw) return save({ separate: true }, sessionId);

  // Same-day collision with a known session in this group?
  const known = new Set(Object.keys(links));
  if (fs.existsSync(groupDir(group))) {
    for (const d of fs.readdirSync(groupDir(group), { withFileTypes: true })) {
      if (d.isDirectory() && SESSION_ID_REGEX.test(d.name)) known.add(d.name);
    }
  }
  const collision = [...known].find((id) => id !== sessionId && extractSessionId(id) && id.slice(0, 8) === sessionId.slice(0, 8));
  if (!collision) return save({ separate: true }, sessionId);

  const target = resolveEffectiveId(collision, links);
  return (await promptSameDay(sessionId, target, group)) === 'same'
    ? save({ mergedInto: target }, target)
    : save({ separate: true }, sessionId);
}

// ─── Discovery ────────────────────────────────────────────────────────────────

/**
 * Every recording with a finished (merged) English transcript on disk.
 * @returns {Array<{group: string, sessionId: string, baseName: string, jsonPath: string}>}
 */
function listTranslatedRecordings() {
  const out = [];
  for (const group of listAllGroups()) {
    for (const d of fs.readdirSync(groupDir(group), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = translateDir(group, d.name);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).sort()) {
        const baseName = path.basename(f, '.json');
        if (!f.endsWith('.json') || CHUNK_PART_REGEX.test(baseName)) continue;
        out.push({ group, sessionId: d.name, baseName, jsonPath: path.join(dir, f) });
      }
    }
  }
  return out;
}

module.exports = {
  OUTPUT_DIR,
  DEFAULT_GROUP,
  sessionDir,
  transcriptsDir,
  translateDir,
  workDir,
  contextualTranscriptPath,
  extractSessionId,
  peekSession,
  resolveSession,
  listTranslatedRecordings,
};

'use strict';
const logger = require('./logger');

/**
 * session-links.js — group resolution + same-day merge decisions.
 *
 * WHY THIS EXISTS (2026-08-14 refactor):
 *   These used to live inside session-paths.js, which had grown into a
 *   470-line god module covering three unrelated concerns: (1) path
 *   resolvers for the output tree, (2) session discovery, and (3) the
 *   session-links.json state machine. Concern (3) is now its own module.
 *
 *   Everything here depends only on config.js — it never imports
 *   session-paths.js — so the dependency direction is one-way:
 *   session-paths.js re-exports these names for backward compatibility
 *   (call sites keep doing require('./lib/session-paths')).
 *
 *   The core contract: resolveSession() is called once per recording by the
 *   FIRST stage that sees it (convert.js, with the folder-derived group).
 *   That decision is persisted to output/<group>/session-links.json, so all
 *   later stages (transcribe, merge-chunks, context-*, …) calling
 *   resolveSession() with only the filename get the exact same group and
 *   effective session-id without re-prompting.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { config, ensureDir, PROJECT_ROOT } = require('./config');

const OUTPUT_DIR = config.outputDir();
const GROUPS_CONFIG_PATH = path.join(PROJECT_ROOT, 'groups.config.json');

// Matches the raw timestamp embedded in recording filenames, e.g. "20260708_110318".
const SESSION_ID_REGEX = /(\d{8}_\d{6})/;

// ─── Grouping (see session-paths.js header) ─

/**
 * Loads groups.config.json. Falls back to a single "ungrouped" bucket for
 * everything if the config file is missing, so the tool never crashes.
 *
 * Memoized per run: the file cannot change mid-run, and resolveSession()
 * calls this once per recording — previously that meant re-reading and
 * re-parsing groups.config.json for EVERY file of EVERY stage.
 *
 * @returns {{rules: Array<{match: string, group: string}>, default: string}}
 */
let groupConfigCache = null;
function loadGroupConfig() {
  if (groupConfigCache) return groupConfigCache;
  if (!fs.existsSync(GROUPS_CONFIG_PATH)) {
    logger.warn(`[warn] groups.config.json not found at ${GROUPS_CONFIG_PATH}`);
    logger.warn('       All recordings will fall into a single "ungrouped" bucket.');
    groupConfigCache = { rules: [], default: 'ungrouped' };
    return groupConfigCache;
  }
  const parsed = JSON.parse(fs.readFileSync(GROUPS_CONFIG_PATH, 'utf8'));
  groupConfigCache = { rules: parsed.rules || [], default: parsed.default || 'ungrouped' };
  return groupConfigCache;
}

/**
 * Resolves which group a recording belongs to by matching its filename
 * against groups.config.json rules, in order — first match wins.
 *
 * @param {string} baseName    - Recording filename (without extension)
 * @param {object} groupConfig - Result of loadGroupConfig()
 * @returns {string} group slug, e.g. "application-journey-revamp"
 */
function resolveGroup(baseName, groupConfig) {
  const lower = baseName.toLowerCase();
  for (const rule of groupConfig.rules) {
    if (rule.match && lower.includes(rule.match.toLowerCase())) {
      return rule.group;
    }
  }
  return groupConfig.default;
}

/**
 * Turns a group slug into a readable title.
 * Example: "application-journey-revamp" -> "Application Journey Revamp"
 * @param {string} group
 * @returns {string}
 */
function humanizeGroup(group) {
  return group
    .split('-')
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// ─── Session-id extraction ─────────────────────────────────────────────────────

/**
 * Extracts the raw timestamp session-id from a recording's base filename.
 * @param {string} baseName - filename without extension
 * @returns {string|null} e.g. "20260708_110318", or null if not found
 */
function extractSessionId(baseName) {
  const m = baseName.match(SESSION_ID_REGEX);
  return m ? m[1] : null;
}

/**
 * @param {string} sessionId - e.g. "20260708_110318"
 * @returns {string} calendar date only, e.g. "20260708"
 */
function sessionDateOnly(sessionId) {
  return sessionId.slice(0, 8);
}

/**
 * @param {string} sessionId - e.g. "20260708_110318"
 * @returns {string} human-readable date, e.g. "2026-07-08"
 */
function formatSessionDate(sessionId) {
  const d = sessionDateOnly(sessionId);
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

// ─── session-links.json (same-day merge decisions) ────────────────────────────

function sessionLinksPath(group) {
  return path.join(OUTPUT_DIR, group, 'session-links.json');
}

/**
 * Per-run cache of output/<group>/session-links.json. WHY (2026-08-14
 * efficiency pass): resolveSession() calls findGroupForSessionId() once per
 * recording, and that scans EVERY group's links file — so with G groups and
 * N files, each stage run used to parse the same JSON G×N times. The file
 * only changes through saveSessionLinks() (same process), so caching it for
 * the life of the run is safe and turns the whole group-scan into O(G) reads
 * total. Note this cache is per-PROCESS: each stage script is its own
 * process, so nothing ever goes stale across stages.
 */
const linksCache = new Map(); // group -> parsed links object

function loadSessionLinks(group) {
  if (linksCache.has(group)) return linksCache.get(group);
  const p = sessionLinksPath(group);
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
  ensureDir(path.join(OUTPUT_DIR, group));
  fs.writeFileSync(sessionLinksPath(group), JSON.stringify(links, null, 2), 'utf8');
  // Write-through to the per-run cache so later loadSessionLinks() calls in
  // this same run (and the same-run resolveSession() for other files) see
  // the freshly-persisted decisions immediately.
  linksCache.set(group, links);
}

/**
 * Follows a chain of mergedInto pointers to the ultimate target session-id.
 * Guards against cycles (should never happen, but never loop forever).
 * @param {string} id
 * @param {object} links
 * @returns {string}
 */
function resolveEffectiveId(id, links) {
  let current = id;
  const seen = new Set();
  while (links[current] && links[current].mergedInto && !seen.has(current)) {
    seen.add(current);
    current = links[current].mergedInto;
  }
  return current;
}

/**
 * All session-ids known for a group — from session-links.json entries AND
 * from actual directories already on disk (a session can exist on disk
 * before session-links.json is written, or vice versa within one batch run).
 * @param {string} group
 * @returns {string[]}
 */
function listKnownSessionIds(group) {
  const groupDir = path.join(OUTPUT_DIR, group);
  const fromDirs = fs.existsSync(groupDir)
    ? fs.readdirSync(groupDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && SESSION_ID_REGEX.test(d.name))
        .map((d) => d.name)
    : [];
  const fromLinks = Object.keys(loadSessionLinks(group));
  return [...new Set([...fromDirs, ...fromLinks])];
}

/**
 * Prompts the user interactively about a same-day collision. Defaults to
 * "separate" (and logs why) when stdin is not a TTY — e.g. a scheduled or
 * otherwise non-interactive run.
 *
 * @param {string} newSessionId
 * @param {string} existingSessionId
 * @param {string} group
 * @returns {Promise<'same'|'separate'>}
 */
function promptSameDay(newSessionId, existingSessionId, group) {
  if (!process.stdin.isTTY) {
    logger.info(
      `[session] "${newSessionId}" is same-day as existing session "${existingSessionId}" ` +
      `in group "${group}" — non-interactive run, defaulting to SEPARATE.`
    );
    return Promise.resolve('separate');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(
      `[session] Recording ${newSessionId} is from the same day as existing session ` +
      `${existingSessionId} in group "${group}" — same session or separate? [S/P] (default: separate) `,
      (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === 's' ? 'same' : 'separate');
      }
    );
  });
}

/**
 * Searches EVERY group's session-links.json for a session-id and returns the
 * group whose links contain it, or null if not found anywhere.
 *
 * WHY THIS EXISTS: with folder-based grouping (see convert.js), the group for a
 * recording comes from the sub-folder it sits in — NOT from its filename. A
 * first-stage call to resolveSession() with { explicitGroup } persists that
 * group under output/<group>/session-links.json. But later stages (transcribe,
 * merge-chunks) call resolveSession() with only the filename and no folder, so
 * they need to locate which group's session-links file already holds this
 * session-id in order to honor the folder-derived group.
 *
 * @param {string} sessionId
 * @returns {string|null} the group slug whose session-links.json contains sessionId
 */
function findGroupForSessionId(sessionId) {
  if (!fs.existsSync(OUTPUT_DIR)) return null;
  const groups = fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const g of groups) {
    const links = loadSessionLinks(g);
    if (links[sessionId]) return g;
  }
  return null;
}

/**
 * Resolves the GROUP and EFFECTIVE SESSION-ID to write to for a recording.
 * Call this once per recording (any stage script can call it — the first
 * call for a given recording persists the decision to session-links.json,
 * so every later call, in later stages or later runs, returns the same
 * answer without re-prompting).
 *
 * GROUP RESOLUTION (in priority order):
 *   1. opts.explicitGroup — folder-derived group handed in by convert.js.
 *   2. A group already persisted in session-links.json for this session-id
 *      (found by scanning every group's session-links), honoring a previous
 *      folder-derived assignment.
 *   3. Legacy fallback: filename → groups.config.json matching. Only used when
 *      nothing is persisted yet (kept so previously-resolved data stays intact).
 *
 * The resolved/persisted entry now also records { group } so a later stage
 * calling without an explicit group can re-locate it via #2.
 *
 * @param {string} recordingBaseName - recording filename without extension
 * @param {{explicitGroup?: string}} [opts]
 * @returns {Promise<{group: string, sessionId: string, effectiveSessionId: string, hasTimestamp: boolean}>}
 */
async function resolveSession(recordingBaseName, opts = {}) {
  const { explicitGroup } = opts;
  const groupConfig = loadGroupConfig();

  const rawSessionId = extractSessionId(recordingBaseName);
  const hasTimestamp = rawSessionId !== null;
  // Fallback: recordings without an extractable timestamp still get a
  // deterministic session-id (the whole filename) so every recording gets a
  // folder — they just never participate in same-day collision detection,
  // since there's no date to compare.
  const sessionId = rawSessionId || recordingBaseName;

  // ── 1. Find which group owns this session already, if any ────────────────
  const persistedGroup = findGroupForSessionId(sessionId);

  let group;
  if (explicitGroup) {
    group = explicitGroup; // caller (convert.js) knows the folder-derived group
  } else if (persistedGroup) {
    group = persistedGroup; // honor a previously persisted folder assignment
  } else {
    group = resolveGroup(recordingBaseName, groupConfig); // legacy filename match
  }

  const links = loadSessionLinks(group);

  // ── Already resolved in a previous call/run ─────────────────────────────
  if (links[sessionId]) {
    const effectiveSessionId = links[sessionId].mergedInto
      ? resolveEffectiveId(sessionId, links)
      : sessionId;
    return { group, sessionId, effectiveSessionId, hasTimestamp };
  }

  // ── No timestamp to compare -> can't collide, always separate ──────────
  if (!hasTimestamp) {
    links[sessionId] = { group, separate: true };
    saveSessionLinks(group, links);
    return { group, sessionId, effectiveSessionId: sessionId, hasTimestamp };
  }

  const date = sessionDateOnly(sessionId);
  const known = listKnownSessionIds(group).filter((id) => id !== sessionId);
  const collisionRaw = known.find((id) => extractSessionId(id) && sessionDateOnly(id) === date);

  if (!collisionRaw) {
    links[sessionId] = { group, separate: true };
    saveSessionLinks(group, links);
    return { group, sessionId, effectiveSessionId: sessionId, hasTimestamp };
  }

  const collisionTarget = resolveEffectiveId(collisionRaw, links);
  const decision = await promptSameDay(sessionId, collisionTarget, group);

  if (decision === 'same') {
    links[sessionId] = { group, mergedInto: collisionTarget };
    saveSessionLinks(group, links);
    return { group, sessionId, effectiveSessionId: collisionTarget, hasTimestamp };
  }

  links[sessionId] = { group, separate: true };
  saveSessionLinks(group, links);
  return { group, sessionId, effectiveSessionId: sessionId, hasTimestamp };
}

module.exports = {
  loadGroupConfig,
  resolveGroup,
  humanizeGroup,
  extractSessionId,
  sessionDateOnly,
  formatSessionDate,
  sessionLinksPath,
  loadSessionLinks,
  saveSessionLinks,
  resolveEffectiveId,
  listKnownSessionIds,
  promptSameDay,
  findGroupForSessionId,
  resolveSession,
};
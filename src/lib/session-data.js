'use strict';
const logger = require('./logger');

/**
 * session-data.js — single source of truth for the structured per-session
 * data that powers the XLSX export (src/generate-xlsx.js).
 *
 * WHY THIS EXISTS:
 *   meeting-notes.js (Stage 2) writes draft.md (human-readable) AND a
 *   machine-readable session-data.json (topics/problems/summary with speaker
 *   attribution) from the same DeepSeek response. vision-patch.js (Stage 5)
 *   enriches it with visual confirmations and verification results.
 *   generate-xlsx.js reads it back. Centralizing the parsing/reading/writing
 *   here keeps the shape consistent across all three stages.
 *
 * RESILIENCE:
 *   - The model's structured block is parsed defensively — a missing or
 *     malformed block degrades to empty topics/problems rather than crashing.
 *   - If session-data.json is missing but draft.md exists (e.g. sessions
 *     created before this feature landed), parseDraftFallback() extracts what
 *     it can from the markdown so the XLSX still captures every problem/topic
 *     that was written down. Speaker attribution is "Unclear" in that path.
 */

const fs = require('fs');
const path = require('path');
const { notesDir, sessionDataPath, verificationPath } = require('./session-paths');

const STRUCTURED_DELIM_REGEX = /===STRUCTURED_DATA_START===([\s\S]*?)===STRUCTURED_DATA_END===/;

/** Sentinel used by the draft prompt when no feature was discussed. */
const OPEN_MARKER = 'Open — no feature discussed yet';

// ─── Structured block parsing (Stage 2b model output) ────────────────────────

function sanitizeTopic(t) {
  if (!t || typeof t.name !== 'string' || !t.name.trim()) return null;
  return {
    name: t.name.trim(),
    description: typeof t.description === 'string' ? t.description.trim() : '',
    keyParameters: typeof t.keyParameters === 'string' ? t.keyParameters.trim() : '',
    example: typeof t.example === 'string' ? t.example.trim() : '',
    raisedBy: typeof t.raisedBy === 'string' && t.raisedBy.trim() ? t.raisedBy.trim() : 'Unclear',
  };
}

function sanitizeProblem(p) {
  if (!p || typeof p.title !== 'string' || !p.title.trim()) return null;
  const featureRequested = typeof p.featureRequested === 'string' && p.featureRequested.trim()
    ? p.featureRequested.trim()
    : OPEN_MARKER;
  const looksOpen = featureRequested === OPEN_MARKER || featureRequested.toLowerCase().includes('no feature');
  return {
    problemNumber: Number.isFinite(Number(p.problemNumber)) ? Number(p.problemNumber) : null,
    title: p.title.trim(),
    description: typeof p.description === 'string' ? p.description.trim() : '',
    featureRequested,
    status: p.status === 'open' ? 'open' : p.status === 'requested' ? 'requested' : looksOpen ? 'open' : 'requested',
    raisedBy: typeof p.raisedBy === 'string' && p.raisedBy.trim() ? p.raisedBy.trim() : 'Unclear',
    timestampSeconds: Number.isFinite(Number(p.timestampSeconds)) ? Math.round(Number(p.timestampSeconds)) : null,
    visionCheck: typeof p.visionCheck === 'string' ? p.visionCheck.trim() : '',
    visionConfirmed: null,
  };
}

/**
 * Extracts the structured block from a full Stage 2b DeepSeek response.
 * Defensive: missing/malformed JSON degrades to empty structures.
 *
 * @param {string} rawResponse
 * @returns {{summary: string, topics: Array, problems: Array}}
 */
function parseStructuredData(rawResponse) {
  const match = (rawResponse || '').match(STRUCTURED_DELIM_REGEX);
  if (!match) {
    logger.warn('[warn] DeepSeek response had no STRUCTURED_DATA block — structured notes may be incomplete.');
    return { summary: '', topics: [], problems: [] };
  }

  let text = match[1].trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) text = fenceMatch[1].trim();

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger.warn(`[warn] Could not parse STRUCTURED_DATA JSON (${err.message}) — structured notes may be incomplete.`);
  }

  if (!parsed || typeof parsed !== 'object') return { summary: '', topics: [], problems: [] };

  const topics = Array.isArray(parsed.topics) ? parsed.topics.map(sanitizeTopic).filter(Boolean) : [];
  const problems = Array.isArray(parsed.problems) ? parsed.problems.map(sanitizeProblem).filter(Boolean) : [];
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';

  return { summary, topics, problems };
}

// ─── Draft markdown fallback parsing ─────────────────────────────────────────

/**
 * Extracts a single **Label:** field from a markdown section body.
 * @param {string} body
 * @param {string} label
 * @returns {string}
 */
function extractField(body, label) {
  const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*([^\\n]+)`);
  const m = (body || '').match(re);
  return m ? m[1].trim() : '';
}

/**
 * Parses a "(~MM:SS)" tail out of a Vision Check Requested line.
 * @param {string} visionCheck
 * @returns {number|null} whole seconds, or null
 */
function parseVisionTimestamp(visionCheck) {
  const m = (visionCheck || '').match(/~(\d{1,2}):(\d{2})/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return null;
}

/**
 * Best-effort extraction of topics/problems/summary from a Stage 2 draft.md,
 * used only when session-data.json is missing (pre-feature sessions).
 * Speaker attribution is not recoverable from markdown — set to "Unclear".
 *
 * @param {string} markdown
 * @returns {{summary: string, topics: Array, problems: Array}}
 */
function parseDraftFallback(markdown) {
  const topics = [];
  const problems = [];

  let summary = '';
  const summaryMatch = (markdown || '').match(/##\s*Summary\s*\n([\s\S]*?)(?:\n---\s*\n|\n===|\s*$)/);
  if (summaryMatch) summary = summaryMatch[1].trim();

  const topicRe = /###\s*Topic:\s*([^\n]+)([\s\S]*?)(?=\n###\s|\n##\s|$)/g;
  let tm;
  while ((tm = topicRe.exec(markdown || '')) !== null) {
    const body = tm[2] || '';
    topics.push({
      name: tm[1].trim(),
      description: extractField(body, 'What it is'),
      keyParameters: extractField(body, 'Key parameters mentioned'),
      example: extractField(body, 'Example/case study cited'),
      raisedBy: 'Unclear',
    });
  }

  const probRe = /###\s*Problem\s+\d+:\s*([^\n]+)([\s\S]*?)(?=\n###\s|\n##\s|$)/g;
  let pm;
  while ((pm = probRe.exec(markdown || '')) !== null) {
    const body = pm[2] || '';
    const featureRequested = extractField(body, 'Feature Requested') || OPEN_MARKER;
    const visionCheck = extractField(body, 'Vision Check Requested');
    problems.push({
      problemNumber: problems.length + 1,
      title: pm[1].trim(),
      description: extractField(body, 'Description'),
      featureRequested,
      status: featureRequested === OPEN_MARKER || featureRequested.toLowerCase().includes('no feature') ? 'open' : 'requested',
      raisedBy: 'Unclear',
      timestampSeconds: parseVisionTimestamp(visionCheck),
      visionCheck,
      visionConfirmed: null,
    });
  }

  return { summary, topics, problems };
}

// ─── Read / write helpers ─────────────────────────────────────────────────────

/**
 * Returns the full session-data object for a session, or null if there is
 * neither a session-data.json nor a draft.md to derive one from.
 * Falls back to parsing draft.md when session-data.json is absent/corrupt.
 *
 * @param {string} group
 * @param {string} sessionId
 * @returns {object|null}
 */
function readSessionData(group, sessionId) {
  const p = sessionDataPath(group, sessionId);
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      logger.warn(`  ⚠  Could not parse ${p} (${err.message}) — trying draft.md fallback.`);
    }
  }

  const draftPath = path.join(notesDir(group, sessionId), 'draft.md');
  if (fs.existsSync(draftPath)) {
    const parsed = parseDraftFallback(fs.readFileSync(draftPath, 'utf8'));
    return {
      group,
      sessionId,
      summary: parsed.summary,
      topics: parsed.topics,
      problems: parsed.problems,
      verification: { hallucinated: [], omitted: [] },
      fromDraftFallback: true,
    };
  }
  return null;
}

/**
 * Writes the session-data object to notes/session-data.json.
 *
 * @param {string} group
 * @param {string} sessionId
 * @param {object} data
 */
function writeSessionData(group, sessionId, data) {
  const p = sessionDataPath(group, sessionId);
  if (!fs.existsSync(path.dirname(p))) fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Merges notes/verification.json (Stage 2.5) into session-data.verification.
 * No-op if session-data.json or verification.json is missing.
 *
 * @param {string} group
 * @param {string} sessionId
 */
function mergeVerificationIntoSessionData(group, sessionId) {
  const p = sessionDataPath(group, sessionId);
  if (!fs.existsSync(p)) return;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return;
  }
  const vPath = verificationPath(group, sessionId);
  if (fs.existsSync(vPath)) {
    try {
      const v = JSON.parse(fs.readFileSync(vPath, 'utf8'));
      data.verification = { hallucinated: v.hallucinated || [], omitted: v.omitted || [] };
    } catch {
      /* leave existing verification as-is */
    }
  }
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Populates problem.visionConfirmed from Stage 4 captions, matched by
 * problemNumber. No-op if session-data.json is missing.
 *
 * @param {string} group
 * @param {string} sessionId
 * @param {Array<{problemNumber: number|null, caption: string}>} confirmed
 */
function applyVisualConfirmations(group, sessionId, confirmed) {
  const p = sessionDataPath(group, sessionId);
  if (!fs.existsSync(p)) return;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return;
  }

  const byNumber = new Map();
  for (const c of confirmed) {
    if (c.problemNumber != null) {
      if (!byNumber.has(c.problemNumber)) byNumber.set(c.problemNumber, []);
      byNumber.get(c.problemNumber).push(c.caption || '(empty caption)');
    }
  }

  for (const prob of data.problems || []) {
    if (prob.problemNumber != null && byNumber.has(prob.problemNumber)) {
      prob.visionConfirmed = byNumber.get(prob.problemNumber).join(' ');
    }
  }

  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = {
  OPEN_MARKER,
  parseStructuredData,
  parseDraftFallback,
  readSessionData,
  writeSessionData,
  mergeVerificationIntoSessionData,
  applyVisualConfirmations,
};

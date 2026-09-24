'use strict';
const logger = require('./lib/logger');

/**
 * verify-notes.js — Stage 2.5 of vision-assist (see HANDOVER.md for the full
 * stage design). Runs AFTER Stage 2's draft.md exists and BEFORE Stage 5
 * (vision-patch.js) builds final.md, so its findings can be surfaced there.
 *
 * WHY THIS EXISTS:
 *   User's explicit concern (2026-07-16): meeting transcripts are long, and
 *   there's no guarantee a single DeepSeek call over the whole thing neither
 *   invents content nor drops something genuinely raised. This stage is a
 *   SEPARATE, independent DeepSeek call whose only job is to re-read the full
 *   transcript against the Stage 2b draft and flag two failure modes:
 *     - HALLUCINATED: something stated in the draft that the transcript does
 *       not actually support.
 *     - OMITTED: a genuinely distinct problem/topic raised in the transcript
 *       that is missing entirely from the draft (not just worded differently).
 *   It is asked to be CONSERVATIVE — paraphrasing, summarizing, and merging
 *   repeated mentions (see Stage 2a/2b's topic-index merge step) are NOT
 *   hallucination. Only clear-cut mismatches get flagged, to keep this useful
 *   rather than noisy.
 *
 * PURELY ADVISORY — NEVER AUTO-EDITS:
 *   This stage only WRITES notes/verification.json. It never modifies
 *   draft.md or final.md itself. A human decides what (if anything) to do
 *   with a flagged finding. Stage 5 (vision-patch.js) appends a short note
 *   to final.md pointing at verification.json when there's something to
 *   check — it does not resolve the finding either.
 *
 * OUTPUT PER SESSION:
 *   output/<group>/<session-id>/notes/verification.json
 *     { generatedAt, hallucinated: [{claim, reason}], omitted: [{gist, timestampSeconds}] }
 *   Always written, even when both arrays are empty — an empty file is a
 *   completed check, not a missing one, so resume logic can tell them apart.
 *
 * RESUME LOGIC:
 *   A session is skipped if notes/draft.md doesn't exist yet (Stage 2 hasn't
 *   run) or if notes/verification.json already exists (already checked).
 *
 * CREDIT SAFETY:
 *   DeepSeek credit/quota errors are caught via the shared
 *   src/lib/credit-errors.js and shown as a clean, actionable message — no
 *   stack traces. Sessions already verified stay done.
 *
 * Usage:
 *   node src/verify-notes.js
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { config } = require('./lib/config');
const {
  notesDir,
  verificationPath,
  listPureEnglishTranscripts,
} = require('./lib/session-paths');
const { toCreditErrorOrNull } = require('./lib/credit-errors');
const { exitOnCreditExhaustion } = require('./lib/credit-runner');
const { createDeepSeekClient } = require('./lib/format');

const DEEPSEEK_KEY   = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = config.deepseekModel();

/**
 * Builds the verification prompt: full transcript + the Stage 2b draft,
 * asking DeepSeek to find only clear-cut hallucinations or omissions.
 * Deliberately conservative — explicitly tells the model that paraphrasing,
 * summarizing, and merging repeated mentions are NOT hallucination, so this
 * check doesn't flood the user with false positives on normal editorial work.
 *
 * @param {string} transcript     - Full pure-English transcript
 * @param {string} draftMarkdown  - Stage 2b draft.md content (flags block already stripped)
 * @returns {string}
 */
function buildVerificationPrompt(transcript, draftMarkdown) {
  return `You are fact-checking a set of AI-generated meeting notes against the full transcript they were drafted from, for a fintech application session. Be CONSERVATIVE — your job is to catch clear-cut mistakes, not to nitpick wording or style. Note: the draft may contain a "Topics & Concepts Covered" section (descriptive/explanatory content, e.g. a product walkthrough) in addition to, or instead of, "Problems & Feature Requests" — check BOTH sections with the same rigor; a missing TOPIC is just as much an omission as a missing problem.

FULL TRANSCRIPT:
"""
${transcript}
"""

DRAFT NOTES (already written, being checked here):
"""
${draftMarkdown}
"""

Check for exactly two things, across BOTH the Topics and Problems sections:

1. HALLUCINATED — a specific claim, topic detail, problem, or number stated in the draft that the transcript does NOT actually support (i.e. it was invented or misstated — e.g. a wrong percentage, day count, or threshold — not just reworded). Do NOT flag: paraphrasing, summarizing, reasonable inference clearly implied by context, or a topic/problem mentioned in more than one place in the transcript and correctly merged into one entry.

2. OMITTED — EITHER (a) a problem, complaint, or feature request that IS clearly and distinctly raised in the transcript but is completely missing from the draft, OR (b) a distinct topic, product, or concept that was explained/described at some length in the transcript but has no corresponding entry in "Topics & Concepts Covered". Do NOT flag: something covered under a broader problem or topic already in the draft, minor asides, brief mentions in passing, or restatements of something already captured.

When in doubt, do NOT flag it — false alarms make this check less useful, not more. It is completely normal and expected for both lists to be empty.

Respond with ONLY a JSON object, nothing else — no markdown, no code fence, no commentary before or after. Shape:
{
  "hallucinated": [ { "claim": "short quote or paraphrase of the unsupported claim", "reason": "why the transcript doesn't support it" } ],
  "omitted": [ { "gist": "short description of what was missed", "timestampSeconds": 62 } ]
}`;
}

/**
 * Defensively parses the verification response into a sanitized object.
 * Same resilience posture as the rest of this pipeline (splitDraftAndFlags,
 * parseTopicIndex in meeting-notes.js): a missing/malformed response
 * degrades to "nothing flagged" rather than crashing the session — this
 * check is advisory, so silence-on-failure is the safe default, not a
 * fabricated finding.
 *
 * @param {string} rawResponse
 * @returns {{hallucinated: Array<{claim: string, reason: string}>, omitted: Array<{gist: string, timestampSeconds: number}>}}
 */
function parseVerificationResult(rawResponse) {
  let text = (rawResponse || '').trim();

  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) text = fenceMatch[1].trim();

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger.warn(`[warn] Could not parse verification JSON (${err.message}) — treating as nothing flagged.`);
  }

  const rawHallucinated = Array.isArray(parsed?.hallucinated) ? parsed.hallucinated : [];
  const rawOmitted      = Array.isArray(parsed?.omitted) ? parsed.omitted : [];

  const hallucinated = rawHallucinated
    .filter((h) => h
      && typeof h.claim === 'string' && h.claim.trim()
      && typeof h.reason === 'string' && h.reason.trim())
    .map((h) => ({ claim: h.claim.trim(), reason: h.reason.trim() }));

  const omitted = rawOmitted
    .filter((o) => o
      && typeof o.gist === 'string' && o.gist.trim()
      && Number.isFinite(o.timestampSeconds) && o.timestampSeconds >= 0)
    .map((o) => ({ gist: o.gist.trim(), timestampSeconds: Math.round(o.timestampSeconds) }));

  return { hallucinated, omitted };
}

/**
 * Processes one session: runs the verification check and writes
 * notes/verification.json, unless already done or Stage 2 hasn't run yet.
 *
 * @param {OpenAI} client
 * @param {string} txtPath   - Pure-English transcript path (from listPureEnglishTranscripts())
 * @param {string} group
 * @param {string} sessionId
 * @returns {Promise<'skipped-no-draft'|'skipped-done'|'clean'|'flagged'|'error'>}
 */
async function processOneSession(client, txtPath, group, sessionId) {
  const sessionNotesDir = notesDir(group, sessionId);
  const draftPath = path.join(sessionNotesDir, 'draft.md');
  const vPath = verificationPath(group, sessionId);

  if (!fs.existsSync(draftPath)) return 'skipped-no-draft'; // Stage 2 hasn't run
  if (fs.existsSync(vPath)) return 'skipped-done'; // resume — already checked

  const transcript = fs.readFileSync(txtPath, 'utf8');
  const draftMarkdown = fs.readFileSync(draftPath, 'utf8');
  const prompt = buildVerificationPrompt(transcript, draftMarkdown);

  logger.info(`  🔍 Verifying ${group}/${sessionId}...`);

  try {
    const response = await client.chat.completions.create({
      model: DEEPSEEK_MODEL,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.choices[0]?.message?.content || '';
    const result = parseVerificationResult(raw);

    fs.writeFileSync(vPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      ...result,
    }, null, 2), 'utf8');

    const flagCount = result.hallucinated.length + result.omitted.length;
    if (flagCount === 0) {
      logger.info(`  ✓  ${group}/${sessionId}: clean — nothing flagged.`);
      return 'clean';
    }
    logger.warn(`  ⚠  ${group}/${sessionId}: ${result.hallucinated.length} possible hallucination(s), ` +
      `${result.omitted.length} possible omission(s) — see notes/verification.json.`);
    return 'flagged';

  } catch (err) {
    const creditErr = toCreditErrorOrNull(err);
    if (creditErr) {
      creditErr.currentItem = `${group}/${sessionId}`;
      throw creditErr;
    }
    const errMsg = err?.message || err?.error?.message || String(err);
    logger.error(`  ✗  ${group}/${sessionId}: DeepSeek error: ${errMsg}`);
    return 'error'; // leave it for a future re-run, don't fabricate a result
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  logger.info('============================================================');
  logger.info(' Vision-Assist Stage 2.5 — Verification Pass (DeepSeek)');
  logger.info('============================================================');

  if (!DEEPSEEK_KEY) {
    logger.error('[error] DEEPSEEK_API_KEY is not set in .env');
    logger.error('  Add your key from https://platform.deepseek.com/');
    process.exit(1);
  }

  const sessionFiles = listPureEnglishTranscripts(); // {txtPath, group, sessionId}

  if (sessionFiles.length === 0) {
    logger.error('[error] No *-pure-english.txt files found under any');
    logger.error('  output/<group>/<session-id>/transcripts/pure-english/. Run npm run pure-english first.');
    process.exit(1);
  }

  const client = createDeepSeekClient(DEEPSEEK_KEY);
  logger.info(`[info] Model    : ${DEEPSEEK_MODEL}`);
  logger.info(`[info] Sessions : ${sessionFiles.length}`);
  logger.info(`[info] Output   : output/<group>/<session-id>/notes/verification.json`);
  logger.info(`[info] Resume   : sessions with an existing verification.json are skipped\n`);

  const tally = { 'skipped-no-draft': 0, 'skipped-done': 0, clean: 0, flagged: 0, error: 0 };
  let doneCount = 0;
  const totalCount = sessionFiles.length;

  for (const { txtPath, group, sessionId } of sessionFiles) {
    try {
      const outcome = await processOneSession(client, txtPath, group, sessionId);
      tally[outcome] = (tally[outcome] || 0) + 1;
      doneCount++;
    } catch (err) {
      exitOnCreditExhaustion(err, {
        serviceLabel: 'DeepSeek',
        topUpUrl: 'https://platform.deepseek.com/',
        resumeCmd: 'npm run verify-notes',
        currentItem: err.currentItem || `${group}/${sessionId}`,
        doneCount,
        totalCount,
      });
      throw err;
    }
  }

  logger.info('\n============================================================');
  logger.info(' Done.');
  logger.info(`   Clean (nothing flagged) : ${tally.clean}`);
  logger.info(`   Flagged (see verification.json) : ${tally.flagged}`);
  logger.info(`   Errors (will retry next run)     : ${tally.error}`);
  logger.info(`   Already verified          : ${tally['skipped-done']}`);
  logger.info(`   No draft yet (run Stage 2 first) : ${tally['skipped-no-draft']}`);
  logger.info('============================================================\n');
}

module.exports = { main, processOneSession, buildVerificationPrompt, parseVerificationResult };

if (require.main === module) {
  main().catch((err) => {
    logger.error('\n[fatal error]', err.message || err);
    process.exit(1);
  });
}

'use strict';
const logger = require('./lib/logger');

/**
 * vision-patch.js — Stage 5 (final stage) of vision-assist (see HANDOVER.md
 * for the full 5-stage design). Takes Stage 2's draft.md plus Stage 4's
 * captions and produces notes/final.md — the one people actually read.
 *
 * "PATCH, NOT REGENERATE" — user confirmed explicitly: "patch is better."
 * DeepSeek is given the full draft plus only the new visual confirmations,
 * and asked to weave them into the existing "Vision Check Requested" lines
 * (turning them into "Visual Confirmation" lines) WITHOUT touching anything
 * else in the document. DeepSeek has no vision capability on any tier — it
 * never sees an image, only Stage 4's text captions.
 *
 * WHAT HAPPENS WHEN THERE'S NOTHING TO PATCH:
 *   - No vision checks were ever flagged for this session -> draft.md is
 *     copied through to final.md verbatim. Zero extra DeepSeek cost.
 *   - Vision checks WERE flagged but the source video was gone by Stage 3 ->
 *     draft.md is copied through with one appended note saying so plainly,
 *     per the design requirement to "skip vision-assist for that session and
 *     say so in the notes, don't fail the whole run."
 *   - Vision checks were flagged and the video WAS available, but Stage 4
 *     hasn't captioned anything for this session yet -> this session is
 *     SKIPPED (not marked done) so a later run, after Stage 4 finishes, can
 *     patch it properly instead of locking in an unpatched result too early.
 *   - Some but not all frames got captioned (e.g. Stage 4 hit a credit limit
 *     mid-run) -> a PARTIAL patch proceeds using whatever captions exist;
 *     the remaining flagged points are marked as not confirmed, never guessed.
 *
 * VERIFICATION NOTE (Stage 2.5 handoff, added 2026-07-16): if
 * src/verify-notes.js has run for a session and notes/verification.json
 * contains any flagged hallucination/omission, a short advisory note is
 * appended to the end of final.md pointing at verification.json — in EVERY
 * assembly path below (copy-through, copy-through-with-video-note, and
 * patched). This never edits the note's actual content, only surfaces that
 * something is worth a human look; if verification.json doesn't exist or
 * found nothing, no note is added. The same verification results are also
 * merged into session-data.json so the XLSX export surfaces them.
 *
 * STRUCTURED DATA (XLSX integration): this stage enriches
 * notes/session-data.json (written by meeting-notes.js) with:
 *   - problem.visionConfirmed — the Stage 4 caption text for each problem's
 *     confirmed frame (matched by problemNumber)
 *   - verification — the merged Stage 2.5 hallucinated/omitted findings
 * The master-meeting-notes.md consolidation (a second DeepSeek call) was
 * REMOVED as of 2026-08-03 — the XLSX export replaces it (see meeting-notes.js
 * header). final.md remains the human-readable per-session deliverable.
 *
 * RESUME LOGIC:
 *   A session is skipped if its notes/final.md already exists.
 *
 * CREDIT SAFETY:
 *   DeepSeek credit/quota errors are caught and shown as a clean, actionable
 *   message — no stack traces. Sessions already patched stay done.
 *
 * Usage:
 *   node src/vision-patch.js
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { config } = require('./lib/config');
const {
  notesDir,
  screenshotsDir,
  captionsDir,
  verificationPath,
  listAllSessions,
} = require('./lib/session-paths');
const { toCreditErrorOrNull } = require('./lib/credit-errors');
const { exitOnCreditExhaustion } = require('./lib/credit-runner');
const { createDeepSeekClient, formatTime } = require('./lib/format');
const { applyVisualConfirmations, mergeVerificationIntoSessionData } = require('./lib/session-data');

const DEEPSEEK_KEY   = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = config.deepseekModel();

/**
 * Reads notes/verification.json (Stage 2.5 output), if present, and builds a
 * short advisory note to append to final.md when it flagged something.
 * Returns '' if Stage 2.5 hasn't run yet, its file can't be read, or it ran
 * and found nothing — this only surfaces an existing finding, it never
 * invents one, and it never touches the actual note content.
 *
 * @param {string} group
 * @param {string} sessionId
 * @returns {string}
 */
function buildVerificationNote(group, sessionId) {
  const vPath = verificationPath(group, sessionId);
  if (!fs.existsSync(vPath)) return '';

  let result;
  try {
    result = JSON.parse(fs.readFileSync(vPath, 'utf8'));
  } catch (err) {
    logger.warn(`  ⚠  ${group}/${sessionId}: could not read verification.json (${err.message}) — skipping its note.`);
    return '';
  }

  const hallucinated = Array.isArray(result?.hallucinated) ? result.hallucinated : [];
  const omitted = Array.isArray(result?.omitted) ? result.omitted : [];
  if (hallucinated.length === 0 && omitted.length === 0) return '';

  const lines = [];
  if (hallucinated.length > 0) lines.push(`- ${hallucinated.length} possible unsupported claim(s) in this draft`);
  if (omitted.length > 0) lines.push(`- ${omitted.length} possible topic(s) raised in the call but missing from this draft`);

  return `\n\n---\n*Stage 2.5 verification flagged something worth a human look — nothing below was auto-corrected:\n${lines.join('\n')}\nSee notes/verification.json for details.*\n`;
}

/**
 * Builds the Stage 5 patch prompt: draft + confirmed captions + (if partial)
 * an explicit list of what's still missing, so DeepSeek never has to guess.
 *
 * @param {string} draftMarkdown
 * @param {Array<{problemNumber: number|null, timestampSeconds: number, whatToLookFor: string, caption: string}>} confirmed
 * @param {Array<{problemNumber: number|null, timestampSeconds: number, whatToLookFor: string}>} unconfirmed
 * @returns {string}
 */
function buildPatchPrompt(draftMarkdown, confirmed, unconfirmed) {
  const confirmedBlock = confirmed.length === 0 ? '(none)' : confirmed
    .map((c) => `- Problem ${c.problemNumber ?? '?'} (~${formatTime(c.timestampSeconds)}): asked to confirm "${c.whatToLookFor}" -> OBSERVED: ${c.caption}`)
    .join('\n');

  const unconfirmedBlock = unconfirmed.length === 0 ? '' : `\n\nSTILL NOT CONFIRMED (no caption available yet — do not guess or invent an answer for these):\n${
    unconfirmed.map((u) => `- Problem ${u.problemNumber ?? '?'} (~${formatTime(u.timestampSeconds)}): "${u.whatToLookFor}"`).join('\n')
  }`;

  return `You are patching an existing set of meeting notes for a fintech application with newly-available visual confirmations. Do NOT regenerate the document — make the smallest possible edit that accomplishes the task below.

DRAFT NOTES (patch this, do not rewrite from scratch):
"""
${draftMarkdown}
"""

VISUAL CONFIRMATIONS AVAILABLE:
${confirmedBlock}${unconfirmedBlock}

YOUR TASK:
For every line in the draft that reads "**Vision Check Requested:** ...", replace ONLY that line:
- If a matching visual confirmation is listed above (same problem number / same request), replace it with:
  **Visual Confirmation:** [what was actually observed, based on the confirmation above — do not add anything beyond what's stated]
- If it's listed under "STILL NOT CONFIRMED" above, replace it with exactly:
  **Visual Confirmation:** *(Requested but not yet available)*

Do not change anything else — not the problem titles, descriptions, feature requests, other lines, headings, or the Summary. Do not add new problems, remove any, or reword anything you weren't explicitly told to change here.

Return the ENTIRE updated document (the full Markdown, start to finish), and nothing else — no commentary before or after it.`;
}

/**
 * Processes one session: decides whether to copy-through, skip, or patch,
 * and writes notes/final.md accordingly.
 *
 * @param {OpenAI|null} client - null is fine if there's nothing to patch (copy-through path never needs it)
 * @param {string} group
 * @param {string} sessionId
 * @returns {Promise<'skipped-no-draft'|'skipped-not-ready'|'skipped-done'|'copied'|'copied-with-note'|'patched'>}
 */
async function processOneSession(client, group, sessionId) {
  const sessionNotesDir = notesDir(group, sessionId);
  const draftPath = path.join(sessionNotesDir, 'draft.md');
  const finalPath = path.join(sessionNotesDir, 'final.md');

  if (!fs.existsSync(draftPath)) return 'skipped-no-draft'; // Stage 2 hasn't run
  if (fs.existsSync(finalPath)) return 'skipped-done'; // resume

  const manifestPath = path.join(screenshotsDir(group, sessionId), 'manifest.json');
  if (!fs.existsSync(manifestPath)) return 'skipped-not-ready'; // Stage 3 hasn't run yet

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const draftMarkdown = fs.readFileSync(draftPath, 'utf8');

  // ── Case A: no vision checks were ever flagged for this session ─────────
  if (manifest.videoAvailable === null || !manifest.frames || manifest.frames.length === 0) {
    if (manifest.videoAvailable === false) {
      // ── Case B: flagged, but source video was gone by Stage 3 ─────────
      const note = `\n\n---\n*Note: visual confirmation was requested for this session, but the ` +
        `source video was no longer available when frames were captured. This document reflects ` +
        `the transcript only.*\n`;
      fs.writeFileSync(finalPath, draftMarkdown + note + buildVerificationNote(group, sessionId), 'utf8');
      mergeVerificationIntoSessionData(group, sessionId);
      logger.info(`  ✓  ${group}/${sessionId}: copied through (video was unavailable) → final.md`);
      return 'copied-with-note';
    }
    // Case A proper: zero flags, nothing to patch, nothing to note.
    const vNoteA = buildVerificationNote(group, sessionId);
    if (vNoteA) {
      fs.writeFileSync(finalPath, draftMarkdown + vNoteA, 'utf8');
    } else {
      fs.copyFileSync(draftPath, finalPath);
    }
    mergeVerificationIntoSessionData(group, sessionId);
    logger.info(`  ✓  ${group}/${sessionId}: copied through (no vision checks needed) → final.md`);
    return 'copied';
  }

  // ── Gather whatever captions exist so far ────────────────────────────────
  const capsDir = captionsDir(group, sessionId);
  const confirmed = [];
  const unconfirmed = [];

  for (const frame of manifest.frames) {
    const frameBaseName = path.basename(frame.file, path.extname(frame.file));
    const captionPath = path.join(capsDir, `${frameBaseName}.json`);
    if (fs.existsSync(captionPath)) {
      const captionData = JSON.parse(fs.readFileSync(captionPath, 'utf8'));
      confirmed.push({
        problemNumber: frame.problemNumber,
        timestampSeconds: frame.timestampSeconds,
        whatToLookFor: frame.whatToLookFor,
        caption: captionData.caption || '(empty caption)',
      });
    } else {
      unconfirmed.push({
        problemNumber: frame.problemNumber,
        timestampSeconds: frame.timestampSeconds,
        whatToLookFor: frame.whatToLookFor,
      });
    }
  }

  // ── Nothing captioned yet at all -> Stage 4 hasn't caught up, not ready ──
  if (confirmed.length === 0) {
    return 'skipped-not-ready';
  }

  logger.info(`  🤖 Patching ${group}/${sessionId}: ${confirmed.length} confirmed` +
    (unconfirmed.length ? `, ${unconfirmed.length} still pending` : '') + '...');

  const prompt = buildPatchPrompt(draftMarkdown, confirmed, unconfirmed);

  try {
    const response = await client.chat.completions.create({
      model: DEEPSEEK_MODEL,
      messages: [{ role: 'user', content: prompt }],
    });

    const patched = response.choices[0]?.message?.content?.trim() || '';

    // Resilience: never let a hallucinated/empty response wipe out a good
    // draft. If DeepSeek returns nothing, or something suspiciously much
    // shorter than the original (likely truncated/failed), fall back to an
    // unpatched copy-through rather than losing the notes.
    if (!patched) {
      logger.warn(`  ⚠  ${group}/${sessionId}: DeepSeek returned an empty patch — copying draft through unpatched.`);
      const vNoteEmpty = buildVerificationNote(group, sessionId);
      if (vNoteEmpty) {
        fs.writeFileSync(finalPath, draftMarkdown + vNoteEmpty, 'utf8');
      } else {
        fs.copyFileSync(draftPath, finalPath);
      }
      mergeVerificationIntoSessionData(group, sessionId);
      return 'copied';
    }
    if (patched.length < draftMarkdown.length * 0.5) {
      logger.warn(`  ⚠  ${group}/${sessionId}: patched response looked truncated/suspicious ` +
        `(${patched.length} chars vs ${draftMarkdown.length} in the draft) — using it anyway, but check final.md.`);
    }

    fs.writeFileSync(finalPath, patched + buildVerificationNote(group, sessionId), 'utf8');
    // Reflect visual confirmations + verification results in the structured
    // data so the XLSX export shows what was confirmed on screen.
    applyVisualConfirmations(group, sessionId, confirmed);
    mergeVerificationIntoSessionData(group, sessionId);
    logger.info(`  ✓  ${group}/${sessionId}: patched → final.md`);
    return 'patched';

  } catch (err) {
    const creditErr = toCreditErrorOrNull(err);
    if (creditErr) {
      creditErr.currentItem = `${group}/${sessionId}`;
      throw creditErr;
    }
    logger.error(`  ✗  ${group}/${sessionId}: DeepSeek error: ${err?.message || err?.error?.message || String(err)}`);
    return 'skipped-not-ready'; // leave it for a future re-run, don't fabricate a final.md
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  logger.info('============================================================');
  logger.info(' Vision-Assist Stage 5 — Patch Pass (DeepSeek)');
  logger.info('============================================================');

  if (!DEEPSEEK_KEY) {
    logger.error('[error] DEEPSEEK_API_KEY is not set in .env');
    logger.error('  Add your key from https://platform.deepseek.com/');
    process.exit(1);
  }

  const sessions = listAllSessions(); // {group, sessionId}

  if (sessions.length === 0) {
    logger.error('[error] No sessions found under output/<group>/<session-id>/. Run npm run meeting-notes first.');
    process.exit(1);
  }

  const client = createDeepSeekClient(DEEPSEEK_KEY);
  logger.info(`[info] Model    : ${DEEPSEEK_MODEL}`);
  logger.info(`[info] Sessions : ${sessions.length}`);
  logger.info(`[info] Output   : output/<group>/<session-id>/notes/final.md`);
  logger.info(`[info]           (+ session-data.json enriched with visual confirmations)\n`);

  const tally = {
    'skipped-no-draft': 0, 'skipped-not-ready': 0, 'skipped-done': 0,
    copied: 0, 'copied-with-note': 0, patched: 0,
  };
  let doneCount = 0;
  const totalCount = sessions.length;

  for (const { group, sessionId } of sessions) {
    try {
      const outcome = await processOneSession(client, group, sessionId);
      tally[outcome] = (tally[outcome] || 0) + 1;
      doneCount++;
    } catch (err) {
      exitOnCreditExhaustion(err, {
        serviceLabel: 'DeepSeek',
        topUpUrl: 'https://platform.deepseek.com/',
        resumeCmd: 'npm run vision-patch',
        currentItem: err.currentItem || `${group}/${sessionId}`,
        doneCount,
        totalCount,
      });
      throw err;
    }
  }

  logger.info('\n============================================================');
  logger.info(' Done.');
  logger.info(`   Patched              : ${tally.patched}`);
  logger.info(`   Copied (no checks)   : ${tally.copied}`);
  logger.info(`   Copied (video gone)  : ${tally['copied-with-note']}`);
  logger.info(`   Not ready yet        : ${tally['skipped-not-ready']} (run Stage 3/4 first, or wait for credits to top up)`);
  logger.info(`   Already done         : ${tally['skipped-done']}`);
  logger.info('   Export to Excel      : run "npm run xlsx" (or the pipeline with --format xlsx)');
  logger.info('============================================================\n');
}

module.exports = { main, processOneSession, buildPatchPrompt, buildVerificationNote };

if (require.main === module) {
  main().catch((err) => {
    logger.error('\n[fatal error]', err.message || err);
    process.exit(1);
  });
}

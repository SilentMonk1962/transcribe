'use strict';
const logger = require('./lib/logger');

/**
 * meeting-notes.js
 * Generates structured meeting notes from pure English transcripts using DeepSeek.
 *
 * GROUPING (fixes unrelated calls being merged together):
 *   Every recording is assigned a "group" — the meeting thread/topic it
 *   belongs to — by matching its filename against groups.config.json (see
 *   src/lib/session-paths.js, the single implementation of this logic).
 *   Add a new rule to groups.config.json any time a new recurring meeting
 *   thread starts; unmatched recordings fall into the "ungrouped" bucket and
 *   are flagged in the console output.
 *
 * PER-SESSION LAYOUT:
 *   Recordings are further split into per-session folders under each group
 *   (see src/lib/session-paths.js for how group + session-id are resolved,
 *   including same-day collision handling). This module discovers work by
 *   walking output/<group>/<session-id>/transcripts/pure-english/*.txt for
 *   every group and session on disk, rather than one flat directory.
 *
 * THIS IS STAGE 2 OF VISION-ASSIST (see HANDOVER.md for the full stage design):
 *   Stage 1 (elsewhere): video → audio → transcribe → pure-english.
 *   Stage 2 (HERE): draft notes from the transcript, AND flag any point where
 *     seeing the actual screen would help confirm what's being described.
 *     Flags are both human-readable (a "Vision Check Requested" line inline
 *     in the draft) and machine-readable (notes/flags.json, consumed by
 *     Stage 3). There is NO cap on how many points get flagged per session —
 *     confirmed explicitly by the user 2026-07-15; the model is instructed to
 *     flag only where it would genuinely help, not speculatively.
 *   As of 2026-07-16, Stage 2 is itself TWO DeepSeek calls (hallucination
 *   resilience, requested by the user — long transcripts risk "lost in the
 *   middle" attention decay, and a topic raised early may be revisited late):
 *     Stage 2a (runIndexPass): a first, cheap pass reads the FULL transcript
 *       and produces ONLY an index — every distinct topic mention in
 *       chronological order, including repeats, with no merging or prose.
 *       Cached to notes/topic-index.json, independently resumable.
 *     Stage 2b (the original call, now index-aware): drafts the actual notes,
 *       given the transcript AND its own topic index, with explicit
 *       instructions to merge index entries that describe the same
 *       underlying issue (raised early, revisited late) into ONE Problem
 *       entry rather than duplicating it. This is chunking's opposite —
 *       the model still reads the transcript whole, the index just makes
 *       sure nothing raised far apart gets treated as two separate problems.
 *   Stage 2.5 (src/verify-notes.js): a separate, independent DeepSeek call
 *     cross-checks the Stage 2b draft against the full transcript and writes
 *     notes/verification.json listing anything the draft appears to have
 *     hallucinated (not actually supported by the transcript) or omitted
 *     (a distinct problem raised in the transcript but missing from the
 *     draft). Purely advisory — it never edits the draft; Stage 5 surfaces
 *     its findings as a note for a human to check.
 *   Stage 3 (src/vision-capture.js): ffmpeg grabs exactly those flagged frames.
 *   Stage 4 (src/vision-caption.js): OpenAI captions each frame independently.
 *   Stage 5 (src/vision-patch.js): DeepSeek patches the draft with captions,
 *     or copies it through unchanged if there was nothing to patch, producing
 *     notes/final.md — the one people read. Also appends the Stage 2.5
 *     verification note here, if there's anything to flag, and enriches
 *     session-data.json with visual confirmations + verification results.
 *
 * STRUCTURED OUTPUT (drives the XLSX export):
 *   As of 2026-08-03 this stage ALSO writes notes/session-data.json — the
 *   machine-readable topics/problems/summary with speaker attribution that
 *   src/generate-xlsx.js turns into the detailed Excel workbook. The old
 *   master-meeting-notes.md consolidation (a second DeepSeek call) was
 *   REMOVED entirely: the XLSX now guarantees every problem/topic raised by
 *   every party is captured, filterable, and cross-checked, instead of a
 *   prose rollup that could silently drop content.
 *
 * OUTPUT PER RUN (this stage only):
 *   output/<group>/<session-id>/notes/topic-index.json — Stage 2a index (cached)
 *   output/<group>/<session-id>/notes/draft.md    — markdown notes, one per session
 *   output/<group>/<session-id>/notes/flags.json  — vision-assist flags for Stage 3
 *   output/<group>/<session-id>/notes/session-data.json — structured data for the XLSX
 *
 * RESUME LOGIC:
 *   Per-session draft.md/flags.json are skipped if they already exist.
 *   topic-index.json is independently resumable too — a failed/incomplete
 *   Stage 2b does not force the index pass to redo its (separate) work.
 *   Sessions created before structured data existed (draft present, no
 *   session-data.json) get their session-data.json derived from the draft
 *   markdown, so the XLSX is complete without re-paying for a model call.
 *
 * CREDIT SAFETY:
 *   DeepSeek errors (including credit exhaustion / 402) are caught and shown
 *   as clean, actionable messages — no stack traces.
 *
 * Usage:
 *   node src/meeting-notes.js
 */

require('dotenv').config();

const fs     = require('fs');
const path   = require('path');
const { config } = require('./lib/config');
const {
  OUTPUT_DIR,
  extractSessionId,
  formatSessionDate,
  notesDir,
  topicIndexPath,
  sessionDataPath,
  listPureEnglishTranscripts,
  ensureDir,
} = require('./lib/session-paths');
const { createDeepSeekClient, formatTime } = require('./lib/format');
const { toCreditErrorOrNull } = require('./lib/credit-errors');
const { exitOnCreditExhaustion } = require('./lib/credit-runner');
const { parseStructuredData, parseDraftFallback, writeSessionData } = require('./lib/session-data');

// ─── Config ───────────────────────────────────────────────────────────────────
const DEEPSEEK_KEY    = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL  = config.deepseekModel();

// ─── Prompt ───────────────────────────────────────────────────────────────────

/**
 * A single embedded worked example shown to the model before it sees the
 * real transcript. This removes ambiguity about tone, granularity, and
 * exact formatting — the two most common failure modes in earlier runs.
 */
const WORKED_EXAMPLE = `
─────────────────────────────────────────
WORKED EXAMPLE (study this before starting)
─────────────────────────────────────────

EXAMPLE TRANSCRIPT (input):
"""
[00:12 -> 00:38]  Speaker 1:
  So right now when an operator opens the Application Journey screen, the KYC status pill and the Application status pill look almost identical in color. People keep clicking into the wrong tab.

[00:39 -> 01:05]  Speaker 2:
  Yeah, and there's no way to filter applications by the assigned RM either — we have to scroll through all 200 rows manually every morning.

[01:06 -> 01:20]  Speaker 1:
  For the pill issue, could we just make KYC pills blue and Application pills green? That would fix it instantly.
"""

EXAMPLE OUTPUT (exactly this structure and level of detail):
---
# Meeting Notes — Session — 2026-06-02

## Topics & Concepts Covered
No standalone topics or product/process descriptions were covered outside the problems below — this entire call was pain-point-driven.

## Problems & Feature Requests

### Problem 1: KYC and Application status pills are visually indistinguishable
**Description:** Operators cannot tell the KYC status pill apart from the Application status pill because both use near-identical colors, causing operators to click into the wrong tab.
**Feature Requested:** Recolor the two pills distinctly — KYC in blue, Application in green.
**Vision Check Requested:** the exact current colors of the KYC pill vs the Application pill (~00:20)

### Problem 2: No way to filter applications by assigned RM
**Description:** Operators must manually scroll through roughly 200 rows every morning because there is no filter for the RM (Relationship Manager) assigned to an application.
**Feature Requested:** *(Open — no feature discussed yet)*

---
## Summary
Operators raised two UX issues on the Application Journey screen: indistinguishable KYC vs Application status pills causing navigation errors (fix proposed: distinct colors), and missing RM-based filtering that forces scanning roughly 200 rows daily (currently unresolved).
---
===VISION_ASSIST_FLAGS_START===
[
  { "problemNumber": 1, "timestampSeconds": 20, "whatToLookFor": "the exact current colors of the KYC pill vs the Application pill" }
]
===VISION_ASSIST_FLAGS_END===

NOTES ON THE EXAMPLE:
- Each problem gets its own numbered heading — never bundle two problems into one entry.
- "Description" restates the problem in plain terms; it is not a copy-paste of the transcript line.
- "Vision Check Requested" only appears when actually SEEING the screen would confirm or clarify something words alone can't — here, the exact colors. Problem 2 has none because it's a missing-feature request, not something a screenshot could clarify — the line is correctly omitted, not guessed.
- "Topics & Concepts Covered" is correctly minimal here because this whole call was pain-point-driven — every sentence in the transcript maps to one of the two problems above. See TOPICS & CONCEPTS EXAMPLE below for what this section looks like when a call actually contains standalone descriptive/explanatory content.
- The Summary is 3–5 sentences, written for someone who did not attend the call.
- The VISION_ASSIST_FLAGS block always appears at the very end, even when empty (\`[]\`) — it must be valid JSON and its "timestampSeconds" values must be integers, each one matching a "Vision Check Requested" line above it.
─────────────────────────────────────────
`;

/**
 * A second, always-shown worked example (unconditional, unlike MERGE_EXAMPLE
 * below which only appears when a topic index exists) — demonstrating what
 * the Topics & Concepts Covered section looks like when a call actually has
 * standalone descriptive/explanatory/educational content, as opposed to the
 * purely pain-point-driven WORKED_EXAMPLE above. Added 2026-07-21 after a
 * real training-session transcript (a trade finance product walkthrough)
 * came back with only 8 problem entries and its entire product-knowledge
 * content silently discarded — not hallucinated, just structurally nowhere
 * for it to go under a Problems-only schema. See HANDOVER.md for the full
 * diagnosis. This example exists so descriptive content has somewhere to
 * land WITHOUT being forced into a fake "problem."
 */
const TOPICS_EXAMPLE = `
─────────────────────────────────────────
TOPICS & CONCEPTS EXAMPLE (how to fill in "Topics & Concepts Covered")
─────────────────────────────────────────
Not every call has this kind of content — see WORKED_EXAMPLE above, where
it's correctly minimal. But many calls (training sessions, product
walkthroughs, process explanations, onboarding calls) spend most of their
time explaining or describing something rather than raising a problem.
That content is NOT a problem or a feature request, but it is still the
substance of the call, and it must not be silently dropped just because it
doesn't fit the Problems schema.

EXAMPLE TRANSCRIPT EXCERPT (input):
"""
[11:55 -> 12:25] Speaker 5:
  In reverse factoring, the buyer is the client. The supplier ships goods
  to the buyer, and we take assignment of the receivable — the invoice the
  supplier raised on the buyer is sold and assigned to us. We pay the
  supplier 80% of the invoice value upfront. After 120 days, the buyer
  pays us 100%, we net our 2% charge, and remit the remaining 20% to the
  supplier.
"""

EXAMPLE "Topics & Concepts Covered" ENTRY for this excerpt:

### Topic: Reverse Factoring
**What it is:** The buyer is the borrower/obligor. The supplier's invoice
to the buyer is assigned to the lender, who advances the supplier a
discounted amount and collects the full amount from the buyer at maturity.
**Key parameters mentioned:** 80% advance to the supplier upfront, 120-day
term, 2% fee netted before remitting the remaining 20% to the supplier.
**Example/case study cited:** *(omit this line if none was mentioned)*

RULES FOR THIS SECTION:
- One entry per distinct topic/product/concept — group ALL index entries
  and transcript passages about the SAME topic into ONE entry (e.g. every
  mention of reverse factoring across the whole call, even if discussed at
  three different timestamps, becomes ONE "Topic: Reverse Factoring" entry,
  not three). This is the same merge discipline as Problems — see the merge
  guidance below if a topic index is available.
- Always capture SPECIFIC numbers exactly as stated — percentages, day
  counts, thresholds, fee amounts. Do not round, drop, or generalize them;
  vague notes are much less useful to someone who wasn't on the call.
- Capture any named real example, client, or case study mentioned for that
  topic (omit the line entirely if none was given — never invent one).
- If a topic was ALSO the subject of an actual problem or open question,
  still give it its own Topic entry here for the explanation, and cover the
  issue separately under Problems & Feature Requests — the two sections
  serve different purposes and can both reference the same topic.
- If the call has NO standalone topics/descriptions at all outside the
  problems raised, write exactly: "No standalone topics or product/process
  descriptions were covered outside the problems below." — do not pad this
  section artificially to seem thorough.
─────────────────────────────────────────
`;

/**
 * A second, smaller worked example — shown only when a topic index is
 * actually available — demonstrating the ONE behavior the index exists to
 * teach: merging two mentions of the same underlying issue into a single
 * Problem entry instead of duplicating it. Kept separate from WORKED_EXAMPLE
 * above so that already-tuned example isn't touched by this change.
 */
const MERGE_EXAMPLE = `
─────────────────────────────────────────
MERGE EXAMPLE (how to use the topic index below)
─────────────────────────────────────────
Suppose the topic index contains:
  - [00:05] Client made a partial payment, balance wasn't updated
  - [00:58] Same partial-payment balance issue raised again, different client

These describe the SAME underlying problem — a balance not updating on
partial payment — just mentioned twice at different points in the call.
Do NOT create two separate "Problem" entries for this. Create ONE:

### Problem N: Outstanding balance is not updated after a partial payment
**Description:** [description covering BOTH occasions the transcript raised
this, not just the first]
**Feature Requested:** [as discussed]

If instead the index has two entries that merely sound similar but are
genuinely DIFFERENT problems (e.g. one about balance not updating on a
partial payment, another about balance not updating after a full
settlement delay), keep them as separate Problem entries — only merge
when it is really the same underlying issue.
─────────────────────────────────────────
`;

/**
 * Formats the cached/fresh topic index as a prompt-ready block with merge
 * instructions, or '' if there is no index to inject (e.g. the index pass
 * failed and we're proceeding without one — degrade gracefully, don't block
 * drafting on it).
 * @param {Array<{timestampSeconds: number, gist: string}>} topicIndex
 * @returns {string}
 */
function formatTopicIndexBlock(topicIndex) {
  if (!topicIndex || topicIndex.length === 0) return '';
  const lines = topicIndex.map((t) => `- [${formatTime(t.timestampSeconds)}] ${t.gist}`).join('\n');
  return `\n\nTOPIC INDEX (built in a separate first pass over this SAME transcript — every distinct mention, in chronological order, including repeats):\n${lines}\n\nMERGE BEFORE WRITING: scan this index for entries that describe the same underlying issue even though they appear at different timestamps — a topic raised early and revisited later is still ONE problem. Merge those into a single Problem entry citing every relevant timestamp. Do not create duplicate Problem entries just because something was mentioned more than once. See the merge example above.`;
}

/**
 * Builds the Stage 2a index-pass prompt. Deliberately asks for ONLY a JSON
 * array — no prose, no merging, no summarizing — so this pass stays cheap
 * and mechanical; all judgment happens later in Stage 2b once the index
 * exists to check against.
 *
 * @param {string} transcript - Full plain-text transcript content
 * @returns {string}
 */
function buildIndexPrompt(transcript) {
  return `You are building an INDEX of a meeting transcript for a fintech application feedback session. Do NOT write final notes. Do NOT merge or summarize anything. Do NOT skip repeats.

TRANSCRIPT:
"""
${transcript}
"""

Read the entire transcript from start to finish. For every distinct point, topic, problem, concern, or feature idea raised — no matter how small, and even if it repeats something mentioned earlier — output one entry:
  - timestampSeconds: the approximate whole-second timestamp where it's discussed, taken from the transcript's own [MM:SS -> MM:SS] markers
  - gist: a short description (under 15 words) of what was said, in plain language

If the same topic comes up again later in the call, log it AGAIN as its own separate entry at its own timestamp — merging happens in a later step, not this one. Err on the side of including too much rather than too little; this index exists to make sure nothing gets missed in the next step.

Respond with ONLY a JSON array, nothing else — no markdown, no code fence, no commentary before or after. Example shape:
[
  { "timestampSeconds": 62, "gist": "Inquiry number is self-generated, not issued by AECB" },
  { "timestampSeconds": 3480, "gist": "Same inquiry number issue raised again re: renewal cadence" }
]`;
}

/**
 * Defensively parses the Stage 2a index-pass response into a sanitized,
 * chronologically-sorted array. Resilient to hallucination/malformation the
 * same way splitDraftAndFlags() is: a missing/malformed response degrades to
 * an empty index rather than crashing the session — Stage 2b still runs,
 * just without merge guidance for that one session.
 *
 * @param {string} rawResponse - Full DeepSeek completion text
 * @returns {Array<{timestampSeconds: number, gist: string}>}
 */
function parseTopicIndex(rawResponse) {
  let text = (rawResponse || '').trim();

  // Defensive: strip a code fence if the model wrapped the array in one
  // despite being told not to — a common minor deviation, not worth
  // treating as a hard failure.
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) text = fenceMatch[1].trim();

  let rawEntries = [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) rawEntries = parsed;
  } catch (err) {
    logger.warn(`[warn] Could not parse topic index JSON (${err.message}) — proceeding with an empty index.`);
  }

  return rawEntries
    .filter((e) => e
      && Number.isFinite(e.timestampSeconds) && e.timestampSeconds >= 0
      && typeof e.gist === 'string' && e.gist.trim())
    .map((e) => ({
      timestampSeconds: Math.round(e.timestampSeconds),
      gist: e.gist.trim(),
    }))
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);
}

/**
 * Runs the Stage 2a index pass: one DeepSeek call over the full transcript,
 * defensively parsed. Throws on credit-exhaustion errors (caller decides how
 * to handle); any other failure is the caller's call too — this function
 * itself does not degrade, so a caller can distinguish "index pass errored"
 * from "index pass legitimately found nothing".
 *
 * @param {OpenAI} client
 * @param {string} transcript
 * @returns {Promise<Array<{timestampSeconds: number, gist: string}>>}
 */
async function runIndexPass(client, transcript) {
  const prompt = buildIndexPrompt(transcript);
  const response = await client.chat.completions.create({
    model:    DEEPSEEK_MODEL,
    messages: [{ role: 'user', content: prompt }],
  });
  const raw = response.choices[0]?.message?.content || '';
  if (!raw.trim()) {
    logger.warn('[warn] DeepSeek returned an empty topic index — proceeding with zero entries.');
    return [];
  }
  return parseTopicIndex(raw);
}

/**
 * Builds the per-session DeepSeek prompt.
 * Instructs the model to extract problems and feature requests in structured Markdown.
 *
 * @param {string} transcript      - Full plain-text transcript content
 * @param {string} sessionLabel    - e.g. "Session — 2026-06-02"
 * @param {Array}  topicIndex      - Output of runIndexPass()/parseTopicIndex(), or [] if unavailable
 */
function buildSessionPrompt(transcript, sessionLabel, topicIndex = []) {
  const topicIndexBlock  = formatTopicIndexBlock(topicIndex);
  const mergeExampleBlock = topicIndex.length > 0 ? MERGE_EXAMPLE : '';

  return `You are a senior product analyst reviewing operator feedback sessions for a fintech application. Note: not every session is a feedback session — some are training sessions, product walkthroughs, or process explanations with little or no "problem" content at all. Capture what the call ACTUALLY contains; do not force it into a shape it isn't.
${WORKED_EXAMPLE}${TOPICS_EXAMPLE}${mergeExampleBlock}
Now do the same for the real session below. Do not reuse any content from the worked example(s) — they exist only to show you the required structure and level of detail.

SESSION: ${sessionLabel}

TRANSCRIPT:
"""
${transcript}
"""${topicIndexBlock}

Your task:
Carefully read the transcript and extract the following. Be specific — use language from the transcript where possible, and preserve exact numbers (percentages, day counts, thresholds, amounts) rather than rounding or generalizing them. Do not invent problems, features, or topics that were not actually raised.

## 1. TOPICS & CONCEPTS COVERED
Capture every distinct topic, product, process, or concept that was explained, described, or discussed — regardless of whether it involves a problem. This is NOT limited to feedback: if the call is a product overview, training session, or walkthrough, this section is where that entire substance goes. See TOPICS & CONCEPTS EXAMPLE above for the exact format and the merge rule (one entry per topic, not one per mention). If the call genuinely has none of this (purely pain-point-driven), say so explicitly rather than leaving the section blank or inventing content — see WORKED_EXAMPLE above.

## 2. PROBLEMS FACED
List every distinct problem, pain point, confusion, or complaint raised. Each problem is ONE standalone issue — if two symptoms share one root cause, they are one problem; if two issues are unrelated even in the same breath, they are two problems. Number them. A topic can be covered under section 1 AND also have a problem raised about it under this section — the two are not mutually exclusive.

## 3. FEATURE REQUESTS
For each problem above, list any specific features, improvements, or capabilities that were requested or discussed as solutions. If no feature was discussed for a problem, write exactly: *(Open — no feature discussed yet)*

## 4. VISION CHECKS (flag sparingly — only where seeing the screen would genuinely help)
For each problem, decide whether actually SEEING the application's screen at that moment would help confirm or clarify something the words alone leave ambiguous — e.g. an exact color, layout, spacing, which specific element is broken, or an exact error message. Most problems will NOT need this. Do not flag speculatively, and do not flag something the transcript already states unambiguously in words. There is no fixed limit on how many you flag — flag exactly as many as are genuinely warranted, including zero.

## FORMAT
Respond ONLY in valid Markdown, followed by the vision-assist flags block. Use this exact structure (see worked examples above for fully filled-in references):

---
# Meeting Notes — ${sessionLabel}

## Topics & Concepts Covered
[one entry per distinct topic/product/concept, per TOPICS & CONCEPTS EXAMPLE above — or, if genuinely none, exactly: "No standalone topics or product/process descriptions were covered outside the problems below."]

### Topic: [name]
**What it is:** [neutral description/explanation, as covered in the call]
**Key parameters mentioned:** [specific numbers/percentages/timeframes/thresholds — omit this line if none were mentioned]
**Example/case study cited:** [any named real example discussed — omit this line if none was mentioned]

### Topic: ...

## Problems & Feature Requests

### Problem 1: [concise problem title]
**Description:** [what the problem is, as raised in the meeting]
**Feature Requested:** [specific feature or improvement requested]
— OR —
**Feature Requested:** *(Open — no feature discussed yet)*
**Vision Check Requested:** [what to verify] (~MM:SS)
— only include this line for problems that need it, omit entirely otherwise —

### Problem 2: ...

---
## Summary
A 3–5 sentence summary of the session's main themes — cover both what was explained/discussed AND any problems raised, whichever the call actually contained.
---
===VISION_ASSIST_FLAGS_START===
[
  { "problemNumber": 1, "timestampSeconds": 20, "whatToLookFor": "short description matching the Vision Check Requested line" }
]
===VISION_ASSIST_FLAGS_END===

The VISION_ASSIST_FLAGS block MUST always be present, even when there is nothing to flag — in that case use an empty array: \`[]\`. It must be valid JSON. "timestampSeconds" must be a whole number of seconds derived from the transcript's own [MM:SS -> MM:SS] markers (pick the moment inside that range where the relevant screen state is most likely visible). Every entry must correspond to a "Vision Check Requested" line above it — do not add flags for problems that have no such line, and do not add a "Vision Check Requested" line without a matching flag entry.

After the VISION_ASSIST_FLAGS block, output ONE more block:

===STRUCTURED_DATA_START===
{
  "summary": "3-5 sentence summary of the session's main themes (same content as the Summary section above)",
  "topics": [
    {
      "name": "Topic name (same as the ### Topic: heading)",
      "description": "what it is, as explained in the call",
      "keyParameters": "specific numbers/percentages/days/thresholds mentioned — omit this field if none",
      "example": "any named real example/client — omit this field if none",
      "raisedBy": "Speaker N"
    }
  ],
  "problems": [
    {
      "problemNumber": 1,
      "title": "Problem title (same as the ### Problem N: heading)",
      "description": "what the problem is, as raised in the meeting",
      "featureRequested": "specific feature requested, or exactly: *(Open — no feature discussed yet)*",
      "status": "requested",
      "raisedBy": "Speaker N",
      "timestampSeconds": 20,
      "visionCheck": "only if this problem has a Vision Check Requested line — otherwise omit this field"
    }
  ]
}
===STRUCTURED_DATA_END===

RULES FOR THE STRUCTURED_DATA BLOCK:
- It MUST be valid JSON — no markdown, no code fence, no commentary around it.
- "problemNumber" must exactly match the "### Problem N:" heading number so visual confirmations can be joined back to the right problem.
- "raisedBy" must be the Speaker label (e.g. "Speaker 1") from the transcript's diarized markers for whoever raised/explained each item. If attribution is genuinely unclear, use "Unclear".
- "topics" is an empty array [] when the session has no standalone topics/concepts (matching the Topics & Concepts section behavior). "problems" is an empty array [] when no problems were raised. "summary" is always present.
- "status" is "requested" when a feature/solution was discussed, "open" when none was.

Do not include any commentary outside the Markdown structure, the flags block, and the structured-data block.`;
}

// ─── Vision-assist flags parsing (Stage 2 -> Stage 3 handoff) ────────────────

const FLAGS_DELIM_REGEX = /===VISION_ASSIST_FLAGS_START===([\s\S]*?)===VISION_ASSIST_FLAGS_END===/;

/**
 * Splits DeepSeek's raw response into the clean Markdown draft and the
 * sanitized vision-assist flags array. Resilient to hallucination: if the
 * delimiter block is missing entirely, malformed JSON, or contains entries
 * missing required fields, this degrades to "zero flags" rather than
 * crashing the session or trusting bad data — the note itself still saves.
 *
 * @param {string} rawResponse - Full DeepSeek completion text
 * @returns {{markdown: string, flags: Array<{problemNumber: number|null, timestampSeconds: number, whatToLookFor: string}>}}
 */
function splitDraftAndFlags(rawResponse) {
  const match = rawResponse.match(FLAGS_DELIM_REGEX);
  if (!match) {
    logger.warn('[warn] DeepSeek response had no VISION_ASSIST_FLAGS block — treating as zero flags.');
    return { markdown: rawResponse.trim(), flags: [] };
  }

  const markdown = rawResponse.slice(0, match.index).trim();
  let rawFlags = [];
  try {
    const parsed = JSON.parse(match[1].trim());
    if (Array.isArray(parsed)) rawFlags = parsed;
  } catch (err) {
    logger.warn(`[warn] Could not parse VISION_ASSIST_FLAGS JSON (${err.message}) — treating as zero flags.`);
  }

  // Never trust model output blindly — drop anything missing a valid
  // non-negative integer timestamp or a non-empty description.
  const flags = rawFlags
    .filter((f) => f
      && Number.isFinite(f.timestampSeconds) && f.timestampSeconds >= 0
      && typeof f.whatToLookFor === 'string' && f.whatToLookFor.trim())
    .map((f) => ({
      problemNumber: Number.isFinite(f.problemNumber) ? f.problemNumber : null,
      timestampSeconds: Math.round(f.timestampSeconds),
      whatToLookFor: f.whatToLookFor.trim(),
    }));

  return { markdown, flags };
}

// ─── Core: generate notes for one session ────────────────────────────────────

/**
 * Reads a pure English transcript .txt, calls DeepSeek, saves the draft .md
 * plus its vision-assist flags.json to this session's notes/ folder. Skips
 * if the draft already exists (resume logic).
 *
 * @param {OpenAI}  client
 * @param {string}  txtPath   - Path to the pure-english .txt file
 * @param {string}  group     - Group slug (already known from directory walk)
 * @param {string}  sessionId - Effective session-id (already known from directory walk)
 * @param {string}  progress  - "[1/4]"
 * @returns {Promise<{label: string, notes: string, group: string}|null>}
 *   Returns {label, notes, group} on success, null if skipped or failed.
 *   "notes" is always the CLEAN markdown (flags block stripped) — this is
 *   what feeds the master consolidation prompt.
 */
async function generateSessionNotes(client, txtPath, group, sessionId, progress) {
  const baseName = path.basename(txtPath, '.txt');
  const sessionNotesDir = notesDir(group, sessionId);
  ensureDir(sessionNotesDir);
  const draftPath = path.join(sessionNotesDir, 'draft.md');
  const flagsPath = path.join(sessionNotesDir, 'flags.json');
  const indexPath = topicIndexPath(group, sessionId);

  // Recording basename (strip the "-pure-english" suffix) — stored in
  // flags.json so Stage 3 can find this session's original source video in input/.
  const recordingBaseName = baseName.replace(/-pure-english$/, '');

  // Session label for display + prompt context, e.g. "Session — 2026-07-08".
  const extractedId = extractSessionId(recordingBaseName);
  const sessionLabel = extractedId
    ? `Session — ${formatSessionDate(extractedId)}`
    : `Session — ${recordingBaseName}`;
  const sessionDate = extractedId ? formatSessionDate(extractedId) : recordingBaseName;

  // ── Resume check (whole session) ────────────────────────────────────────
  if (fs.existsSync(draftPath)) {
    logger.info(`  ${progress} ⏭  Already done, skipping: ${sessionLabel} [${group}]`);
    const existing = fs.readFileSync(draftPath, 'utf8');
    // Sessions created before structured data existed have a draft but no
    // session-data.json — derive one from the draft so the XLSX still
    // captures every problem/topic without re-paying for a model call.
    if (!fs.existsSync(sessionDataPath(group, sessionId))) {
      const parsed = parseDraftFallback(existing);
      writeSessionData(group, sessionId, {
        group,
        sessionId,
        sessionDate,
        recordingBaseName,
        generatedAt: new Date().toISOString(),
        ...parsed,
        verification: { hallucinated: [], omitted: [] },
        fromDraftFallback: true,
      });
    }
    return { label: sessionLabel, notes: existing, group };
  }

  const transcript = fs.readFileSync(txtPath, 'utf8');

  // ── Stage 2a: index pass — independently resumable, cached separately ───
  // from draft.md so a Stage 2b failure never forces a paid re-index.
  let topicIndex = null;
  if (fs.existsSync(indexPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      topicIndex = Array.isArray(cached.topics) ? cached.topics : [];
      logger.info(`  ${progress} ⏭  Reusing cached topic index (${topicIndex.length} entries): ${sessionLabel} [${group}]`);
    } catch (err) {
      logger.warn(`  ${progress} ⚠  Could not read cached topic index (${err.message}) — regenerating.`);
      topicIndex = null;
    }
  }
  if (topicIndex === null) {
    logger.info(`  ${progress} 🔎 Indexing topics: ${sessionLabel} [${group}]`);
    try {
      topicIndex = await runIndexPass(client, transcript);
      // Only cache on SUCCESS — a transient failure should be retried next
      // run, not permanently pinned to an empty index.
      fs.writeFileSync(indexPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        topics: topicIndex,
      }, null, 2), 'utf8');
      logger.info(`  ${progress} ✓  Indexed ${topicIndex.length} topic mention(s).`);
    } catch (err) {
      const creditErr = toCreditErrorOrNull(err);
      if (creditErr) throw creditErr;
      logger.warn(`  ${progress} ⚠  Index pass failed (${err.message}) — continuing WITHOUT an index for this run (will retry next run).`);
      topicIndex = [];
    }
  }

  logger.info(`  ${progress} 🤖 Generating notes for: ${sessionLabel} [${group}]`);

  const prompt = buildSessionPrompt(transcript, sessionLabel, topicIndex);

  try {
    const response = await client.chat.completions.create({
      model:    DEEPSEEK_MODEL,
      messages: [{ role: 'user', content: prompt }],
      // Disable thinking mode for structured output — faster and cheaper
      // Remove this if you want deeper reasoning (uses more tokens)
    });

    const raw = response.choices[0]?.message?.content || '';
    if (!raw.trim()) {
      logger.error(`  ${progress} ✗  DeepSeek returned empty response for ${sessionLabel}`);
      return null;
    }

    const { markdown, flags } = splitDraftAndFlags(raw);

    fs.writeFileSync(draftPath, markdown, 'utf8');
    fs.writeFileSync(flagsPath, JSON.stringify({
      recordingBaseName,
      generatedAt: new Date().toISOString(),
      flags,
    }, null, 2), 'utf8');

    // Structured, machine-readable counterpart of the draft — the source for
    // the XLSX export. Read by vision-patch.js (which adds visual
    // confirmations + verification) and src/generate-xlsx.js.
    const structured = parseStructuredData(raw);
    writeSessionData(group, sessionId, {
      group,
      sessionId,
      sessionDate,
      recordingBaseName,
      generatedAt: new Date().toISOString(),
      summary: structured.summary,
      topics: structured.topics,
      problems: structured.problems,
      verification: { hallucinated: [], omitted: [] },
    });

    logger.info(`  ${progress} ✓  Saved → ${path.relative(OUTPUT_DIR, draftPath)}` +
      (flags.length ? ` (${flags.length} vision check(s) flagged)` : ''));
    return { label: sessionLabel, notes: markdown, group };

  } catch (err) {
    const creditErr = toCreditErrorOrNull(err);
    if (creditErr) throw creditErr;
    logger.error(`  ${progress} ✗  DeepSeek error for ${sessionLabel}: ${err?.message || err}`);
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  logger.info('============================================================');
  logger.info(' Meeting Notes Generator — DeepSeek AI');
  logger.info('============================================================');

  if (!DEEPSEEK_KEY) {
    logger.error('[error] DEEPSEEK_API_KEY is not set in .env');
    logger.error('  Add your key from https://platform.deepseek.com/');
    process.exit(1);
  }

  // Walk output/<group>/<session-id>/transcripts/pure-english/*.txt across
  // every group and session on disk — shared with verify-notes.js (Stage 2.5)
  // so this discovery loop isn't duplicated a second time (session-paths.js).
  const sessionFiles = listPureEnglishTranscripts(); // {txtPath, group, sessionId}

  if (sessionFiles.length === 0) {
    logger.error('[error] No *-pure-english.txt files found under any');
    logger.error('  output/<group>/<session-id>/transcripts/pure-english/. Run npm run pure-english first.');
    process.exit(1);
  }

  const client = createDeepSeekClient(DEEPSEEK_KEY);
  logger.info(`[info] Model    : ${DEEPSEEK_MODEL}`);
  logger.info(`[info] Sessions : ${sessionFiles.length}`);
  logger.info(`[info] Output   : output/<group>/<session-id>/notes/draft.md + flags.json + session-data.json`);
  logger.info(`[info] Next     : npm run vision-capture / vision-caption / vision-patch`);
  logger.info(`[info]           to turn flagged drafts into patched notes/final.md`);
  logger.info(`[info]           (final.md is the human-readable deliverable; run npm run xlsx or`);
  logger.info(`[info]           the pipeline with --format xlsx to export structured data to Excel)`);
  logger.info(`[info] Resume   : existing session notes will be skipped\n`);

  const total      = sessionFiles.length;
  let   doneCount  = 0;
  const groupsSeen = new Set();

  for (let i = 0; i < sessionFiles.length; i++) {
    const progress = `[${i + 1}/${total}]`;
    const { txtPath, group, sessionId } = sessionFiles[i];
    try {
      const result = await generateSessionNotes(client, txtPath, group, sessionId, progress);
      if (result) {
        groupsSeen.add(result.group);
        doneCount++;
      }
    } catch (err) {
      exitOnCreditExhaustion(err, {
        serviceLabel: 'DeepSeek',
        topUpUrl: 'https://platform.deepseek.com/',
        resumeCmd: 'npm run meeting-notes',
        currentItem: path.basename(txtPath),
        doneCount,
        totalCount: total,
      });
      throw err;
    }
  }

  logger.info('\n============================================================');
  logger.info(' All done!');
  logger.info(' Per-session drafts : output/<group>/<session-id>/notes/draft.md');
  logger.info(' Structured data    : output/<group>/<session-id>/notes/session-data.json');
  logger.info(` Groups found      : ${groupsSeen.size} (${[...groupsSeen].join(', ')})`);
  logger.info(' Run vision-capture / vision-caption / vision-patch next to get');
  logger.info(' patched final.md files. Then export structured notes to Excel');
  logger.info(' via "npm run xlsx" (or npm run pipeline -- --format xlsx).');
  logger.info('============================================================\n');
}

module.exports = {
  main,
  splitDraftAndFlags,
  buildSessionPrompt,
  buildIndexPrompt,
  parseTopicIndex,
  runIndexPass,
  generateSessionNotes,
};

if (require.main === module) {
  main().catch((err) => {
    logger.error('\n[fatal error]', err.message || err);
    process.exit(1);
  });
}

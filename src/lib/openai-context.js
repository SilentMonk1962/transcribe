'use strict';

/**
 * openai-context.js — the two OpenAI calls behind the context stage.
 *
 *   scanTranscript()  TEXT ONLY. Which lines need the screen to be understood?
 *     Input : L42 [12:04 → 12:11] Speaker 2: This button looks off here.
 *     Output: { line: 42, timestampSeconds: 727, whatToLookFor: "the button…" }
 *
 *   describeFrame()   VISION. A 1–3 sentence pen picture of what the speaker
 *     points at in one frame, or null when the frame doesn't show it.
 *
 * Every model answer is validated, never trusted (see sanitizeRequests).
 */

const fs = require('fs');
const { config } = require('./config');
const { formatTime } = require('./format');

const SCAN_PROMPT = `You review transcripts of screen-shared product/UX meetings about a fintech application. Speakers are looking at the application on screen while they talk.

Your job: find the transcript lines that CANNOT be fully understood from the words alone, because the speaker is referring to something visible on screen. Typical signals:
- deictic references: "this", "that", "here", "there", "this one", "the one on the left"
- an on-screen element that is referred to but not named (a button, field, tab, banner, modal, table, chart)
- visual properties that are judged but not stated: colour, spacing, alignment, size, overlap, cut-off text
- an error or message on screen that is mentioned but not read out word for word

Do NOT pick a line when:
- the words already say exactly what is on screen
- the reference is to something not on screen (a past meeting, a document, a person)
- it is small talk, audio checks, or scheduling

Choose as many lines as are genuinely needed, including zero. Accuracy over recall.

Respond ONLY with a JSON object of this exact shape:
{"requests":[{"line":<int>,"timestampSeconds":<int>,"whatToLookFor":"<one sentence naming exactly what to identify on screen>"}]}

"line" is the L-number shown. "timestampSeconds" is a whole second inside that line's [start → end] range where the thing is most likely visible. Use {"requests":[]} when nothing qualifies.`;

const NOT_VISIBLE = 'NOT_VISIBLE';

/**
 * Keeps only valid requests for one batch:
 *   - line must belong to the batch; whatToLookFor must be non-empty
 *   - a timestamp outside the line's [start, end] is moved to its midpoint
 *   - duplicate (line, second) pairs collapse
 *
 * @param {Array} raw
 * @param {Map<number, {start: number, end: number}>} byIndex
 * @returns {Array<{line: number, timestampSeconds: number, whatToLookFor: string}>}
 */
function sanitizeRequests(raw, byIndex) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(raw) ? raw : []) {
    const line = Number.parseInt(r?.line, 10);
    const entry = byIndex.get(line);
    const what = typeof r?.whatToLookFor === 'string' ? r.whatToLookFor.trim() : '';
    if (!entry || !what) continue;

    let ts = Math.round(Number(r?.timestampSeconds));
    if (!Number.isFinite(ts) || ts < Math.floor(entry.start) || ts > Math.ceil(entry.end)) {
      ts = Math.round((entry.start + entry.end) / 2);
    }
    const key = `${line}:${ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ line, timestampSeconds: ts, whatToLookFor: what });
  }
  return out;
}

/**
 * Scans timed transcript lines in batches (CONTEXT_SCAN_BATCH_LINES, default
 * 150) so no call nears the model's input limit. Throws on a malformed
 * response so the recording is retried next run.
 *
 * @param {import('openai').OpenAI} client
 * @param {Array<{index: number, entry: object}>} timed - lines with start/end
 * @returns {Promise<Array<{line: number, timestampSeconds: number, whatToLookFor: string}>>}
 */
async function scanTranscript(client, timed) {
  const size = config.contextScanBatchLines();
  const requests = [];
  for (let i = 0; i < timed.length; i += size) {
    const batch = timed.slice(i, i + size);
    const text = batch.map(({ index, entry }) =>
      `L${index} [${formatTime(entry.start)} → ${formatTime(entry.end)}]` +
      `${entry.speaker ? ` ${entry.speaker}:` : ''} ${entry.text}`).join('\n');

    const res = await client.chat.completions.create({
      model: config.openaiModel(),
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SCAN_PROMPT }, { role: 'user', content: text }],
    });
    let parsed;
    try {
      parsed = JSON.parse(res.choices[0]?.message?.content || '');
    } catch (err) {
      throw new Error(`scan returned invalid JSON (${err.message})`);
    }
    requests.push(...sanitizeRequests(parsed.requests, new Map(batch.map((b) => [b.index, b.entry]))));
  }
  return requests;
}

/**
 * True when the model said the frame doesn't show what was asked. Loose on
 * purpose: "NOT_VISIBLE.", "not visible", "Not-visible" all count.
 * @param {string} text
 */
function isNotVisible(text) {
  return !text || /^\W*not[\s_-]*visible\b/i.test(text.trim());
}

/**
 * Describes one frame. Returns the pen picture, or null when not visible.
 *
 * @param {import('openai').OpenAI} client
 * @param {string} imagePath
 * @param {{whatToLookFor: string, spokenText?: string, speaker?: string|null}} ask
 * @returns {Promise<string|null>}
 */
async function describeFrame(client, imagePath, ask) {
  const said = ask.spokenText ? `${ask.speaker || 'A speaker'} said: "${ask.spokenText}"\n` : '';
  const prompt = `This is one still frame from a screen-shared meeting about a fintech application.

${said}What to identify on screen: ${ask.whatToLookFor}

Write a pen picture of ONLY the on-screen element(s) the speaker is referring to, in 1-3 factual sentences, so a reader who cannot see the screen understands what was meant. Name the screen/page if visible, the element, its exact label text, colour, state and position. Quote on-screen text exactly.

If the frame does not clearly show what is asked, reply with exactly ${NOT_VISIBLE} and nothing else. Never guess or invent details.`;

  const base64 = fs.readFileSync(imagePath).toString('base64');
  const res = await client.chat.completions.create({
    model: config.openaiModel(),
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
      ],
    }],
  });
  const text = res.choices[0]?.message?.content?.trim() || '';
  return isNotVisible(text) ? null : text;
}

module.exports = { scanTranscript, describeFrame, sanitizeRequests, isNotVisible };

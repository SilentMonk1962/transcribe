# Meeting Notes Pipeline — How It Works & How To Use It

_A plain-English guide for product managers. Covers: what the service does, the Teams-to-notes workflow, what you get back, and all the edge cases it already handles for you._

## 1. What this is

This is a command-line tool that turns a **Teams meeting recording** into a set of **clean, structured meeting notes**:

- Video recording → audio
- Audio → full transcript (with speaker diarization — it knows roughly who said what)
- Transcript → clean English text
- Transcript → **draft meeting notes**: topics covered, problems faced, feature requests, and an action list
- Notes → **one Excel workbook** containing every session's problems, topics, action items, and gaps — nothing raised in a call is dropped

It also has an optional **vision-assist** step: when a meeting discussed something on-screen (a UI, a dashboard, a config screen), it can capture the exact moment on screen and weave a short visual confirmation into the notes.

> **Intended for:** everyone who regularly records customer/product calls (especially bilingual ones) and needs accurate, organized notes afterward — without listening to hours of audio.

## 2. What you need before you start

1. **Node.js** installed (version 18 or newer). Check with `node -v` in a terminal.
2. **Dependencies installed.** Open a terminal in the project folder (`transcribe-audio-recordings/`) and run `npm install` once.
3. **API keys in a file called `.env`.** Copy `.env.example` to `.env` and paste in three keys:
   - `SARVAM_API_KEYS` — Sarvam AI key(s) for transcription. Get one at dashboard.sarvam.ai. You can list several comma-separated; if one runs out of credits mid-run, the tool automatically switches to the next.
   - `DEEPSEEK_API_KEY` — DeepSeek key for writing the notes. Get one at platform.deepseek.com.
   - `OPENAI_API_KEY` — OpenAI key for the on-screen visual checks. Get one at platform.openai.com.
4. **An input folder** called `input/` inside the project folder — this is where you drop recordings.

> **Where does each recording go?** The tool groups recordings by **folder** first: put recordings of the same recurring meeting inside a sub-folder of `input/` (e.g. `input/my-project/…`) and that folder name becomes the group. For recordings dropped directly at the `input/` root, it falls back to name matching via `groups.config.json` (rules like "files with 'AECB Scenario review' in the name belong to `aecb-scenario-review`"), and anything matching nothing lands in `ungrouped` and is flagged in the console so you notice and can add a rule.

## 3. The Teams → notes recipe (step by step)

### 3.1 Download the recording from Teams

1. Open the meeting in the **Teams app** and go to the meeting's **Chat** tab (the conversation tied to that meeting).
2. Scroll up to the **Recording** entry — Teams posts a recording card there automatically after the call.
3. Click the **Download** icon on the recording card. Teams saves a **video file** (usually `.mp4`, sometimes `.mov`).
4. (Optional but handy) If a transcript was enabled, you can also grab the transcript — but you don't need to; the pipeline generates its own transcript.

> **Tip:** The recording filename automatically contains the date + time the call started (for example `...-20260724_121411-Meeting Recording.mp4`). Keep that part of the name — it's how the tool knows the session date and how it tells two meetings apart.

### 3.2 Save the file into the input folder

1. Find the project folder: `Application Journey Revamp/transcribe-audio-recordings/`.
2. Move/copy the downloaded video into the `input/` subfolder inside it.
3. You can drop in **several recordings at once** — the pipeline processes them all in one run.

### 3.3 Run the pipeline

1. Open a **terminal** and go to the project folder:
   ```
   cd "Application Journey Revamp/transcribe-audio-recordings"
   ```
2. Run the whole thing:
   ```
   npm run pipeline
   ```
3. Wait. It streams progress to the screen. Depending on length and the number of files, this takes from a few minutes to an hour or two.

> **Important:** run long steps like `npm run pipeline` from **your own terminal** window, not through a chat assistant's tool that can be interrupted. Interruptions mid-run are safe (you can just re-run — finished parts are skipped) but a fully completed run is the smoothest experience.

## 4. What you get back

Everything is written under `output/`, organized as `output/<group>/<session-date>/`.

### The two things you'll actually open

| File | What it is |
|---|---|
| `output/<group>/<group>-meeting-notes.xlsx` | The main deliverable — **one workbook per group** (one recurring meeting). Each workbook has five sheets: |
| &nbsp;&nbsp;• Problems | Every problem raised, with who raised it (*Raised By*), status, and any visual confirmation. |
| &nbsp;&nbsp;• Topics | Every topic/concept covered, with key parameters and examples. |
| &nbsp;&nbsp;• Summary | One row per session: how many topics, problems, feature requests, open items, and flagged items. |
| &nbsp;&nbsp;• Action Items | Every problem that has a feature request — i.e. the things that actually need to be done. |
| &nbsp;&nbsp;• Gaps & Risks | Points the verification step flagged for a human to double-check (possible hallucinations or omissions). |
| `output/<group>/<session>/notes/final.md` | The polished, per-session write-up — the version you read top-to-bottom for one meeting. |

> **One-off calls stay separate.** Recordings in the catch-all `ungrouped` bucket are deliberately NOT merged into a workbook — they're unrelated calls, so they never get consolidated. There is no all-groups "master" file anymore (removed 2026-08-03): each group gets its own workbook.

> **About the "Raised By" column:** the tool labels speakers as **"Speaker 1"**, **"Speaker 2"**, etc., because it can tell speakers apart but not their real names. Before sharing the workbook, replace those labels with real names (this is a quick find-and-replace in Excel).

## 5. Running one step at a time

You don't have to run the whole pipeline. Each step has its own command, so you can re-run just the piece you need. All of them resume safely — if a step is already done, re-running skips it.

| Command | What it does |
|---|---|
| `npm run convert-only` | Video → audio. Long recordings are automatically cut into ~60-minute chunks here. |
| `npm run transcribe-only` | Audio → transcript (Sarvam AI). |
| `npm run merge-chunks` | Stitches chunked recordings' transcripts back into one continuous transcript. (No-op for short recordings.) |
| `npm run pure-english` | Transcript → clean English text. |
| `npm run meeting-notes` | English text → draft notes (topics, problems, feature requests) + the structured data used for Excel. |
| `npm run verify-notes` | Independent cross-check of the draft against the full transcript, flagging possible hallucinations/omissions. |
| `npm run vision-capture` | Captures the exact on-screen frames that the notes flagged. |
| `npm run vision-caption` | Captions those frames (OpenAI). |
| `npm run vision-patch` | Weaves the captions into `final.md` as visual confirmations. |
| `npm run xlsx` | Rebuilds the Excel workbook from existing notes. |
| `npm run md` | Same as Excel, but as a markdown/plain-text rollup instead. |

## 6. Features & edge cases it already handles

- **Never mixes unrelated calls.** Recordings are grouped by folder (or, at the `input/` root, by name rules); each group stays separate in the output.
- **Two meetings on the same day?** The tool asks you once, in the terminal: *"same session or separate?"* Answer `S` (same) or `P` (separate). It remembers your answer for next time.
- **Long recordings.** Anything over ~60 minutes is automatically split into chunks before transcription, then stitched back into one continuous transcript with corrected timestamps.
- **Credits running out mid-run.** If a Sarvam key runs out of credits, the tool automatically switches to the next key in `SARVAM_API_KEYS` and keeps going, printing which key it switched to. If *all* keys are exhausted, it stops cleanly with a "top up and re-run" message — nothing already done is lost.
- **Resume-friendly.** Any interruption (power loss, laptop close, credit stop) — just re-run and it picks up where it left off.
- **Hallucination guardrails.** The notes step reads the whole transcript once to build a topic index, then drafts notes aware of it (so a topic mentioned early and again late isn't duplicated or lost). A separate verification step independently re-checks the draft against the transcript and flags anything that looks invented or missing — flagged items go to the *Gaps & Risks* sheet for a human to review, never silently into the notes.
- **Smart screenshots.** It captures only the exact moments the notes flagged as needing a visual check — not every 90 seconds. If the source video was deleted after conversion, it notes that plainly and continues.
- **Excel guarantees completeness.** The workbook is built directly from structured data, not a summarized text rollup — so every problem and every feature request survives as its own row.

## 7. Gotchas & FAQ

- **Run from your own terminal.** The paid, long-running steps shouldn't be kicked off from a chat assistant's sandbox (a killed process can't be resumed mid-flight for the transcription service).
- **"Speaker N" is a placeholder.** The tool can't know real names; swap them in before sharing.
- **Don't delete `final.md` casually.** Deleting it forces the vision step to redo it. If you just want fresher notes, delete `notes/draft.md`, `notes/final.md`, and `notes/session-data.json` together and re-run `meeting-notes` onward — or simply re-run the whole pipeline.
- **Files left over from an older version.** Older runs produced `output/<group>/master-meeting-notes.md` files. Those are now superseded by the Excel workbook; you can delete them if you like — nothing generates them anymore.
- **"Ungrouped" recordings.** If a recording matches neither a folder nor a name rule, it lands in `ungrouped` and the console tells you. Give it a proper home by moving it into an `input/<group>/` sub-folder (or adding a rule in `groups.config.json`).
- **Where are the API keys?** In `.env`, which is private (never commit it). Copy `.env.example` to `.env` when setting up a new machine.
- **Anything deleted from `input/`?** Source videos get cleaned up over time; if a video is gone when a vision check runs, the notes say so instead of failing the whole run.

# Contextual Transcript Pipeline — How It Works

Turns a Teams meeting recording into **one English transcript with on-screen context written in**.

## 1. Setup

1. Node.js 18+, then `npm install`.
2. Copy `.env.example` to `.env` and set:
   - `SARVAM_API_KEYS`: Sarvam key(s), comma-separated. When one runs out of credit, the next is used.
   - `OPENAI_API_KEY` (+ optional `OPENAI_MODEL`): used for the screen context.
3. Put recordings in a folder under `input/`. The folder is the group (e.g. `input/kyc/…` → group `kyc`); files at the `input/` root go to `ungrouped`.

> Keep the original video in `input/` until its transcript is finished. Screen frames come from it.

## 2. Run

```
npm run pipeline                               # checks status, asks for budget consent, runs
npm run pipeline -- --yes                      # no budget prompt (automation)
```

## 3. What happens

| Step | Engine | What it does |
|---|---|---|
| Status | local | Sorts each recording: **done** (₹0), **transcribed** (OpenAI only), **new** (Sarvam + OpenAI) |
| Missing videos | local | Transcribed recordings whose video is gone are finished without screen context (₹0) — one summary line, no prompt |
| Budget | local | Estimates **pending work only**. No prompt when the total is ₹0 |
| 1. convert | ffmpeg | Video → audio. Recordings over 60 min are split into chunks. Finished recordings are skipped |
| 2. transcribe | Sarvam | Audio → English transcript with speakers. Chunked recordings are merged back into one timeline |
| 3. context | OpenAI + ffmpeg | Finds lines that point at the screen, grabs those frames, writes a pen picture of each, puts it under its line, then deletes every intermediate (including the audio) |
| Summary | local | Lists anything not finished and why |

Each step can also be run alone: `npm run convert`, `npm run transcribe`, `npm run context`. Finished work is always skipped.

## 4. Output

`output/<group>/<session-id>/<recording>-contextual.txt` is the only file left once a recording is finished.

```
SCREEN  : 1 note(s) added (2 frame(s) requested, 1 not visible)

[00:06 → 00:14]  Speaker 2:
  This button looks off here.
  [SCREEN @ 00:10] The 'Submit' CTA on the KYC page is grey instead of blue.
```

The `SCREEN` line in the header always states the outcome:
- `N note(s) added (…)`: context was added.
- `none needed`: no line pointed at the screen.
- `unavailable — source video not found in input/`: the video was gone, so no screen context.

## 5. Edge cases

| Situation | Behaviour |
|---|---|
| Recording already finished | Listed as done, costs ₹0, never converted or billed again |
| Credits run out | Stops with exit code 2. Top up and re-run; finished work is kept |
| Frame does not show what was asked | Nothing added for that line; counted as "not visible" |
| Frame capture or description fails | Retried on the next run (2 attempts), then skipped and counted as failed |
| Same file name in two group folders | The video in the recording's own group folder is used |
| Two recordings from the same day in one group | Asked once: same session or separate (default separate) |
| Speaker numbers across 60-min chunks | Not reconciled; each chunk is diarized on its own |

## 6. Budget example (one new 60-min recording)

| Item | Estimate |
|---|---|
| Sarvam, 60 min × ₹45/hr | ₹45 |
| OpenAI scan + 10 assumed frames | ≈ ₹0.5 |
| **Total** | **≈ ₹45.5** |

The rates can be changed in `.env` (`SARVAM_PRICE_PER_HOUR_INR`, `USD_INR_RATE`, `OPENAI_PRICE_INPUT_PER_M`, `OPENAI_PRICE_OUTPUT_PER_M`, `OPENAI_ASSUMED_FRAMES_PER_SESSION`).

# Contextual Transcript Pipeline — How It Works

Turns a Teams meeting recording into **one English transcript with on-screen context written in**. No meeting notes; the transcript itself carries the context.

## 1. Setup

1. Node.js 18+, then `npm install`.
2. Copy `.env.example` to `.env` and set:
   - `SARVAM_API_KEYS`: Sarvam key(s), comma-separated. The pipeline switches to the next key when one runs out of credit.
   - `OPENAI_API_KEY` (+ optional `OPENAI_MODEL`): used for both screen-context stages.
3. Drop recordings into `input/`. A sub-folder (e.g. `input/kyc/…`) becomes the group.

> Keep the original video in `input/` until the run finishes. Screen frames are taken from it.

## 2. Run

```
npm run pipeline            # asks for budget consent, then runs everything
npm run pipeline -- --yes   # no prompt (automation)
```

## 3. Stages

| # | Stage | Engine | What it does |
|---|---|---|---|
| 1 | convert | ffmpeg | Video → audio. Recordings over 60 min are split into chunks |
| 2 | transcribe | Sarvam | Audio → English transcript with speakers (translate mode only) |
| 3 | merge-chunks | local | Joins chunked recordings into one timeline |
| 4 | context-scan | OpenAI (text) | Finds lines that need the screen to be understood ("this button", "that error") |
| 5 | frame-capture | ffmpeg | Takes a frame from the video at each of those moments |
| 6 | frame-describe | OpenAI (vision) | Writes a short pen picture of what the speaker points at |
| 7 | context-inject | local | Places each description under its line and deletes all intermediates |

Every stage can also be run alone (`npm run context-scan`, etc.) and skips work that is already done.

## 4. Output

`output/<group>/<session-id>/<recording>-contextual.txt` is the **only** file left in a finished session folder.

```
SCREEN  : 1 note(s) added (2 frame(s) requested, 1 not visible)

[00:06 → 00:14]  Speaker 2:
  This button looks off here.
  [SCREEN @ 00:10] The 'Submit' CTA on the KYC page is grey instead of blue.
```

The `SCREEN` header line always states the outcome:
- `N note(s) added (…)`: context injected.
- `none needed`: no line referred to the screen.
- `unavailable — source video not found in input/`: transcript written without context.

## 5. Edge cases

| Situation | Behaviour |
|---|---|
| Credits run out | Stops with exit code 2. Top up and re-run; finished work is kept |
| Frame does not show what was asked | Nothing injected for that line; counted as "not visible" |
| Frame description errors | Retried on the next run (2 attempts), then skipped and counted |
| Re-run after completion | Nothing is re-billed; finished recordings are skipped at every stage |
| Speaker numbers across 60-min chunks | Not reconciled; each chunk is diarized on its own |

## 6. Budget example (one 60-min recording)

| Item | Estimate |
|---|---|
| Sarvam, 60 min × ₹45/hr | ₹45 |
| OpenAI context scan | ≈ ₹0.3 |
| OpenAI frames (10 assumed) | ≈ ₹0.2 |
| **Total** | **≈ ₹45.5** |

## 7. Old output folders (one-time)

Sessions from the old notes pipeline still hold codemix, pure-english, notes, screenshots and exports.

```
npm run cleanup-legacy -- --dry-run   # list what would change
npm run cleanup-legacy                # apply (asks y/N)
npm run pipeline                      # rebuild them as contextual transcripts
```

The English Sarvam JSON is kept, so Sarvam is not billed again.

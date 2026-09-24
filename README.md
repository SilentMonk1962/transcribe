# Meeting Recording → Transcript (with screen context)

Drop in a Teams meeting recording and get back one clean English transcript. It shows who spoke, when they spoke, and, wherever someone says things like "this button" or "that error", a short note describing what was on the screen at that moment.

Example of the output:

```
[12:04 → 12:11]  Speaker 2:
  This button looks off here.
  [SCREEN @ 12:07] The 'Submit' button on the KYC page is grey instead of blue.
```

---

## 1. One-time setup (about 10 minutes)

### a. Install two free tools
- **Node.js** (version 18 or newer): https://nodejs.org → download the "LTS" version and install it.
- **Git**: already on most Macs. To check, open Terminal and type `git --version`. If it isn't installed, macOS will offer to install it.

### b. Get the code
Ask Abhishek to give you access to the GitHub repo first. Then, in Terminal:

```bash
cd ~/Documents
git clone https://github.com/SilentMonk1962/transcribe.git
cd transcribe
npm install
```

### c. Get your own keys
Each person uses **their own** keys, and you pay for your own usage.

| Key | Used for | Where to get it |
|---|---|---|
| Sarvam | Turning speech into English text | https://dashboard.sarvam.ai → API Keys |
| OpenAI | Looking at the screen and describing it | https://platform.openai.com → API keys (add a small amount of credit under Billing) |

### d. Put your keys in a settings file
In the `transcribe` folder:

```bash
cp .env.example .env
open -e .env
```

Replace the two placeholder lines with your keys, then save:

```
SARVAM_API_KEYS=your-sarvam-key
OPENAI_API_KEY=your-openai-key
```

If you have more than one Sarvam key, separate them with commas (`key1,key2`). When one key runs out, the next one is used automatically.

> Never share your `.env` file or paste your keys anywhere. Git ignores this file, so it never gets uploaded.

---

## 2. Every time you have a recording

1. **Download the recording** from the Teams meeting chat (the Recording card → Download). Keep the file name as it is, because it contains the meeting date and time.
2. **Put it in a project folder** inside `input/`, for example:
   ```
   input/kyc/KYC Review-20260708_110318-Meeting Recording.mp4
   ```
   The folder name (`kyc`) is used to group related meetings. Create the folder if it doesn't exist.
3. **Run it** from the `transcribe` folder:
   ```bash
   npm run pipeline
   ```
4. **Check the cost.** Before spending anything it shows an estimate, for example:
   ```
   Sarvam : 60 min × ₹45/hr → ₹45.0
   OpenAI : 1 recording(s) → ₹0.5
   TOTAL  : ≈ ₹45.5
   This run is estimated to cost ≈ ₹45.5. Continue? [y/N]
   ```
   Type `y` and press Enter. Anything else cancels, and nothing is charged.
5. **Wait.** It takes a few minutes per recording. Leave Terminal open.
6. **Get your transcript:**
   ```
   output/kyc/20260708_110318/KYC Review-20260708_110318-Meeting Recording-contextual.txt
   ```
   This is the only file in that folder once the recording is finished. Now you can delete the video from `input/`.

---

## 3. Good to know

- **Keep the video in `input/` until the run finishes.** The screen notes are taken from the video. If the video is missing, you still get the transcript, just without screen notes.
- **Running it again is safe.** Recordings that are already finished are skipped and cost ₹0. If a run stops halfway, run it again and it continues from where it stopped.
- **Two meetings on the same day in the same folder:** it asks once whether they are the same session. Press Enter for "separate" if you're unsure.
- **Recordings longer than 60 minutes** are split into parts automatically and joined back into one transcript. Speaker numbers may not match across each 60-minute part.
- **Speaker names aren't known.** The transcript says "Speaker 1", "Speaker 2" and so on.
- **Cost guide:** about ₹45 per hour of recording, plus under ₹1 for the screen notes.

---

## 4. If something goes wrong

| You see | What to do |
|---|---|
| `Missing in .env: SARVAM_API_KEYS` or `OPENAI_API_KEY` | Add that key to `.env` (step 1d) and save. |
| `SARVAM CREDITS EXHAUSTED` or `OPENAI CREDITS EXHAUSTED` | Top up that account, then run `npm run pipeline` again. Nothing already finished is lost. |
| `N recording(s) not finished` at the end | Run `npm run pipeline` again. If it keeps failing, send the message to Abhishek. |
| `command not found: npm` | Node.js isn't installed (step 1a). Close and reopen Terminal after installing. |
| Nothing happens / "Nothing to do" | Check the video is inside a folder under `input/` and ends in .mp4, .mov, .mkv, .avi, .webm or .m4v. |

---

## 5. Getting updates

When you're told there's a new version:

```bash
cd ~/Documents/transcribe
git pull
npm install
```

Your `.env`, videos and transcripts are not touched.

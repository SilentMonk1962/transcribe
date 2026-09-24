'use strict';

/**
 * status.js — READ-ONLY view of where every recording stands, taken before
 * the pipeline spends anything. Never prompts, never writes.
 *
 * States:
 *   done        <name>-contextual.txt exists              → costs ₹0
 *   transcribed English JSON exists, context not finished  → OpenAI only
 *   new         only the video exists                     → Sarvam + OpenAI
 *
 * Example: input/ holds A (done), B (new, 60 min); output/ holds C
 * (transcribed, video deleted) → A ₹0 · B ≈ ₹45.5 · C finished without screen context, ₹0.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const {
  DEFAULT_GROUP,
  peekSession,
  translateDir,
  contextualTranscriptPath,
  listTranslatedRecordings,
} = require('./sessions');
const { walkInputVideos, findSourceVideo } = require('./input-walk');

/**
 * @returns {Array<{group: string, sessionId: string, baseName: string,
 *   state: 'done'|'transcribed'|'new', videoPath: string|null, jsonPath: string|null}>}
 */
function snapshot() {
  const inputDir = config.inputDir();
  const byKey = new Map();

  for (const v of walkInputVideos(inputDir)) {
    const { group, effectiveSessionId: sessionId } = peekSession(v.baseName, v.relDir || DEFAULT_GROUP);
    const key = `${group}/${sessionId}/${v.baseName}`;
    if (byKey.has(key)) continue;
    const jsonPath = path.join(translateDir(group, sessionId), `${v.baseName}.json`);
    const state = fs.existsSync(contextualTranscriptPath(group, sessionId, v.baseName)) ? 'done'
      : fs.existsSync(jsonPath) ? 'transcribed' : 'new';
    byKey.set(key, { group, sessionId, baseName: v.baseName, state, videoPath: v.fullPath, jsonPath: state === 'transcribed' ? jsonPath : null });
  }

  // Transcribed recordings whose video may have left input/.
  for (const r of listTranslatedRecordings()) {
    const key = `${r.group}/${r.sessionId}/${r.baseName}`;
    if (byKey.has(key) || fs.existsSync(contextualTranscriptPath(r.group, r.sessionId, r.baseName))) continue;
    byKey.set(key, {
      group: r.group,
      sessionId: r.sessionId,
      baseName: r.baseName,
      state: 'transcribed',
      videoPath: findSourceVideo(inputDir, r.baseName, r.group, DEFAULT_GROUP),
      jsonPath: r.jsonPath,
    });
  }
  return [...byKey.values()];
}

module.exports = { snapshot };

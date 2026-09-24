'use strict';

/**
 * modes.js — single source of truth for WHICH Sarvam STT passes run.
 *
 * WHY THIS EXISTS:
 *   The number of Sarvam passes decides (a) how much audio is billed per
 *   recording and (b) the budget estimate the pipeline shows before it
 *   spends anything. transcribe.js, merge-chunks.js, and the budget module
 *   (src/lib/budget.js) previously each interpreted SARVAM_TRANSLATE_ONLY
 *   their own way — if they ever disagreed, the estimate and the actual
 *   spend would drift apart. All three now read this one helper.
 *
 * DEFAULT = TRANSLATE-ONLY (2026-08-06):
 *   The codemix (Hinglish-verbatim) pass is consumed by NO downstream stage —
 *   pure-english.js copies the translate output, and meeting notes are
 *   English-only. So the default is now to run ONLY the English 'translate'
 *   pass, halving billed Sarvam audio-minutes. Codemix remains available by
 *   explicitly setting SARVAM_TRANSLATE_ONLY=0 (or 'false').
 *
 *   Old behavior (default both passes) existed so the value '1' could opt
 *   INTO translate-only; that inversion was confirmed with the user
 *   2026-08-06 as part of the budget-consent build.
 */

/**
 * @returns {boolean} true when only the English 'translate' pass runs.
 *   True unless SARVAM_TRANSLATE_ONLY is explicitly '0' or 'false'
 *   (case-insensitive) — i.e. unset/anything-else means translate-only.
 */
function isTranslateOnly() {
  const v = process.env.SARVAM_TRANSLATE_ONLY;
  if (v == null) return true;
  const s = String(v).trim().toLowerCase();
  return !(s === '0' || s === 'false');
}

/**
 * @returns {Array<'codemix'|'translate'>} the modes that will actually run,
 *   in execution order.
 */
function translationModes() {
  return isTranslateOnly() ? ['translate'] : ['codemix', 'translate'];
}

module.exports = { isTranslateOnly, translationModes };

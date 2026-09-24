'use strict';

/**
 * sarvam-keys.js — single source of truth for Sarvam API keys.
 *
 * WHY THIS EXISTS:
 *   Every Sarvam-consuming stage (historically transcribe.js and a
 *   separate pure-english pass) used to each read their own env
 *   variables (SARVAM_API_KEY, SARVAM_API_KEY_FALLBACK, SARVAM_TRANSLATE_API_KEY).
 *   That fragmented the keys across stages and forced manual key swaps when
 *   credits ran out. This module is ONE key pool, read once, shared by every
 *   Sarvam stage, that rotates automatically on credit exhaustion.
 *
 * ENV VAR PRECEDENCE:
 *   1. SARVAM_API_KEYS=key1,key2,key3   (comma-separated list — preferred)
 *   2. SARVAM_API_KEY + SARVAM_API_KEY_FALLBACK  (legacy — still works)
 *
 * USAGE:
 *   const { SarvamKeyPool } = require('./lib/sarvam-keys');
 *   const pool = new SarvamKeyPool();        // reads process.env once
 *   let client = pool.currentClient();       // SarvamAIClient with active key
 *   // ... on a credit error:
 *   pool.markExhausted();                    // advances to the next key
 *   if (pool.isExhausted()) { ... }           // clean exit
 *   client = pool.currentClient();           // next key, or null if all gone
 *
 * NOTE: this module creates SarvamAIClient instances but never makes API
 * calls itself — it only owns key discovery, rotation bookkeeping, and the
 * human-readable "which key am I on" logging.
 */

const { SarvamAIClient } = require('sarvamai');

class SarvamKeyPool {
  constructor() {
    /** @type {string[]} */
    this.keys = SarvamKeyPool._loadKeys();
    /** @type {number} index of the key currently in use (0-based) */
    this.currentIndex = 0;
  }

  /**
   * Discovers the configured Sarvam keys from the environment.
   * Prefers the new SARVAM_API_KEYS list; falls back to the legacy
   * SARVAM_API_KEY / SARVAM_API_KEY_FALLBACK pair.
   *
   * @returns {string[]}
   */
  static _loadKeys() {
    const rawList = process.env.SARVAM_API_KEYS;
    if (rawList) {
      const keys = rawList
        .split(',')
        .map((k) => (k || '').trim())
        .filter(Boolean);
      if (keys.length > 0) return keys;
    }

    const keys = [];
    if (process.env.SARVAM_API_KEY) keys.push(process.env.SARVAM_API_KEY.trim());
    if (process.env.SARVAM_API_KEY_FALLBACK) keys.push(process.env.SARVAM_API_KEY_FALLBACK.trim());
    return keys;
  }

  /** @returns {number} total number of configured keys */
  get total() {
    return this.keys.length;
  }

  /** @returns {boolean} true if every key has been marked exhausted */
  isExhausted() {
    return this.currentIndex >= this.keys.length;
  }

  /**
   * Returns a SarvamAIClient bound to the current key, or null if the pool
   * is exhausted.
   *
   * @returns {import('sarvamai').SarvamAIClient|null}
   */
  currentClient() {
    const key = this.keys[this.currentIndex];
    if (!key) return null;
    return new SarvamAIClient({ apiSubscriptionKey: key });
  }

  /**
   * Marks the CURRENT key as exhausted and advances to the next one.
   * Safe to call at the end of the list — isExhausted() reflects the new state.
   */
  markExhausted() {
    this.currentIndex += 1;
  }
}

module.exports = { SarvamKeyPool };

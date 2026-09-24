'use strict';

/**
 * sarvam-keys.js — one shared pool of Sarvam keys that rotates on credit
 * exhaustion (see credit.js → withSarvamKeyRetry).
 *
 * Keys come from SARVAM_API_KEYS=key1,key2,key3 in .env.
 */

const { SarvamAIClient } = require('sarvamai');

class SarvamKeyPool {
  constructor() {
    this.keys = (process.env.SARVAM_API_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
    this.currentIndex = 0;
  }

  get total() {
    return this.keys.length;
  }

  isExhausted() {
    return this.currentIndex >= this.keys.length;
  }

  /** @returns {SarvamAIClient|null} client for the current key, null when exhausted */
  currentClient() {
    const key = this.keys[this.currentIndex];
    return key ? new SarvamAIClient({ apiSubscriptionKey: key }) : null;
  }

  markExhausted() {
    this.currentIndex += 1;
  }
}

module.exports = { SarvamKeyPool };

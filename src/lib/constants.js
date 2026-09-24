'use strict';

/**
 * constants.js — shared constants used by multiple pipeline stages.
 *
 * Eliminates duplication of VIDEO_EXTENSIONS between convert.js and
 * input-walk.js (used by frame-capture.js).
 */

/** Supported video container formats to scan in ./input/ */
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v'];

module.exports = { VIDEO_EXTENSIONS };

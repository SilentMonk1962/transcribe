'use strict';

/**
 * input-walk.js — recursive video discovery under input/, shared by:
 *   - src/lib/budget.js       (probe durations for the pre-run cost estimate)
 *   - src/vision-capture.js   (locate a session's source video even when it
 *                              lives in an input/<group>/ sub-folder)
 *
 * WHY RECURSIVE:
 *   convert.js has always treated a sub-folder under input/ AS a group. The
 *   old vision-capture.js lookup only searched the input/ root flat, so a
 *   grouped video could never be found for flagged-frame capture. Both
 *   consumers now use this one walker so they agree on where videos live.
 */

const fs = require('fs');
const path = require('path');
const { VIDEO_EXTENSIONS } = require('./constants');

/**
 * Recursively finds every video file under inputDir (any depth), skipping
 * dotfiles/.DS_Store. Order is deterministic (depth-first, lexicographic).
 *
 * @param {string} inputDir
 * @returns {string[]} absolute paths to video files
 */
function walkInputVideos(inputDir) {
  return walkInputVideosDetailed(inputDir).map((v) => v.fullPath).sort();
}

/**
 * Like walkInputVideos(), but returns each hit with its folder path RELATIVE
 * to inputDir — convert.js needs that because a sub-folder under input/ IS a
 * group (the folder name becomes the group slug).
 *
 * @param {string} inputDir
 * @returns {Array<{fullPath: string, relDir: string}>}
 */
function walkInputVideosDetailed(inputDir) {
  const out = [];
  if (!fs.existsSync(inputDir)) return out;

  const walk = (dir, relDir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue; // skip .DS_Store, etc.
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, path.join(relDir, entry.name));
      } else if (entry.isFile() && VIDEO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
        out.push({ fullPath: full, relDir });
      }
    }
  };
  walk(inputDir, '');
  return out;
}

/**
 * Recursively finds the source video whose basename (without extension)
 * matches `recordingBaseName`, under inputDir. Tries every known video
 * extension, in every subfolder.
 *
 * @param {string} inputDir
 * @param {string} recordingBaseName
 * @returns {string|null} absolute path, or null if not found
 */
function findInputVideoByName(inputDir, recordingBaseName) {
  for (const full of walkInputVideos(inputDir)) {
    if (path.basename(full, path.extname(full)) === recordingBaseName) return full;
  }
  return null;
}

module.exports = { walkInputVideos, walkInputVideosDetailed, findInputVideoByName };
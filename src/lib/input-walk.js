'use strict';

/**
 * input-walk.js — video discovery under input/.
 *
 * A sub-folder of input/ IS the recording's group (input/kyc/x.mp4 → "kyc");
 * videos at the input/ root belong to the default group.
 */

const fs = require('fs');
const path = require('path');

/** Supported video containers. */
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v'];

/**
 * Every video under inputDir (any depth, dotfiles skipped), with its folder
 * path relative to inputDir ('' = root). Deterministic order.
 *
 * @param {string} inputDir
 * @returns {Array<{fullPath: string, relDir: string, baseName: string}>}
 */
function walkInputVideos(inputDir) {
  const out = [];
  if (!fs.existsSync(inputDir)) return out;
  const walk = (dir, relDir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, path.join(relDir, entry.name));
      } else if (entry.isFile() && VIDEO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
        out.push({ fullPath: full, relDir, baseName: path.basename(entry.name, path.extname(entry.name)) });
      }
    }
  };
  walk(inputDir, '');
  return out;
}

/**
 * Finds a recording's source video. Looks in the recording's OWN group folder
 * first, so two same-named videos in different groups never get mixed up;
 * falls back to anywhere under input/.
 *
 * @param {string} inputDir
 * @param {string} baseName     - recording filename without extension
 * @param {string} group        - the recording's group
 * @param {string} defaultGroup - group used for videos at the input/ root
 * @returns {string|null}
 */
function findSourceVideo(inputDir, baseName, group, defaultGroup) {
  const all = walkInputVideos(inputDir).filter((v) => v.baseName === baseName);
  const ownFolder = group === defaultGroup ? '' : group;
  const own = all.find((v) => v.relDir === ownFolder);
  return (own || all[0])?.fullPath || null;
}

module.exports = { VIDEO_EXTENSIONS, walkInputVideos, findSourceVideo };

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TEMP_PREFIX = "videapilot-render-";
const MIN_AGE_MS = 24 * 60 * 60 * 1000;

function inspectAbandonedRenderDirectories(options = {}) {
  const temporaryRoot = options.temporaryRoot ?? os.tmpdir();
  const now = options.now ?? Date.now();
  const minimumAgeMs = options.minimumAgeMs ?? MIN_AGE_MS;

  if (
    typeof temporaryRoot !== "string" ||
    !path.isAbsolute(temporaryRoot)
  ) {
    throw new Error("INVALID_TEMP_ROOT");
  }

  if (
    !Number.isFinite(now) ||
    !Number.isFinite(minimumAgeMs) ||
    minimumAgeMs < MIN_AGE_MS
  ) {
    throw new Error("INVALID_CLEANUP_PARAMETERS");
  }

  const root = fs.realpathSync(temporaryRoot);

  if (!fs.statSync(root).isDirectory()) {
    throw new Error("INVALID_TEMP_ROOT");
  }

  const candidates = [];

  for (const entry of fs.readdirSync(root, {
    withFileTypes: true
  })) {
    if (!entry.name.startsWith(TEMP_PREFIX)) {
      continue;
    }

    // Ne pas suivre les liens symboliques.
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }

    const directoryPath = path.join(root, entry.name);
    const stats = fs.lstatSync(directoryPath);

    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      continue;
    }

    const ageMs = now - stats.mtimeMs;

    if (ageMs < minimumAgeMs) {
      continue;
    }

    candidates.push({
      name: entry.name,
      ageHours: Math.floor(ageMs / 3600000),
      path: directoryPath
    });
  }

  return {
    inspectedRoot: root,
    minimumAgeHours: minimumAgeMs / 3600000,
    candidateCount: candidates.length,
    candidates
  };
}

module.exports = {
  TEMP_PREFIX,
  MIN_AGE_MS,
  inspectAbandonedRenderDirectories
};

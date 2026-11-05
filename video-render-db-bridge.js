"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  validateProjectScenesForRender
} = require("./video-render-integrity-v2");

const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

function prepareDatabaseRenderScenes(rows, options = {}) {
  const validation = validateProjectScenesForRender(rows);

  const { imageDirectory } = options;

  if (
    typeof imageDirectory !== "string" ||
    !path.isAbsolute(imageDirectory)
  ) {
    throw new Error("INVALID_IMAGE_DIRECTORY");
  }

  const imageRoot = fs.realpathSync(imageDirectory);

  if (!fs.statSync(imageRoot).isDirectory()) {
    throw new Error("IMAGE_DIRECTORY_NOT_FOUND");
  }

  const scenes = rows.map((row) => {
    const storageKey = row.storage_key;

    // Mode local : uniquement des noms simples.
    // Aucune URL, aucun chemin relatif imbrique.
    if (
      typeof storageKey !== "string" ||
      !/^[a-zA-Z0-9_-]+\.(png|jpg|jpeg)$/i.test(storageKey)
    ) {
      throw new Error("INVALID_STORAGE_KEY");
    }

    const imagePath = path.join(imageRoot, storageKey);
    const realImagePath = fs.realpathSync(imagePath);

    if (path.dirname(realImagePath) !== imageRoot) {
      throw new Error("IMAGE_OUTSIDE_ALLOWED_DIRECTORY");
    }

    const stats = fs.statSync(realImagePath);

    if (!stats.isFile()) {
      throw new Error("INVALID_IMAGE_FILE");
    }

    const expectedSize = Number(row.size_bytes);

    if (
      !Number.isSafeInteger(expectedSize) ||
      expectedSize <= 0 ||
      expectedSize > MAX_IMAGE_SIZE ||
      stats.size !== expectedSize
    ) {
      throw new Error("IMAGE_SIZE_MISMATCH");
    }

    const extension = path.extname(storageKey).toLowerCase();
    const expectedMime =
      extension === ".png" ? "image/png" : "image/jpeg";

    if (row.mime_type !== expectedMime) {
      throw new Error("IMAGE_MIME_MISMATCH");
    }

    return {
      image: realImagePath,
      durationSeconds: Number(row.duration_seconds)
    };
  });

  return {
    scenes,
    sceneCount: validation.sceneCount,
    totalDurationSeconds: validation.totalDurationSeconds
  };
}

module.exports = {
  prepareDatabaseRenderScenes
};
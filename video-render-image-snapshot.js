"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_SCENES = 30;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

async function withImageSnapshots(scenes, callback) {
  if (
    !Array.isArray(scenes) ||
    scenes.length === 0 ||
    scenes.length > MAX_SCENES
  ) {
    throw new Error("INVALID_SNAPSHOT_SCENES");
  }

  if (typeof callback !== "function") {
    throw new Error("INVALID_SNAPSHOT_CALLBACK");
  }

  // Valider les informations avant toute copie.
  let totalBytes = 0;

  for (const scene of scenes) {
    if (
      !scene ||
      typeof scene.image !== "string" ||
      !path.isAbsolute(scene.image) ||
      !Number.isFinite(scene.durationSeconds) ||
      scene.durationSeconds <= 0
    ) {
      throw new Error("INVALID_SNAPSHOT_SCENE");
    }

    const extension = path.extname(scene.image).toLowerCase();

    if (![".png", ".jpg", ".jpeg"].includes(extension)) {
      throw new Error("INVALID_SNAPSHOT_EXTENSION");
    }

    const stats = fs.statSync(scene.image);

    if (
      !stats.isFile() ||
      stats.size <= 0 ||
      stats.size > MAX_IMAGE_BYTES
    ) {
      throw new Error("INVALID_SNAPSHOT_IMAGE_SIZE");
    }

    totalBytes += stats.size;

    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("SNAPSHOT_TOTAL_SIZE_EXCEEDED");
    }
  }

  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "videapilot-render-")
  );

  try {
    const snapshotScenes = [];

    for (let index = 0; index < scenes.length; index++) {
      const scene = scenes[index];

      const extension = path.extname(scene.image).toLowerCase();

      const snapshotPath = path.join(
        temporaryDirectory,
        `scene_${String(index + 1).padStart(3, "0")}${extension}`
      );

      fs.copyFileSync(
        scene.image,
        snapshotPath,
        fs.constants.COPYFILE_EXCL
      );

      snapshotScenes.push({
        image: snapshotPath,
        durationSeconds: scene.durationSeconds
      });
    }

    return await callback(snapshotScenes);

  } finally {
    fs.rmSync(temporaryDirectory, {
      recursive: true,
      force: true
    });
  }
}

module.exports = {
  withImageSnapshots
};

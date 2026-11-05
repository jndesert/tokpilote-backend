"use strict";

// Preparation du schema pour le rendu video.
// Aucune migration n'est executee automatiquement.

const VIDEO_RENDER_SCHEMA = Object.freeze({
  version: 1,
  migrationRequired: true,
  imageStorageReady: false
});

const VIDEO_RENDER_MIGRATIONS = Object.freeze([
  `
  ALTER TABLE video_project_scenes
  ADD COLUMN IF NOT EXISTS duration_seconds
  DOUBLE PRECISION
  `,
  `
  ALTER TABLE video_project_scenes
  ADD COLUMN IF NOT EXISTS image_asset_id
  UUID
  `
]);

function validateSceneRenderData(scene) {
  if (!scene || typeof scene !== "object") {
    throw new Error("INVALID_SCENE");
  }

  const duration = Number(scene.durationSeconds);

  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 600
  ) {
    throw new Error("INVALID_SCENE_DURATION");
  }

  if (
    typeof scene.imageAssetId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(scene.imageAssetId)
  ) {
    throw new Error("INVALID_IMAGE_ASSET_ID");
  }

  return {
    durationSeconds: duration,
    imageAssetId: scene.imageAssetId
  };
}

module.exports = {
  VIDEO_RENDER_SCHEMA,
  VIDEO_RENDER_MIGRATIONS,
  validateSceneRenderData
};
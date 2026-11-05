"use strict";

// Registre des images de projets VidéaPilot.
// Ce module ne crée aucune table automatiquement.

const CREATE_VIDEO_IMAGE_ASSETS_TABLE = `
  CREATE TABLE IF NOT EXISTS video_image_assets (
    id UUID PRIMARY KEY,
    project_id BIGINT NOT NULL
      REFERENCES video_projects(id) ON DELETE CASCADE,
    scene_id UUID NOT NULL,
    user_id TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL
      CHECK (mime_type IN ('image/png', 'image/jpeg')),
    size_bytes BIGINT NOT NULL
      CHECK (size_bytes > 0),
    status TEXT NOT NULL DEFAULT 'ready'
      CHECK (status IN ('ready', 'deleted')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT video_image_assets_scene_fk
      FOREIGN KEY (project_id, scene_id)
      REFERENCES video_project_scenes(project_id, scene_id)
      ON DELETE CASCADE
  )
`;

const CREATE_VIDEO_IMAGE_ASSETS_INDEX = `
  CREATE INDEX IF NOT EXISTS
    idx_video_image_assets_project_scene
  ON video_image_assets (project_id, scene_id)
`;

const VIDEO_IMAGE_ASSETS_MIGRATIONS = Object.freeze([
  CREATE_VIDEO_IMAGE_ASSETS_TABLE,
  CREATE_VIDEO_IMAGE_ASSETS_INDEX
]);

function validateImageAssetMetadata(asset) {
  if (!asset || typeof asset !== "object") {
    throw new Error("INVALID_IMAGE_ASSET");
  }

  if (
    typeof asset.storageKey !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}\.(png|jpg|jpeg)$/i.test(asset.storageKey)
  ) {
    throw new Error("INVALID_STORAGE_KEY");
  }

  if (
    !["image/png", "image/jpeg"].includes(asset.mimeType)
  ) {
    throw new Error("INVALID_IMAGE_MIME_TYPE");
  }

  if (
    !Number.isSafeInteger(asset.sizeBytes) ||
    asset.sizeBytes <= 0 ||
    asset.sizeBytes > 20 * 1024 * 1024
  ) {
    throw new Error("INVALID_IMAGE_SIZE");
  }

  return {
    storageKey: asset.storageKey,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes
  };
}

module.exports = {
  VIDEO_IMAGE_ASSETS_MIGRATIONS,
  validateImageAssetMetadata
};
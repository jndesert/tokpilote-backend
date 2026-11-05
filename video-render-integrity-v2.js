"use strict";

// VidéaPilot — Preparation des contraintes de rendu V2.
// Aucune migration n'est executee automatiquement.

// La contrainte UNIQUE est necessaire pour permettre
// la reference composite depuis video_project_scenes.
const VIDEO_RENDER_INTEGRITY_V2_MIGRATIONS = Object.freeze([
  `
  ALTER TABLE video_image_assets
  ADD CONSTRAINT video_image_assets_composite_unique
  UNIQUE (id, project_id, scene_id)
  `,
  `
  ALTER TABLE video_project_scenes
  ADD CONSTRAINT video_scene_image_asset_composite_fk
  FOREIGN KEY (image_asset_id, project_id, scene_id)
  REFERENCES video_image_assets(id, project_id, scene_id)
  DEFERRABLE INITIALLY DEFERRED
  `
]);

// LEFT JOIN : conserver toutes les scenes,
// meme lorsqu'aucune image valide n'est disponible.
const FIND_PROJECT_SCENES_FOR_RENDER = `
  SELECT
    s.scene_id,
    s.scene_number,
    s.title,
    s.duration_seconds,
    s.image_asset_id,
    a.storage_key,
    a.mime_type,
    a.size_bytes,
    a.status AS image_status
  FROM video_project_scenes s
  JOIN video_projects p
    ON p.id = s.project_id
  LEFT JOIN video_image_assets a
    ON a.id = s.image_asset_id
   AND a.project_id = s.project_id
   AND a.scene_id = s.scene_id
   AND a.user_id = p.user_id
   AND a.status = 'ready'
  WHERE
    s.project_id = $1
    AND p.user_id = $2
  ORDER BY s.scene_number ASC
`;

// Refuser le rendu si une scene est incomplete.
function validateProjectScenesForRender(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("NO_PROJECT_SCENES");
  }

  if (rows.length > 30) {
    throw new Error("TOO_MANY_SCENES");
  }

  let totalDuration = 0;

  for (const scene of rows) {
    const duration = Number(scene.duration_seconds);

    if (
      scene.duration_seconds === null ||
      scene.duration_seconds === undefined ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 600
    ) {
      throw new Error("INVALID_SCENE_DURATION");
    }

    if (
      !scene.image_asset_id ||
      !scene.storage_key ||
      scene.image_status !== "ready"
    ) {
      throw new Error("SCENE_IMAGE_NOT_READY");
    }

    totalDuration += duration;
  }

  if (totalDuration > 600) {
    throw new Error("VIDEO_DURATION_LIMIT_EXCEEDED");
  }

  return {
    sceneCount: rows.length,
    totalDurationSeconds: totalDuration,
    ready: true
  };
}

module.exports = {
  VIDEO_RENDER_INTEGRITY_V2_MIGRATIONS,
  FIND_PROJECT_SCENES_FOR_RENDER,
  validateProjectScenesForRender
};
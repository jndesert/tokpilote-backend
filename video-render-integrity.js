"use strict";

// Contraintes d'integrite preparees pour VidéaPilot.
// Ne pas executer sans verification du schema existant.

const VIDEO_RENDER_INTEGRITY_MIGRATIONS = Object.freeze([
  `
  ALTER TABLE video_project_scenes
  ADD CONSTRAINT video_scene_duration_valid
  CHECK (
    duration_seconds IS NULL OR
    (
      duration_seconds > 0 AND
      duration_seconds <= 600
    )
  )
  `,
  `
  ALTER TABLE video_project_scenes
  ADD CONSTRAINT video_scene_image_asset_fk
  FOREIGN KEY (image_asset_id)
  REFERENCES video_image_assets(id)
  `
]);

const FIND_AUTHORIZED_SCENE_IMAGE = `
  SELECT
    s.scene_id,
    s.scene_number,
    s.duration_seconds,
    a.id AS image_asset_id,
    a.storage_key,
    a.mime_type,
    a.size_bytes
  FROM video_project_scenes s
  JOIN video_projects p
    ON p.id = s.project_id
  JOIN video_image_assets a
    ON a.id = s.image_asset_id
   AND a.project_id = s.project_id
   AND a.scene_id = s.scene_id
   AND a.user_id = p.user_id
  WHERE
    s.project_id = $1
    AND p.user_id = $2
    AND a.status = 'ready'
  ORDER BY s.scene_number ASC
`;

module.exports = {
  VIDEO_RENDER_INTEGRITY_MIGRATIONS,
  FIND_AUTHORIZED_SCENE_IMAGE
};
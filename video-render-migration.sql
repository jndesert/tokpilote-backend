-- VIDEAPILOT - MIGRATION RENDU VIDEO
-- PREPARATION UNIQUEMENT : NE PAS EXECUTER EN PRODUCTION
-- A verifier sur une base de test avant application.

BEGIN;

-- 1. Ajouter les informations de rendu aux scenes.
ALTER TABLE video_project_scenes
ADD COLUMN IF NOT EXISTS duration_seconds DOUBLE PRECISION;

ALTER TABLE video_project_scenes
ADD COLUMN IF NOT EXISTS image_asset_id UUID;

-- 2. Creer le registre des images.
CREATE TABLE IF NOT EXISTS video_image_assets (
    id UUID PRIMARY KEY,

    project_id BIGINT NOT NULL
        REFERENCES video_projects(id)
        ON DELETE CASCADE,

    scene_id UUID NOT NULL,

    user_id TEXT NOT NULL,

    storage_key TEXT NOT NULL UNIQUE,

    mime_type TEXT NOT NULL
        CHECK (mime_type IN ('image/png', 'image/jpeg')),

    size_bytes BIGINT NOT NULL
        CHECK (size_bytes > 0 AND size_bytes <= 20971520),

    status TEXT NOT NULL DEFAULT 'ready'
        CHECK (status IN ('ready', 'deleted')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT video_image_assets_scene_fk
        FOREIGN KEY (project_id, scene_id)
        REFERENCES video_project_scenes(project_id, scene_id)
        ON DELETE CASCADE,

    CONSTRAINT video_image_assets_composite_unique
        UNIQUE (id, project_id, scene_id)
);

-- 3. Verifier la duree des scenes.
ALTER TABLE video_project_scenes
ADD CONSTRAINT video_scene_duration_valid
CHECK (
    duration_seconds IS NULL OR
    (duration_seconds > 0 AND duration_seconds <= 600)
);

-- 4. Garantir qu'une image appartient a la bonne scene.
ALTER TABLE video_project_scenes
ADD CONSTRAINT video_scene_image_asset_composite_fk
FOREIGN KEY (image_asset_id, project_id, scene_id)
REFERENCES video_image_assets(id, project_id, scene_id)
DEFERRABLE INITIALLY DEFERRED;

-- 5. Accelerer la recherche des images.
CREATE INDEX IF NOT EXISTS
idx_video_image_assets_project_scene
ON video_image_assets(project_id, scene_id);

COMMIT;
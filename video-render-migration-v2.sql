-- VIDEAPILOT - MIGRATION RENDU VIDEO V2
-- PREPARATION UNIQUEMENT
-- NE PAS EXECUTER SUR LA PRODUCTION SANS TEST PREALABLE

BEGIN;

-- 1. Colonnes de rendu.
ALTER TABLE video_project_scenes
ADD COLUMN IF NOT EXISTS duration_seconds DOUBLE PRECISION;

ALTER TABLE video_project_scenes
ADD COLUMN IF NOT EXISTS image_asset_id UUID;

-- 2. Registre des images.
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
        CHECK (size_bytes > 0 AND size_bytes <= 20971520),

    status TEXT NOT NULL DEFAULT 'ready'
        CHECK (status IN ('ready', 'deleted')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Contraintes ajoutees uniquement si absentes.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'video_scene_duration_valid'
          AND conrelid = 'video_project_scenes'::regclass
    ) THEN
        ALTER TABLE video_project_scenes
        ADD CONSTRAINT video_scene_duration_valid
        CHECK (
            duration_seconds IS NULL OR
            (
                duration_seconds > 0
                AND duration_seconds <= 600
            )
        );
    END IF;
END
$$;

-- 4. Unicite composite pour les images.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'video_image_assets_composite_unique'
          AND conrelid = 'video_image_assets'::regclass
    ) THEN
        ALTER TABLE video_image_assets
        ADD CONSTRAINT video_image_assets_composite_unique
        UNIQUE (id, project_id, scene_id);
    END IF;
END
$$;

-- 5. Image rattachee a une scene du bon projet.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'video_image_assets_scene_fk'
          AND conrelid = 'video_image_assets'::regclass
    ) THEN
        ALTER TABLE video_image_assets
        ADD CONSTRAINT video_image_assets_scene_fk
        FOREIGN KEY (project_id, scene_id)
        REFERENCES video_project_scenes(project_id, scene_id)
        ON DELETE CASCADE;
    END IF;
END
$$;

-- 6. Reference composite de la scene vers son image.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'video_scene_image_asset_composite_fk'
          AND conrelid = 'video_project_scenes'::regclass
    ) THEN
        ALTER TABLE video_project_scenes
        ADD CONSTRAINT video_scene_image_asset_composite_fk
        FOREIGN KEY (image_asset_id, project_id, scene_id)
        REFERENCES video_image_assets(id, project_id, scene_id)
        DEFERRABLE INITIALLY DEFERRED;
    END IF;
END
$$;

-- 7. Index.
CREATE INDEX IF NOT EXISTS
idx_video_image_assets_project_scene
ON video_image_assets(project_id, scene_id);

COMMIT;
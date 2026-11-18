-- Base isolée neuve uniquement. CREATE IF NOT EXISTS conserve les tables existantes.
BEGIN;
CREATE TABLE IF NOT EXISTS video_projects (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    title VARCHAR(120) NOT NULL,
    topic TEXT NOT NULL,
    script TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS video_project_scenes (
    scene_id UUID PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
    scene_number INTEGER NOT NULL CHECK (scene_number > 0),
    title TEXT NOT NULL,
    visual_prompt TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, scene_number),
    UNIQUE (project_id, scene_id)
);
COMMIT;

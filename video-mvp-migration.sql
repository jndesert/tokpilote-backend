BEGIN;
ALTER TABLE video_projects
  ADD COLUMN IF NOT EXISTS narration_file_name text,
  ADD COLUMN IF NOT EXISTS mvp_local_images boolean NOT NULL DEFAULT false;
COMMIT;

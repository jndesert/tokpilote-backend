"use strict";

const { createHmac, timingSafeEqual } = require("node:crypto");
const { validateScenes } = require("./video-scene-sync");

const sceneSnapshotSql = `
  SELECT scene_id, scene_number, title, visual_prompt, duration_seconds, image_asset_id
  FROM video_project_scenes
  WHERE project_id = $1
    AND EXISTS (
      SELECT 1 FROM video_projects p
      WHERE p.id = $1 AND p.user_id = $2 AND p.script = $3
        AND COALESCE(to_jsonb(p)->>'mvp_local_images', 'false') <> 'true'
    )
  ORDER BY scene_number ASC`;

function buildSceneReconciliation({ projectId, owner, script, scenes, existing, secret }) {
  validateScenes(scenes);
  if (existing.length !== scenes.length ||
      existing.some((row, index) => Number(row.scene_number) !== scenes[index].number)) {
    throw new Error("SCENE_RECONCILIATION_NUMBER_MISMATCH");
  }

  const preservedScenes = scenes.map((scene, index) => ({
    ...scene,
    title: scene.title.trim(),
    sceneId: existing[index].scene_id,
  }));
  validateScenes(preservedScenes);
  const differences = preservedScenes.map((scene, index) => {
    const row = existing[index];
    const before = { title: row.title, visualPrompt: row.visual_prompt, durationSeconds: row.duration_seconds };
    const after = { title: scene.title, visualPrompt: scene.visualPrompt, durationSeconds: scene.durationSeconds };
    return {
      number: scene.number,
      sceneId: scene.sceneId,
      before,
      after,
      hasImage: row.image_asset_id != null,
      imageMayNotMatch: row.image_asset_id != null && before.visualPrompt !== after.visualPrompt,
    };
  });
  const fingerprint = createHmac("sha256", secret).update(JSON.stringify([
    "scene-reconciliation-v1", String(projectId), owner, script, differences,
    existing.map(row => row.image_asset_id), preservedScenes,
  ])).digest("hex");
  return { differences, fingerprint, preservedScenes };
}

function matchesSceneFingerprint(expected, submitted) {
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(submitted, "hex"));
}

module.exports = { buildSceneReconciliation, matchesSceneFingerprint, sceneSnapshotSql };

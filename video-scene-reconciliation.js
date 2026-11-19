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

function buildSceneReconciliation({ projectId, owner, script, scenes, existing, secret, durationProposal }) {
  validateScenes(scenes);
  if (existing.length !== scenes.length ||
      existing.some((row, index) => Number(row.scene_number) !== scenes[index].number)) {
    throw new Error("SCENE_RECONCILIATION_NUMBER_MISMATCH");
  }

  const preservedScenes = scenes.map((scene, index) => {
    const row = existing[index];
    const timing = durationProposal?.[index];
    return {
      ...scene,
      title: timing ? row.title : scene.title.trim(),
      visualPrompt: timing ? row.visual_prompt : scene.visualPrompt,
      sceneId: row.scene_id,
      ...(timing ? {
        startSeconds: timing.adjustedStartSeconds,
        endSeconds: timing.adjustedEndSeconds,
        durationSeconds: timing.adjustedDurationSeconds,
      } : {}),
    };
  });
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
    ...(durationProposal ? ["durations", durationProposal] : []),
  ])).digest("hex");
  return { differences, fingerprint, preservedScenes };
}

async function updateReconciledDurations(client, projectId, differences) {
  for (const scene of differences) {
    if (scene.before.durationSeconds === scene.after.durationSeconds) continue;
    const result = await client.query(
      `UPDATE video_project_scenes
       SET duration_seconds = $3
       WHERE project_id = $1 AND scene_id = $2 AND scene_number = $4`,
      [projectId, scene.sceneId, scene.after.durationSeconds, scene.number]
    );
    if (result.rowCount !== 1) throw new Error("SCENE_RECONCILIATION_STALE");
  }
}

function matchesSceneFingerprint(expected, submitted) {
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(submitted, "hex"));
}

module.exports = { buildSceneReconciliation, matchesSceneFingerprint, sceneSnapshotSql, updateReconciledDurations };

"use strict";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateScenes(scenes) {
  if (
    !Array.isArray(scenes) ||
    scenes.length === 0 ||
    scenes.length > 30
  ) {
    throw new Error("INVALID_SCENES");
  }

  const ids = new Set();
  const numbers = new Set();
  let totalDurationSeconds = 0;

  for (const scene of scenes) {
    if (
      !scene ||
      typeof scene.sceneId !== "string" ||
      !UUID_PATTERN.test(scene.sceneId) ||
      !Number.isSafeInteger(scene.number) ||
      scene.number <= 0 ||
      typeof scene.title !== "string" ||
      !scene.title.trim() ||
      typeof scene.visualPrompt !== "string" ||
      !Number.isFinite(scene.durationSeconds) ||
      scene.durationSeconds <= 0 ||
      scene.durationSeconds > 600
    ) {
      throw new Error("INVALID_SCENE_DATA");
    }

    if (
      ids.has(scene.sceneId) ||
      numbers.has(scene.number)
    ) {
      throw new Error("DUPLICATE_SCENE");
    }

    ids.add(scene.sceneId);
    numbers.add(scene.number);

    totalDurationSeconds += scene.durationSeconds;

    if (totalDurationSeconds > 600) {
      throw new Error("VIDEO_DURATION_LIMIT_EXCEEDED");
    }
  }

  return scenes;
}

async function synchronizeProjectScenes(client, projectId, scenes) {
  validateScenes(scenes);

  if (
    !Number.isSafeInteger(Number(projectId)) ||
    Number(projectId) <= 0
  ) {
    throw new Error("INVALID_PROJECT_ID");
  }

  // Cette fonction doit etre appelee dans une transaction
  // apres verification du proprietaire et verrouillage du projet.

  const existing = await client.query(
    `
    SELECT scene_id, scene_number
    FROM video_project_scenes
    WHERE project_id = $1
    `,
    [projectId]
  );

  const existingIds = new Set(
    existing.rows.map(row => String(row.scene_id))
  );

  const incomingIds = new Set(
    scenes.map(scene => scene.sceneId)
  );

  // Ne jamais supprimer implicitement une scene existante.
  for (const id of existingIds) {
    if (!incomingIds.has(id)) {
      throw new Error("EXISTING_SCENE_REMOVAL_BLOCKED");
    }
  }

  // Eviter les collisions de numeros pendant les mises a jour.
  // Cette premiere version conserve la numerotation existante.
  const existingNumbers = new Map(
    existing.rows.map(row => [
      String(row.scene_id),
      Number(row.scene_number)
    ])
  );

  for (const scene of scenes) {
    if (
      existingNumbers.has(scene.sceneId) &&
      existingNumbers.get(scene.sceneId) !== scene.number
    ) {
      throw new Error("SCENE_RENUMBERING_NOT_SUPPORTED");
    }
  }

  let updated = 0;
  let inserted = 0;

  for (const scene of scenes) {
    if (existingIds.has(scene.sceneId)) {
      await client.query(
        `
        UPDATE video_project_scenes
        SET title = $3,
            visual_prompt = $4,
            duration_seconds = $5
        WHERE project_id = $1
          AND scene_id = $2
        `,
        [
          projectId,
          scene.sceneId,
          scene.title.trim(),
          scene.visualPrompt,
          scene.durationSeconds
        ]
      );

      updated++;
    } else {
      await client.query(
        `
        INSERT INTO video_project_scenes
          (scene_id, project_id, scene_number, title, visual_prompt, duration_seconds)
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          scene.sceneId,
          projectId,
          scene.number,
          scene.title.trim(),
          scene.visualPrompt,
          scene.durationSeconds
        ]
      );

      inserted++;
    }
  }

  return {
    success: true,
    updated,
    inserted,
    deleted: 0
  };
}

module.exports = {
  validateScenes,
  synchronizeProjectScenes
};
"use strict";

function preserveSceneIdentities(newScenes, existingScenes) {
  if (!Array.isArray(newScenes) || !Array.isArray(existingScenes)) {
    throw new Error("INVALID_SCENE_COLLECTION");
  }

  const existingByNumber = new Map();

  for (const existing of existingScenes) {
    const number = Number(existing.scene_number);

    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new Error("INVALID_EXISTING_SCENE");
    }

    if (existingByNumber.has(number)) {
      throw new Error("DUPLICATE_EXISTING_SCENE_NUMBER");
    }

    existingByNumber.set(number, existing);
  }

  const seenNumbers = new Set();

  return newScenes.map(scene => {
    if (
      !scene ||
      !Number.isSafeInteger(scene.number) ||
      scene.number <= 0 ||
      typeof scene.title !== "string" ||
      typeof scene.visualPrompt !== "string"
    ) {
      throw new Error("INVALID_NEW_SCENE");
    }

    if (seenNumbers.has(scene.number)) {
      throw new Error("DUPLICATE_NEW_SCENE_NUMBER");
    }

    seenNumbers.add(scene.number);

    const existing = existingByNumber.get(scene.number);

    if (!existing) {
      return { ...scene };
    }

    if (
      existing.title !== scene.title ||
      existing.visual_prompt !== scene.visualPrompt
    ) {
      throw new Error("SCENE_CONTENT_CHANGED_REVIEW_REQUIRED");
    }

    return {
      ...scene,
      sceneId: existing.scene_id
    };
  });
}

module.exports = { preserveSceneIdentities };
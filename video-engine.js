
"use strict";

// VidéaPilot — Moteur de préparation du montage vidéo.
// Préparation locale uniquement : aucune API payante.

const VIDEO_ENGINE_CONFIG = {
  enabled: true,
  mode: "preparation",
  outputFormat: "mp4",
  audioGenerationEnabled: false,
  videoGenerationEnabled: false
};

function prepareVideoMontage(scenes) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error("Aucune scène disponible pour le montage.");
  }

  const timeline = scenes.map((scene, index) => {
    const start = Number(scene.startSeconds);
    const end = Number(scene.endSeconds);

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start
    ) {
      throw new Error(
        `Horaires invalides pour la scène ${index + 1}.`
      );
    }

    const dialogues = (scene.dialogues || []).map(
      (dialogue, dialogueIndex) => ({
        order: dialogueIndex + 1,
        character: dialogue.speaker || "Narrateur",
        text: dialogue.text || "",
        emotion: dialogue.emotion || null
      })
    );

    return {
      sceneNumber: scene.number || index + 1,
      title: scene.title || `Scène ${index + 1}`,
      startSeconds: start,
      endSeconds: end,
      durationSeconds: end - start,
      dialogues,
      status: "prepared"
    };
  });

  for (let i = 1; i < timeline.length; i++) {
    if (timeline[i].startSeconds < timeline[i - 1].endSeconds) {
      throw new Error("Chevauchement détecté entre les scènes.");
    }
  }

  return {
    success: true,
    status: "prepared",
    totalScenes: timeline.length,
    totalDurationSeconds: timeline[timeline.length - 1].endSeconds,
    timeline,
    videoGenerated: false,
    audioGenerated: false
  };
}

module.exports = {
  VIDEO_ENGINE_CONFIG,
  prepareVideoMontage
};

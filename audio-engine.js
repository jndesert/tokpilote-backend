
"use strict";
const { getVoiceMapping } = require("./voice-mapping");

// Moteur audio VidéaPilot
// Mode simulation : aucun appel API payant.

const AUDIO_ENGINE_CONFIG = {
  provider: "simulation",
  enabled: false,
  outputFormat: "mp3",
  language: "fr",
  maxCharactersPerSegment: 5000
};

function prepareAudioJob(segment) {
  if (!segment || typeof segment !== "object") {
    throw new Error("Segment audio invalide");
  }

  const {
    segmentId,
    character,
    voiceId,
    voiceConfig,
    emotion,
    text,
    outputFileName
  } = segment;

  if (
    typeof segmentId !== "string" ||
    !segmentId ||
    typeof text !== "string" ||
    !text.trim() ||
    text.length > AUDIO_ENGINE_CONFIG.maxCharactersPerSegment
  ) {
    throw new Error("Données audio manquantes ou invalides");
  }

  return {
    segmentId,
    character,
    voiceId,
    voiceMapping: getVoiceMapping(voiceId),
    voiceConfig,
    emotion,
    text,
    outputFileName,
    provider: AUDIO_ENGINE_CONFIG.provider,
    format: AUDIO_ENGINE_CONFIG.outputFormat,
    language: AUDIO_ENGINE_CONFIG.language,
    status: "prepared",
    generated: false
  };
}

function prepareAudioJobs(audioGenerationPlan) {
  if (!Array.isArray(audioGenerationPlan)) {
    throw new Error("Plan de génération audio invalide");
  }

  return audioGenerationPlan.map(prepareAudioJob);
}

module.exports = {
  AUDIO_ENGINE_CONFIG,
  prepareAudioJob,
  prepareAudioJobs
};


"use strict";

const {
  AUDIO_SAFETY_CONFIG,
  assertAudioGenerationAllowed
} = require("./audio-safety");

const TTS_CONFIG = Object.freeze({
  provider: "openai",
  model: "gpt-4o-mini-tts",
  voice: "echo",
  format: "mp3",
  enabled: false
});


function prepareTtsRequest(text, voiceId = "leo") {
  if (!TTS_CONFIG.enabled || !AUDIO_SAFETY_CONFIG.enabled) {
    throw new Error("AUDIO_GENERATION_DISABLED");
  }

  assertAudioGenerationAllowed({
    text,
    segmentCount: 1
  });

  const { getVoiceMapping } = require("./voice-mapping");
  const mapping = getVoiceMapping(voiceId);

  if (!mapping) {
    throw new Error("UNKNOWN_CHARACTER_VOICE");
  }

  return {
    model: TTS_CONFIG.model,
    voice: mapping.voice,
    input: text,
    response_format: TTS_CONFIG.format
  };
}

function previewTtsRequest(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("AUDIO_TEXT_INVALID");
  }

  if (text.length > AUDIO_SAFETY_CONFIG.maxCharactersPerRequest) {
    throw new Error("AUDIO_TEXT_LIMIT_EXCEEDED");
  }

  return {
    provider: TTS_CONFIG.provider,
    model: TTS_CONFIG.model,
    voice: TTS_CONFIG.voice,
    format: TTS_CONFIG.format,
    textLength: text.length,
    generationEnabled:
      TTS_CONFIG.enabled && AUDIO_SAFETY_CONFIG.enabled,
    execute: false,
    audioGenerated: false,
    status: "preview_only"
  };
}

module.exports = {
  TTS_CONFIG,
  prepareTtsRequest,
  previewTtsRequest
};

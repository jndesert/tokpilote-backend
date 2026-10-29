
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

function prepareTtsRequest(text) {
  if (!TTS_CONFIG.enabled || !AUDIO_SAFETY_CONFIG.enabled) {
    throw new Error("AUDIO_GENERATION_DISABLED");
  }

  assertAudioGenerationAllowed({
    text,
    segmentCount: 1
  });

  return {
    model: TTS_CONFIG.model,
    voice: TTS_CONFIG.voice,
    input: text,
    response_format: TTS_CONFIG.format
  };
}

module.exports = {
  TTS_CONFIG,
  prepareTtsRequest
};

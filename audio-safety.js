
"use strict";

const AUDIO_SAFETY_CONFIG = Object.freeze({
  enabled: false,
  maxCharactersPerRequest: 100,
  maxSegmentsPerRequest: 1
});

function assertAudioGenerationAllowed({
  text,
  segmentCount = 1
} = {}) {
  if (!AUDIO_SAFETY_CONFIG.enabled) {
    throw new Error(
      "AUDIO_GENERATION_DISABLED"
    );
  }

  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > AUDIO_SAFETY_CONFIG.maxCharactersPerRequest
  ) {
    throw new Error(
      "AUDIO_TEXT_LIMIT_EXCEEDED"
    );
  }

  if (
    !Number.isInteger(segmentCount) ||
    segmentCount < 1 ||
    segmentCount > AUDIO_SAFETY_CONFIG.maxSegmentsPerRequest
  ) {
    throw new Error(
      "AUDIO_SEGMENT_LIMIT_EXCEEDED"
    );
  }

  return true;
}

module.exports = {
  AUDIO_SAFETY_CONFIG,
  assertAudioGenerationAllowed
};

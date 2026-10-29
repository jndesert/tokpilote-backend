
"use strict";

// Correspondance entre les personnages
// et leurs futures voix de synthèse.
// Aucun appel API n'est effectué.

const VOICE_MAPPING = {
  narrateur: {
    character: "Narrateur",
    voice: "onyx",
    style: "chaleureux et captivant"
  },
  leo: {
    character: "Léo",
    voice: "echo",
    style: "jeune, expressif et attachant"
  },
  maman: {
    character: "Maman",
    voice: "nova",
    style: "douce et rassurante"
  },
  clara: {
    character: "Clara",
    voice: "shimmer",
    style: "joyeuse et naturelle"
  },
  coach: {
    character: "Coach",
    voice: "coral",
    style: "encourageante et dynamique"
  },
  agent_de_comptoir: {
    character: "Agent de comptoir",
    voice: "sage",
    style: "professionnelle et accueillante"
  },
  voisin: {
    character: "Voisin",
    voice: "fable",
    style: "amicale et spontanée"
  },
  pilote: {
    character: "Pilote",
    voice: "ash",
    style: "calme et assurée"
  },
  hotesse: {
    character: "Hôtesse",
    voice: "alloy",
    style: "claire et rassurante"
  }
};

function getVoiceMapping(voiceId) {
  if (typeof voiceId !== "string") return null;
  return VOICE_MAPPING[voiceId] || null;
}

module.exports = {
  VOICE_MAPPING,
  getVoiceMapping
};

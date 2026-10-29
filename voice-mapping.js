
"use strict";

// Correspondance entre les personnages
// et leurs futures voix de synthèse.
// Aucun appel API n'est effectué.

const VOICE_MAPPING = {
  narrateur: {
    character: "Narrateur",
    voice: null,
    style: "chaleureux et captivant"
  },
  leo: {
    character: "Léo",
    voice: "echo",
    style: "jeune, expressif et attachant"
  },
  maman: {
    character: "Maman",
    voice: null,
    style: "douce et rassurante"
  },
  clara: {
    character: "Clara",
    voice: null,
    style: "joyeuse et naturelle"
  },
  coach: {
    character: "Coach",
    voice: null,
    style: "encourageante et dynamique"
  },
  agent_de_comptoir: {
    character: "Agent de comptoir",
    voice: null,
    style: "professionnelle et accueillante"
  },
  voisin: {
    character: "Voisin",
    voice: null,
    style: "amicale et spontanée"
  },
  pilote: {
    character: "Pilote",
    voice: null,
    style: "calme et assurée"
  },
  hotesse: {
    character: "Hôtesse",
    voice: null,
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

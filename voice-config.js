
"use strict";

// Catalogue des voix de VidéaPilot.
// Chaque personnage conserve une identité vocale stable.
// Ce fichier ne génère aucun audio et n'appelle aucune API.

const VOICE_CONFIG = {
  narrateur: {
    character: "Narrateur",
    gender: "masculine",
    ageStyle: "adulte",
    tone: "chaleureux, captivant et rassurant",
    pace: "modéré",
    style: "conte pour enfants"
  },

  leo: {
    character: "Léo",
    gender: "masculine",
    ageStyle: "enfant",
    tone: "jeune, expressif et attachant",
    pace: "naturel",
    style: "timide au début, puis courageux"
  },

  maman: {
    character: "Maman",
    gender: "feminine",
    ageStyle: "adulte",
    tone: "doux, maternel et rassurant",
    pace: "calme",
    style: "bienveillant"
  },

  clara: {
    character: "Clara",
    gender: "feminine",
    ageStyle: "jeune",
    tone: "joyeux, amical et encourageant",
    pace: "naturel",
    style: "enthousiaste"
  },

  coach: {
    character: "Coach",
    gender: "masculine",
    ageStyle: "adulte",
    tone: "dynamique et motivant",
    pace: "énergique",
    style: "encourageant"
  },

  agent_de_comptoir: {
    character: "Agent de comptoir",
    gender: "feminine",
    ageStyle: "adulte",
    tone: "professionnel et accueillant",
    pace: "modéré",
    style: "courtois"
  },

  voisin: {
    character: "Voisin",
    gender: "masculine",
    ageStyle: "adulte",
    tone: "naturel et sympathique",
    pace: "naturel",
    style: "amical"
  },

  pilote: {
    character: "Pilote",
    gender: "masculine",
    ageStyle: "adulte",
    tone: "posé, confiant et rassurant",
    pace: "lent et clair",
    style: "professionnel"
  },

  hotesse: {
    character: "Hôtesse",
    gender: "feminine",
    ageStyle: "adulte",
    tone: "doux, souriant et bienveillant",
    pace: "modéré",
    style: "accueillant"
  }
};

function getVoiceConfig(voiceId) {
  if (typeof voiceId !== "string") {
    return null;
  }

  return VOICE_CONFIG[voiceId] || null;
}

module.exports = {
  VOICE_CONFIG,
  getVoiceConfig
};

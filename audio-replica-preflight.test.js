"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { preflightAudioReplicas } = require("./audio-replica-preflight");

function fixture() {
  const scenes = [[0, 7], [7, 13], [13, 32], [32, 47], [47, 67]]
    .map(([startSeconds, endSeconds], index) => ({ sceneNumber: index + 1, startSeconds, endSeconds }));
  const speakers = {
    narrateur: ["Narrateur", "onyx"],
    leo: ["Léo", "echo"],
    petite_fille_sur_un_balcon: ["Petite fille sur un balcon", "shimmer"],
  };
  const sceneVoices = [
    ["narrateur"], ["narrateur"], ["petite_fille_sur_un_balcon", "petite_fille_sur_un_balcon", "leo", "narrateur"],
    ["leo", "narrateur"], ["leo", "narrateur"],
  ];
  const audioGenerationPlan = scenes.flatMap(({ sceneNumber, startSeconds }) =>
    sceneVoices[sceneNumber - 1].map((voiceId, index) => ({
      sceneNumber,
      segmentId: `scene_${sceneNumber}_dialogue_${index + 1}`,
      character: speakers[voiceId][0],
      voiceId,
      startSeconds: startSeconds + index * 3,
      endSeconds: startSeconds + index * 3 + 2,
    })));
  const files = audioGenerationPlan.map(({ segmentId, character, voiceId }) => ({
    segmentId, character, voiceId, voice: speakers[voiceId][1], filePath: `${segmentId}.mp3`, durationSeconds: 2,
  }));
  return { scenes, audioGenerationPlan, files, mode: "simulation", expectedDurationSeconds: 67 };
}

test("10 répliques conformes sur les cinq scènes, sans modification des horaires", () => {
  const input = fixture();
  const original = structuredClone(input);
  input.files.reverse();
  const report = preflightAudioReplicas(input);
  assert.equal(report.status, "OK");
  assert.equal(report.mode, "simulation");
  assert.equal(report.timelineDurationSeconds, 67);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.segments.map(segment => segment.startSeconds),
    original.audioGenerationPlan.map(segment => segment.startSeconds));
  assert.deepEqual(input.audioGenerationPlan, original.audioGenerationPlan);
  assert.deepEqual(input.scenes, original.scenes);
});

for (const [label, code, change] of [
  ["inventaire incomplet", "MISSING_AUDIO_FILE", data => data.files.pop()],
  ["doublon dans le plan", "DUPLICATE_PLAN_SEGMENT", data => data.audioGenerationPlan.push(data.audioGenerationPlan[0])],
  ["doublon dans l’inventaire", "DUPLICATE_INVENTORY_SEGMENT", data => data.files.push(data.files[0])],
  ["segment inconnu", "UNKNOWN_INVENTORY_SEGMENT", data => data.files.push({ segmentId: "inconnu" })],
  ["mauvaise voix de synthèse", "VOICE_MISMATCH", data => { data.files[0].voice = "echo"; }],
  ["mauvais personnage", "CHARACTER_MISMATCH", data => { data.files[0].character = "Léo"; }],
  ["dépassement de scène", "AUDIO_OUTSIDE_SCENE", data => { data.files[0].durationSeconds = 7.1; }],
  ["chevauchement", "AUDIO_OVERLAP", data => { data.files[2].durationSeconds = 3.1; }],
  ["durée de réplique invalide", "INVALID_AUDIO_DURATION", data => { data.files[0].durationSeconds = 0; }],
  ["total incorrect", "TOTAL_DURATION_MISMATCH", data => { data.scenes.at(-1).endSeconds = 66; }],
  ["fin planifiée hors scène", "PLAN_OUTSIDE_SCENE", data => { data.audioGenerationPlan[0].endSeconds = 8; }],
  ["créneau prévu dépassé", "AUDIO_EXCEEDS_PLANNED_SLOT", data => { data.files[0].durationSeconds = 2.1; }],
]) {
  test(label, () => {
    const data = fixture();
    change(data);
    const report = preflightAudioReplicas(data);
    assert.equal(report.status, "BLOQUÉ");
    assert.ok(report.errors.some(error => error.code === code), JSON.stringify(report.errors));
  });
}

test("le silence entre les scènes reste à sa position absolue", () => {
  const data = fixture();
  const report = preflightAudioReplicas(data);
  assert.deepEqual(report.gaps[0], {
    segmentId: "scene_1_dialogue_1", nextSegmentId: "scene_2_dialogue_1", startSeconds: 2, endSeconds: 7,
  });
});

test("le mode réel exige une sonde et refuse les fichiers fictifs, même avec des durées déclarées", () => {
  const data = { ...fixture(), mode: "real" };
  assert.equal(preflightAudioReplicas(data).errors[0].code, "DURATION_PROBE_REQUIRED");
  data.files = data.files.map(file => ({ ...file, filePath: path.resolve(__dirname, "fixtures-inexistantes", file.filePath) }));
  const report = preflightAudioReplicas({ ...data, measureDurationSeconds: () => assert.fail("Fichier absent") });
  assert.equal(report.status, "BLOQUÉ");
  assert.equal(report.errors.filter(error => error.code === "MISSING_AUDIO_FILE").length, 10);
});

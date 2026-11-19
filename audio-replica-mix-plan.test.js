"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { preflightAudioReplicas } = require("./audio-replica-preflight");
const { buildAudioReplicaMixPlan } = require("./audio-replica-mix-plan");

function fixture() {
  const bounds = [[0, 7], [7, 13], [13, 32], [32, 47], [47, 67]];
  const scenes = bounds.map(([startSeconds, endSeconds], index) => ({
    sceneNumber: index + 1, startSeconds, endSeconds,
  }));
  const voices = [
    ["narrateur", "Narrateur", "onyx"], ["leo", "Léo", "echo"],
    ["petite_fille_sur_un_balcon", "Petite fille sur un balcon", "shimmer"],
  ];
  const placements = [[1, 0.5, 0], [2, 7.25, 0], [3, 13, 2], [3, 16, 2], [3, 20, 1],
    [3, 24, 0], [4, 33, 1], [4, 38, 0], [5, 48, 1], [5, 57, 0]];
  const audioGenerationPlan = placements.map(([sceneNumber, startSeconds, voiceIndex], index) => ({
    segmentId: `segment_${index + 1}`, sceneNumber, startSeconds, endSeconds: startSeconds + 2,
    voiceId: voices[voiceIndex][0], character: voices[voiceIndex][1], text: "Réplique fictive",
  }));
  const files = audioGenerationPlan.map(({ segmentId, voiceId, character }, index) => ({
    segmentId, voiceId, character, voice: voices[placements[index][2]][2],
    filePath: `${segmentId}.mp3`, durationSeconds: 1.5,
  }));
  const input = { mode: "simulation", expectedDurationSeconds: 67, scenes, audioGenerationPlan, files };
  return { ...input, report: preflightAudioReplicas(input) };
}

test("10 répliques sur 67 secondes avec filtres de mixage préparés uniquement", () => {
  const input = fixture();
  const plan = buildAudioReplicaMixPlan(input);
  assert.equal(plan.status, "OK");
  assert.equal(plan.totalDurationSeconds, 67);
  assert.equal(plan.executed, false);
  assert.equal(plan.replicas.length, 10);
  assert.deepEqual(plan.replicas[2], {
    segmentId: "segment_3", sceneNumber: 3, character: "Petite fille sur un balcon",
    voiceId: "petite_fille_sur_un_balcon", voice: "shimmer", filePath: "segment_3.mp3",
    startSeconds: 13, plannedEndSeconds: 15, durationSeconds: 1.5, actualEndSeconds: 14.5, delayMs: 13000,
  });
  assert.match(plan.filtergraph, /adelay=13000:all=1\[a2\]/);
  assert.match(plan.filtergraph, /amix=inputs=10:duration=longest:normalize=0,atrim=duration=67,apad=whole_dur=67\[out\]$/);
});

test("silences inter-scènes conservés et délais indépendants des durées cumulées", () => {
  const input = fixture();
  input.files[0].durationSeconds = 0.75;
  input.report = preflightAudioReplicas(input);
  const plan = buildAudioReplicaMixPlan(input);
  assert.equal(plan.status, "OK");
  assert.deepEqual(plan.gaps[0], { segmentId: "segment_1", nextSegmentId: "segment_2", startSeconds: 1.25, endSeconds: 7.25 });
  assert.deepEqual(plan.replicas.map(segment => segment.delayMs),
    [500, 7250, 13000, 16000, 20000, 24000, 33000, 38000, 48000, 57000]);
});

test("rapport BLOQUÉ, ancien rapport sans empreinte et mode incompatible refusés", () => {
  const input = fixture();
  assert.equal(buildAudioReplicaMixPlan({ ...input, report: { status: "BLOQUÉ" } }).errors[0].code, "PREFLIGHT_NOT_OK");
  assert.equal(buildAudioReplicaMixPlan({ ...input, report: { status: "OK", mode: "simulation" } }).errors[0].code, "UNBOUND_PREFLIGHT_REPORT");
  assert.equal(buildAudioReplicaMixPlan({ ...input, mode: "real" }).errors[0].code, "UNBOUND_PREFLIGHT_REPORT");
});

for (const [label, mutate] of [
  ["texte changé", input => { input.audioGenerationPlan[0].text = "Autre texte"; }],
  ["créneau changé", input => { input.audioGenerationPlan[0].startSeconds = 0.6; }],
  ["fichier remplacé dans l’inventaire", input => { input.files[0].filePath = "autre.mp3"; }],
  ["durée simulée modifiée", input => { input.files[0].durationSeconds = 1; }],
  ["rapport altéré", input => { input.report.segments[0].actualEndSeconds = 2.1; }],
]) {
  test(`rapport OK périmé ou incohérent : ${label}`, () => {
    const input = fixture();
    mutate(input);
    const plan = buildAudioReplicaMixPlan(input);
    assert.equal(plan.status, "BLOQUÉ");
    assert.equal(plan.errors[0].code, "STALE_OR_INCONSISTENT_PREFLIGHT");
  });
}

for (const [label, code, mutate] of [
  ["fichier manquant", "MISSING_AUDIO_FILE", input => input.files.pop()],
  ["identifiant dupliqué", "DUPLICATE_INVENTORY_SEGMENT", input => input.files.push(input.files[0])],
  ["fichier réutilisé", "AUDIO_FILE_REUSED", input => { input.files[1].filePath = input.files[0].filePath; }],
  ["dépassement", "AUDIO_OUTSIDE_SCENE", input => { input.files[0].durationSeconds = 8; }],
  ["chevauchement", "AUDIO_OVERLAP", input => { input.files[2].durationSeconds = 3.5; }],
  ["position négative", "INVALID_SEGMENT_TIMING", input => { input.audioGenerationPlan[0].startSeconds = -1; }],
  ["durée invalide", "INVALID_AUDIO_DURATION", input => { input.files[0].durationSeconds = 0; }],
  ["total incorrect", "TOTAL_DURATION_MISMATCH", input => { input.expectedDurationSeconds = 66; }],
]) {
  test(`données courantes bloquées : ${label}`, () => {
    const input = fixture();
    mutate(input);
    const plan = buildAudioReplicaMixPlan(input);
    assert.equal(plan.status, "BLOQUÉ");
    assert.equal(plan.errors[0].code, "CURRENT_PREFLIGHT_BLOCKED");
    assert.ok(plan.errors.some(error => error.code === code));
  });
}

test("un délai qui ne peut être exprimé à la milliseconde est refusé", () => {
  const input = fixture();
  input.audioGenerationPlan[0].startSeconds = 0.5005;
  input.report = preflightAudioReplicas(input);
  assert.equal(buildAudioReplicaMixPlan(input).errors[0].code, "UNREPRESENTABLE_ABSOLUTE_DELAY");
});

test("plan déterministe après sérialisation et réordonnancement de l’inventaire", () => {
  const input = fixture();
  const first = buildAudioReplicaMixPlan(input);
  const copy = JSON.parse(JSON.stringify(input));
  copy.files.reverse();
  assert.equal(first.status, "OK");
  assert.deepEqual(buildAudioReplicaMixPlan(copy), first);
});

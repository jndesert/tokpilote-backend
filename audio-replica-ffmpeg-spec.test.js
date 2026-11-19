"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { preflightAudioReplicas } = require("./audio-replica-preflight");
const { buildAudioReplicaMixPlan } = require("./audio-replica-mix-plan");
const { buildAudioReplicaFfmpegSpec, revalidateAudioReplicaFfmpegSpec } = require("./audio-replica-ffmpeg-spec");

function fixture(overrides = {}) {
  const scenes = [[0, 7], [7, 13], [13, 32], [32, 47], [47, 67]]
    .map(([startSeconds, endSeconds], index) => ({ sceneNumber: index + 1, startSeconds, endSeconds }));
  const audioGenerationPlan = [
    [1, 0.5], [2, 7.25], [3, 13], [3, 16], [3, 20], [3, 24], [4, 33], [4, 38], [5, 48], [5, 57],
  ].map(([sceneNumber, startSeconds], index) => ({
    segmentId: `replica_${index + 1}`, sceneNumber, startSeconds, endSeconds: startSeconds + 2,
    character: "Léo", voiceId: "leo", text: "Réplique fictive",
  }));
  const files = audioGenerationPlan.map(({ segmentId, character, voiceId }, index) => ({
    segmentId, character, voiceId, voice: "echo", durationSeconds: 1.5,
    filePath: path.join(__dirname, "audio fictif", index === 0 ? "entrée ; test.mp3" : `${segmentId}.mp3`),
  }));
  const input = {
    audioGenerationPlan, files, scenes, expectedDurationSeconds: 67, mode: "simulation",
    outputPath: path.join(__dirname, "audio fictif", "mix.wav"), ...overrides,
  };
  const report = preflightAudioReplicas(input);
  return { ...input, report, mixPlan: buildAudioReplicaMixPlan({ ...input, report }) };
}

test("dix arguments d’entrée dans l’ordre du plan, sans shell ni exécution", () => {
  const input = fixture();
  input.files.reverse();
  const spec = buildAudioReplicaFfmpegSpec(input);
  assert.equal(spec.status, "OK");
  assert.equal(spec.totalDurationSeconds, 67);
  assert.equal(spec.executed, false);
  assert.equal(spec.shell, false);
  assert.equal(spec.requiresRealRevalidation, true);
  assert.ok(spec.args.includes("-n"));
  assert.ok(!spec.args.includes("-y"));
  assert.equal(spec.args.at(-1), input.outputPath);
  assert.deepEqual(spec.inputs.map(row => row.segmentId), input.audioGenerationPlan.map(row => row.segmentId));
  assert.deepEqual(spec.args.flatMap((arg, index) => arg === "-i" ? [spec.args[index + 1]] : []),
    spec.inputs.map(row => row.filePath));
  assert.ok(spec.args.includes(path.join(__dirname, "audio fictif", "entrée ; test.mp3")));
});

test("délais absolus, silences et filtres de fin de piste", () => {
  const spec = buildAudioReplicaFfmpegSpec(fixture());
  assert.deepEqual(spec.inputs.map(row => row.delayMs), [500, 7250, 13000, 16000, 20000, 24000, 33000, 38000, 48000, 57000]);
  assert.deepEqual(spec.gaps[0], { segmentId: "replica_1", nextSegmentId: "replica_2", startSeconds: 2, endSeconds: 7.25 });
  assert.match(spec.filtergraph, /\[1:a\]aresample=44100,adelay=7250:all=1\[a1\]/);
  assert.match(spec.filtergraph, /amix=inputs=10:duration=longest:normalize=0,atrim=duration=67,apad=whole_dur=67\[out\]$/);
  assert.equal(spec.filtergraph.match(/atrim=/g).length, 1);
  assert.deepEqual(buildAudioReplicaFfmpegSpec(fixture()), spec);
});

for (const [label, code, mutate] of [
  ["doublon", "DUPLICATE_INVENTORY_SEGMENT", input => input.files.push(input.files[0])],
  ["entrée manquante", "MISSING_AUDIO_FILE", input => input.files.pop()],
  ["entrée inconnue", "UNKNOWN_INVENTORY_SEGMENT", input => { input.files[0].segmentId = "inconnu"; }],
  ["durée invalide", "INVALID_AUDIO_DURATION", input => { input.files[0].durationSeconds = -1; }],
  ["position négative", "INVALID_SEGMENT_TIMING", input => { input.audioGenerationPlan[0].startSeconds = -1; }],
  ["durée totale incorrecte", "TOTAL_DURATION_MISMATCH", input => { input.expectedDurationSeconds = 66; }],
  ["rapport périmé", "STALE_OR_INCONSISTENT_PREFLIGHT", input => { input.files[0].durationSeconds = 1; }],
  ["plan altéré", "STALE_OR_INCONSISTENT_MIX_PLAN", input => { input.mixPlan.replicas[0].delayMs = 0; }],
  ["filtre injecté", "STALE_OR_INCONSISTENT_MIX_PLAN", input => { input.mixPlan.filtergraph += ";amovie=intrus"; }],
  ["chemin protocolaire", "INVALID_INPUT_PATH", input => { input.files[0].filePath = "https://example.invalid/a.mp3"; }],
  ["option à la place d’un fichier", "INVALID_INPUT_PATH", input => { input.files[0].filePath = "-y"; }],
  ["sortie non WAV", "INVALID_OUTPUT_PATH", input => { input.outputPath = path.join(__dirname, "mix.mp4"); }],
]) {
  test(`refus du cas ${label}`, () => {
    const input = fixture();
    mutate(input);
    const spec = buildAudioReplicaFfmpegSpec(input);
    assert.equal(spec.status, "BLOQUÉ");
    assert.ok(spec.errors.some(error => error.code === code), JSON.stringify(spec.errors));
    assert.equal(spec.args, undefined);
  });
}

test("une sortie WAV identique à une entrée est refusée", () => {
  const initial = fixture();
  initial.files[0].filePath = initial.outputPath;
  const input = fixture({ files: initial.files });
  assert.equal(buildAudioReplicaFfmpegSpec(input).errors[0].code, "OUTPUT_COLLIDES_WITH_INPUT");
});

test("la vérification avant exécution exige un plan réel et détecte un fichier remplacé", t => {
  const simulated = fixture();
  assert.equal(revalidateAudioReplicaFfmpegSpec(buildAudioReplicaFfmpegSpec(simulated), simulated).errors[0].code,
    "REAL_SPECIFICATION_REQUIRED");
  const identities = new Map(simulated.files.map((file, index) => [file.filePath, BigInt(index + 1)]));
  let modified = false;
  t.mock.method(fs, "lstatSync", filePath => ({
    isFile: () => true, dev: 1n, ino: identities.get(filePath), size: 1024n,
    mtimeNs: modified ? 2n : 1n, ctimeNs: 1n,
  }));
  const real = fixture({ mode: "real", measureDurationSeconds: () => 1.5 });
  const spec = buildAudioReplicaFfmpegSpec(real);
  assert.equal(spec.status, "OK");
  assert.deepEqual(revalidateAudioReplicaFfmpegSpec(spec, real), spec);
  modified = true;
  const stale = revalidateAudioReplicaFfmpegSpec(spec, real);
  assert.equal(stale.status, "BLOQUÉ");
  assert.ok(stale.errors.some(error => error.code === "STALE_OR_INCONSISTENT_PREFLIGHT"));
});

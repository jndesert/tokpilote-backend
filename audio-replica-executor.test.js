"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const path = require("node:path");
const test = require("node:test");
const { preflightAudioReplicas } = require("./audio-replica-preflight");
const { buildAudioReplicaMixPlan } = require("./audio-replica-mix-plan");
const { buildAudioReplicaFfmpegSpec } = require("./audio-replica-ffmpeg-spec");
const { simulateAudioReplicaExecution } = require("./audio-replica-executor");

function bindPlan(input) {
  input.report = preflightAudioReplicas(input);
  input.mixPlan = buildAudioReplicaMixPlan(input);
  input.specification = buildAudioReplicaFfmpegSpec(input);
  assert.equal(input.specification.status, "OK");
}

function fixture() {
  const sourceRoot = path.join(__dirname, "sources virtuelles");
  const temporaryRoot = path.join(__dirname, "temporaires virtuels");
  const root = path.join(temporaryRoot, "session unique");
  const output = path.join(root, "mix.wav");
  const bounds = [[0, 7], [7, 13], [13, 32], [32, 47], [47, 67]];
  const scenes = bounds.map(([startSeconds, endSeconds], index) => ({
    sceneNumber: index + 1, startSeconds, endSeconds,
  }));
  const placements = [[1, 0.5], [2, 7.25], [3, 13], [3, 16], [3, 20],
    [3, 24], [4, 33], [4, 38], [5, 48], [5, 57]];
  const audioGenerationPlan = placements.map(([sceneNumber, startSeconds], index) => ({
    segmentId: `segment_${index + 1}`, sceneNumber, startSeconds, endSeconds: startSeconds + 2,
    character: "Léo", voiceId: "leo",
  }));
  const store = new Map();
  const files = audioGenerationPlan.map(({ segmentId, character, voiceId }) => {
    const filePath = path.join(sourceRoot, `${segmentId}.mp3`);
    const bytes = Buffer.from(segmentId);
    const identity = `source_${segmentId}`;
    store.set(filePath, { kind: "file", realPath: filePath, bytes, identity });
    return { segmentId, character, voiceId, voice: "echo", filePath, identity, durationSeconds: 1.5,
      sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const input = { sourceRoot, temporaryRoot, mode: "simulation", expectedDurationSeconds: 67, scenes, files,
    audioGenerationPlan, outputPath: path.join(temporaryRoot, "plan.wav") };
  bindPlan(input);
  const operations = [];
  const launches = [];
  const adapters = {
    inspect: filePath => store.get(filePath),
    createWorkspace(parent) {
      assert.equal(parent, temporaryRoot);
      operations.push("create");
      store.set(root, { kind: "directory", realPath: root, private: true, identity: "workspace" });
      return {
        root,
        cleanup() {
          operations.push("cleanup");
          for (const filePath of store.keys()) {
            if (filePath === root || path.dirname(filePath) === root) store.delete(filePath);
          }
        },
      };
    },
    copyProtected(source, target) {
      operations.push("copy");
      store.set(target, { kind: "file", realPath: target, bytes: Buffer.from(store.get(source).bytes),
        identity: `copy_${target}`, protected: true });
    },
    measureDurationSeconds(filePath) {
      assert.equal(path.dirname(filePath), root);
      operations.push("probe");
      return 1.5;
    },
    launchSimulation(spec) {
      operations.push("fake launch");
      launches.push(spec);
      assert.equal(spec.mode, "simulation");
      assert.equal(spec.shell, false);
      assert.ok(spec.args.includes("-n"));
      assert.equal(spec.args.at(-1), output);
      const inputs = spec.args.flatMap((arg, index) => arg === "-i" ? [spec.args[index + 1]] : []);
      assert.equal(inputs.length, 10);
      assert.ok(inputs.every(filePath => path.dirname(filePath) === root && store.get(filePath).protected));
      return { exitCode: 0 };
    },
  };
  return { input, adapters, store, root, output, operations, launches };
}

test("dix copies protégées et un seul lancement simulé sur les positions absolues", async () => {
  const data = fixture();
  const before = structuredClone(data.input);
  const result = await simulateAudioReplicaExecution(data.input, data.adapters);
  assert.equal(result.status, "SIMULÉ");
  assert.equal(result.executed, false);
  assert.equal(result.outputVerified, false);
  assert.equal(result.cleanup, "TERMINÉ");
  assert.equal(result.launch.totalDurationSeconds, 67);
  assert.deepEqual(result.launch.delaysMs, [500, 7250, 13000, 16000, 20000, 24000, 33000, 38000, 48000, 57000]);
  assert.equal(data.launches.length, 1);
  assert.equal(data.operations.filter(op => op === "probe").length, 10);
  assert.equal(data.operations.at(-1), "cleanup");
  assert.equal(data.store.size, 10);
  assert.deepEqual(data.input, before);
});

for (const [label, code, change] of [
  ["fichier manquant", "AUDIO_FILE_MISSING", d => d.store.delete(d.input.files[0].filePath)],
  ["source remplacée", "AUDIO_IDENTITY_CHANGED", d => { d.store.get(d.input.files[0].filePath).identity = "autre"; }],
  ["empreinte incorrecte", "AUDIO_FINGERPRINT_MISMATCH", d => { d.store.get(d.input.files[0].filePath).bytes = Buffer.from("intrus"); }],
  ["lien symbolique", "UNSAFE_AUDIO_PATH", d => { d.store.get(d.input.files[0].filePath).isSymbolicLink = true; }],
  ["chemin non autorisé", "SOURCE_PATH_OUTSIDE_ROOT", d => {
    d.input.files[0].filePath = path.join(d.input.temporaryRoot, "hors-source.mp3");
    bindPlan(d.input);
  }],
  ["rapport périmé", "STALE_OR_INCONSISTENT_SPECIFICATION", d => { d.input.files[0].durationSeconds = 1; }],
  ["spécification altérée", "STALE_OR_INCONSISTENT_SPECIFICATION", d => { d.input.specification.args[0] = "-y"; }],
  ["mode réel", "INVALID_SIMULATION_INPUT", d => { d.input.mode = "real"; }],
]) {
  test(`refus avant création de la zone temporaire : ${label}`, async () => {
    const data = fixture();
    change(data);
    const result = await simulateAudioReplicaExecution(data.input, data.adapters);
    assert.equal(result.status, "BLOQUÉ");
    assert.equal(result.errors[0].code, code);
    assert.equal(result.launch.attempted, false);
    assert.deepEqual(data.operations, []);
  });
}

test("remplacement d’une copie après mesure : rejet et nettoyage", async () => {
  const data = fixture();
  const probe = data.adapters.measureDurationSeconds;
  data.adapters.measureDurationSeconds = filePath => {
    const duration = probe(filePath);
    data.store.get(filePath).identity += "_remplacement";
    return duration;
  };
  const result = await simulateAudioReplicaExecution(data.input, data.adapters);
  assert.equal(result.errors[0].code, "AUDIO_IDENTITY_CHANGED");
  assert.equal(result.launch.attempted, false);
  assert.equal(result.cleanup, "TERMINÉ");
  assert.equal(data.store.size, 10);
});

test("une sortie préexistante dans la zone est refusée sans lancement", async () => {
  const data = fixture();
  const create = data.adapters.createWorkspace;
  data.adapters.createWorkspace = parent => {
    const workspace = create(parent);
    data.store.set(data.output, { kind: "file" });
    return workspace;
  };
  const result = await simulateAudioReplicaExecution(data.input, data.adapters);
  assert.equal(result.errors[0].code, "TEMP_OUTPUT_EXISTS");
  assert.equal(result.launch.attempted, false);
  assert.equal(result.cleanup, "TERMINÉ");
});

test("durée différente sur une copie : rejet avant lancement et nettoyage", async () => {
  const data = fixture();
  data.adapters.measureDurationSeconds = () => 1.4;
  const result = await simulateAudioReplicaExecution(data.input, data.adapters);
  assert.equal(result.errors[0].code, "COPY_DURATION_CHANGED");
  assert.equal(result.launch.attempted, false);
  assert.equal(result.cleanup, "TERMINÉ");
  assert.equal(data.store.size, 10);
});

for (const [label, code, fake] of [
  ["timeout signalé", "SIMULATED_TIMEOUT", () => ({ timedOut: true })],
  ["erreur de lancement", "SIMULATED_LAUNCH_FAILED", () => { throw new Error("simulé"); }],
  ["code de sortie non nul", "SIMULATED_NONZERO_EXIT", () => ({ exitCode: 7 })],
]) {
  test(`${label} : nettoyage et sources conservées`, async () => {
    const data = fixture();
    data.adapters.launchSimulation = fake;
    const result = await simulateAudioReplicaExecution(data.input, data.adapters);
    assert.equal(result.status, "BLOQUÉ");
    assert.equal(result.errors[0].code, code);
    assert.equal(result.launch.attempted, true);
    assert.equal(result.cleanup, "TERMINÉ");
    assert.equal(result.outputVerified, false);
    assert.equal(data.store.size, 10);
  });
}

test("un faux lanceur en attente reçoit l’annulation à l’échéance", async () => {
  const data = fixture();
  data.input.timeoutMs = 10;
  let aborted = false;
  data.adapters.launchSimulation = ({ signal }) => new Promise(() => {
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
  });
  const result = await simulateAudioReplicaExecution(data.input, data.adapters);
  assert.equal(result.errors[0].code, "SIMULATED_TIMEOUT");
  assert.equal(aborted, true);
  assert.equal(result.cleanup, "TERMINÉ");
});

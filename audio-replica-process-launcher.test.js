"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { preflightAudioReplicas } = require("./audio-replica-preflight");
const { buildAudioReplicaMixPlan } = require("./audio-replica-mix-plan");
const { buildAudioReplicaFfmpegSpec } = require("./audio-replica-ffmpeg-spec");
const { createAudioReplicaProcessLauncher } = require("./audio-replica-process-launcher");

async function fixture(t) {
  const temp = await fs.realpath(os.tmpdir());
  const workspaceRoot = await fs.mkdtemp(path.join(temp, "replica-process-test-"));
  t.after(async () => {
    assert.equal(path.dirname(workspaceRoot), temp);
    assert.match(path.basename(workspaceRoot), /^replica-process-test-/);
    assert.equal(await fs.realpath(workspaceRoot), workspaceRoot);
    await fs.rm(workspaceRoot, { recursive: true });
  });
  const filePath = path.join(workspaceRoot, "replica.wav");
  const outputPath = path.join(workspaceRoot, "mix.wav");
  const ffmpegPath = path.join(workspaceRoot, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const bytes = Buffer.from("fixture textuelle, aucun audio");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(filePath, bytes, { flag: "wx" });
  await fs.writeFile(ffmpegPath, "fichier inerte, jamais exécuté", { flag: "wx" });
  const stat = await fs.lstat(filePath, { bigint: true });
  const identity = `${stat.dev}:${stat.ino}:${stat.ctimeNs}`;
  const currentInput = {
    mode: "real", expectedDurationSeconds: 67, outputPath,
    scenes: [{ sceneNumber: 1, startSeconds: 0, endSeconds: 67 }],
    audioGenerationPlan: [{ segmentId: "1", sceneNumber: 1, startSeconds: 1, endSeconds: 2, character: "Léo", voiceId: "leo" }],
    files: [{ segmentId: "1", filePath, character: "Léo", voiceId: "leo", voice: "echo", identity, sha256 }],
    measureDurationSeconds: candidate => candidate === filePath ? 0.5 : undefined,
  };
  currentInput.report = preflightAudioReplicas(currentInput);
  currentInput.mixPlan = buildAudioReplicaMixPlan(currentInput);
  const specification = buildAudioReplicaFfmpegSpec(currentInput);
  assert.equal(specification.status, "OK");
  async function inspect(candidate) {
    if (candidate === workspaceRoot) {
      return { kind: "directory", private: true, isSymbolicLink: false, realPath: candidate, identity: "fixture privée simulée" };
    }
    if (candidate === filePath) {
      return { kind: "file", protected: true, isSymbolicLink: false, realPath: candidate, identity, bytes: await fs.readFile(candidate) };
    }
    return undefined;
  }
  return { ffmpegPath, filePath, outputPath, request: { specification, currentInput, workspaceRoot, inspect } };
}

function nodeTestSupervisor(data, script, { confirmTree = true, stop = true, hangCompletion = false } = {}) {
  const stats = { starts: 0, stopRequests: 0 };
  const supervisor = {
    treeControl: true,
    start(executable, args, options) {
      stats.starts++;
      assert.equal(executable, data.ffmpegPath);
      assert.deepEqual(args, data.request.specification.args);
      assert.equal(options.shell, false);
      // Only this known Node script is run. No test spawns the designated FFmpeg path.
      const child = spawn(process.execPath, ["-e", script], options);
      const closed = new Promise(resolve => {
        let startError = false;
        child.once("error", () => { startError = true; });
        child.once("close", (exitCode, signal) => resolve({ exitCode, signal, startError, treeTerminated: confirmTree }));
      });
      stats.closed = closed;
      stats.kill = () => child.kill();
      return {
        stdout: child.stdout, stderr: child.stderr,
        completion: hangCompletion ? new Promise(() => {}) : closed,
        requestStop() { stats.stopRequests++; if (stop) child.kill(); },
      };
    },
  };
  return { supervisor, stats };
}

test("processus Node factice réussi, arrêt confirmé et sortie non validée", async t => {
  const data = await fixture(t);
  const { supervisor, stats } = nodeTestSupervisor(data, "process.stdout.write('test'); process.stderr.write('note');");
  const result = await createAudioReplicaProcessLauncher({ ffmpegPath: data.ffmpegPath, supervisor })(data.request);
  assert.equal(result.status, "TERMINÉ");
  assert.equal(result.outputVerified, false);
  assert.equal(result.treeTerminated, true);
  assert.equal(result.cleanupAllowed, true);
  assert.deepEqual(result.output, { stdout: "test", stderr: "note", truncated: false });
  assert.equal(stats.starts, 1);
  await assert.rejects(fs.access(data.outputPath), { code: "ENOENT" });
});

test("absence de superviseur et arguments modifiés bloqués avant lancement", async t => {
  const data = await fixture(t);
  assert.equal((await createAudioReplicaProcessLauncher({ ffmpegPath: data.ffmpegPath })(data.request)).errors[0].code,
    "PROCESS_TREE_SUPERVISOR_REQUIRED");
  const launch = createAudioReplicaProcessLauncher({ ffmpegPath: data.ffmpegPath,
    supervisor: { treeControl: true, start: () => assert.fail("aucun lancement") } });
  for (const argument of ["-y", "-report", "amovie=intrus"]) {
    const request = { ...data.request, specification: { ...data.request.specification, args: [...data.request.specification.args, argument] } };
    const result = await launch(request);
    assert.equal(result.attempted, false);
    assert.equal(result.errors[0].code, "FFMPEG_SPEC_REVALIDATION_FAILED");
  }
  const simulation = { ...data.request, specification: { ...data.request.specification, launchMode: "simulation" } };
  assert.equal((await launch(simulation)).attempted, false);
});

test("erreur du superviseur au lancement : nettoyage interdit par défaut", async t => {
  const data = await fixture(t);
  const supervisor = { treeControl: true, start() { throw new Error("panne simulée"); } };
  const result = await createAudioReplicaProcessLauncher({ ffmpegPath: data.ffmpegPath, supervisor })(data.request);
  assert.equal(result.errors[0].code, "PROCESS_START_FAILED");
  assert.equal(result.cleanupAllowed, false);
  await fs.access(data.filePath);
});

test("sortie non nulle du processus Node factice", async t => {
  const data = await fixture(t);
  const { supervisor } = nodeTestSupervisor(data, "process.exitCode = 7;");
  const result = await createAudioReplicaProcessLauncher({ ffmpegPath: data.ffmpegPath, supervisor })(data.request);
  assert.equal(result.errors[0].code, "PROCESS_NONZERO_EXIT");
  assert.equal(result.exitCode, 7);
  assert.equal(result.cleanupAllowed, true);
});

test("timeout : demande d’arrêt puis confirmation de la terminaison", async t => {
  const data = await fixture(t);
  const { supervisor, stats } = nodeTestSupervisor(data, "setInterval(() => {}, 1000);");
  t.after(async () => { stats.kill?.(); await stats.closed; });
  const result = await createAudioReplicaProcessLauncher({
    ffmpegPath: data.ffmpegPath, supervisor, timeoutMs: 100, stopGraceMs: 2500,
  })(data.request);
  assert.equal(result.errors[0].code, "PROCESS_TIMEOUT");
  assert.equal(stats.stopRequests, 1);
  assert.equal(result.treeTerminated, true);
  assert.equal(result.cleanupAllowed, true);
});

test("arrêt non confirmé à l’échéance : aucune autorisation de nettoyage", async t => {
  const data = await fixture(t);
  const { supervisor, stats } = nodeTestSupervisor(data, "setInterval(() => {}, 1000);", { stop: false, hangCompletion: true });
  try {
    const result = await createAudioReplicaProcessLauncher({
      ffmpegPath: data.ffmpegPath, supervisor, timeoutMs: 80, stopGraceMs: 80,
    })(data.request);
    assert.deepEqual(result.errors.map(error => error.code), ["PROCESS_TIMEOUT", "PROCESS_TREE_TERMINATION_UNCONFIRMED"]);
    assert.equal(stats.stopRequests, 1);
    assert.equal(result.cleanupAllowed, false);
    await fs.access(data.filePath);
  } finally {
    // The test harness owns the known Node child and waits before fixture cleanup.
    stats.kill?.();
    await stats.closed;
  }
});

test("sortie bornée et arrêt lorsque le budget stdout/stderr est dépassé", async t => {
  const data = await fixture(t);
  const { supervisor, stats } = nodeTestSupervisor(data, "process.stdout.write('a'.repeat(10000)); setInterval(() => {}, 1000);");
  t.after(async () => { stats.kill?.(); await stats.closed; });
  const result = await createAudioReplicaProcessLauncher({ ffmpegPath: data.ffmpegPath, supervisor, maxOutputBytes: 64 })(data.request);
  assert.equal(result.errors[0].code, "PROCESS_OUTPUT_LIMIT");
  assert.equal(result.output.truncated, true);
  assert.equal(Buffer.byteLength(result.output.stdout + result.output.stderr), 64);
  assert.equal(result.treeTerminated, true);
});

test("la fin du processus principal ne suffit pas si les descendants restent incertains", async t => {
  const data = await fixture(t);
  const { supervisor } = nodeTestSupervisor(data, "process.exitCode = 0;", { confirmTree: false });
  const result = await createAudioReplicaProcessLauncher({ ffmpegPath: data.ffmpegPath, supervisor })(data.request);
  assert.equal(result.exitCode, 0);
  assert.equal(result.errors[0].code, "PROCESS_TREE_TERMINATION_UNCONFIRMED");
  assert.equal(result.cleanupAllowed, false);
  await fs.access(data.filePath);
});

test("une interruption demande l’arrêt et attend sa confirmation", async t => {
  const data = await fixture(t);
  const { supervisor, stats } = nodeTestSupervisor(data, "setInterval(() => {}, 1000);");
  t.after(async () => { stats.kill?.(); await stats.closed; });
  const controller = new AbortController();
  const start = supervisor.start;
  supervisor.start = (...args) => {
    const handle = start(...args);
    queueMicrotask(() => controller.abort());
    return handle;
  };
  const result = await createAudioReplicaProcessLauncher({ ffmpegPath: data.ffmpegPath, supervisor })({
    ...data.request, signal: controller.signal,
  });
  assert.equal(result.errors[0].code, "PROCESS_INTERRUPTED");
  assert.equal(stats.stopRequests, 1);
  assert.equal(result.treeTerminated, true);
  assert.equal(result.cleanupAllowed, true);
});

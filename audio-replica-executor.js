"use strict";

const path = require("node:path");
const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { preflightAudioReplicas } = require("./audio-replica-preflight");
const { buildAudioReplicaMixPlan } = require("./audio-replica-mix-plan");
const { buildAudioReplicaFfmpegSpec } = require("./audio-replica-ffmpeg-spec");

function localAbsolute(filePath) {
  return typeof filePath === "string" && path.isAbsolute(filePath) &&
    !/^[\\/]{2}|[\x00-\x1f\x7f]/.test(filePath) &&
    (process.platform !== "win32" || (/^[a-z]:[\\/]/i.test(filePath) && !/[:*?"<>|]/.test(filePath.slice(2))));
}

function inside(root, filePath) {
  if (!localAbsolute(root) || !localAbsolute(filePath)) return false;
  const relative = path.relative(root, filePath);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

class SimulationError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.details = details;
  }
}

// Adapters model a private filesystem and a fake process. This module has no default I/O or launcher.
async function simulateAudioReplicaExecution(input = {}, adapters = {}) {
  const result = { status: "BLOQUÉ", mode: "simulation", executed: false, outputVerified: false,
    validations: [], launch: { attempted: false }, cleanup: "NON_NÉCESSAIRE", errors: [] };
  const { inspect, createWorkspace, copyProtected, measureDurationSeconds, launchSimulation } = adapters;
  let workspace;
  let stage = "INVALID_SIMULATION_INPUT";

  async function inspectExpected(filePath, expected, protectedCopy = false) {
    const info = await inspect(filePath);
    const details = { segmentId: expected.segmentId };
    if (!info) throw new SimulationError("AUDIO_FILE_MISSING", details);
    if (info.isSymbolicLink || info.realPath !== path.resolve(filePath)) {
      throw new SimulationError("UNSAFE_AUDIO_PATH", details);
    }
    if (info.kind !== "file" || typeof info.identity !== "string" || !info.identity ||
        (protectedCopy && info.protected !== true)) {
      throw new SimulationError("UNSAFE_AUDIO_FILE", details);
    }
    if (expected.identity !== undefined && expected.identity !== info.identity) {
      throw new SimulationError("AUDIO_IDENTITY_CHANGED", details);
    }
    if (!Buffer.isBuffer(info.bytes) || info.bytes.length === 0) {
      throw new SimulationError("AUDIO_BYTES_UNAVAILABLE", details);
    }
    if (createHash("sha256").update(info.bytes).digest("hex") !== expected.sha256) {
      throw new SimulationError("AUDIO_FINGERPRINT_MISMATCH", details);
    }
    return info.identity;
  }

  try {
    input = structuredClone(input);
    const { sourceRoot, temporaryRoot, specification, timeoutMs = 5000 } = input;
    if (input.mode !== "simulation" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 ||
        !localAbsolute(sourceRoot) || !localAbsolute(temporaryRoot) ||
        path.relative(sourceRoot, temporaryRoot) === "" || inside(sourceRoot, temporaryRoot) ||
        inside(temporaryRoot, sourceRoot) ||
        [inspect, createWorkspace, copyProtected, measureDurationSeconds, launchSimulation].some(fn => typeof fn !== "function")) {
      throw new SimulationError(stage);
    }

    const current = buildAudioReplicaFfmpegSpec(input);
    if (current.status !== "OK" || !isDeepStrictEqual(specification, current)) {
      throw new SimulationError("STALE_OR_INCONSISTENT_SPECIFICATION", { validationErrors: current.errors || [] });
    }
    result.validations.push("PLAN_AND_SPECIFICATION");

    stage = "SOURCE_INSPECTION_FAILED";
    const sources = new Map(input.files.map(file => [file.segmentId, file]));
    const ordered = current.inputs.map(entry => sources.get(entry.segmentId));
    const sourceIdentities = new Set();
    for (const source of ordered) {
      if (!inside(sourceRoot, source.filePath)) {
        throw new SimulationError("SOURCE_PATH_OUTSIDE_ROOT", { segmentId: source.segmentId });
      }
      if (typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256) ||
          typeof source.identity !== "string" || !source.identity) {
        throw new SimulationError("SOURCE_IDENTITY_REQUIRED", { segmentId: source.segmentId });
      }
      const identity = await inspectExpected(source.filePath, source);
      if (sourceIdentities.has(identity)) throw new SimulationError("DUPLICATE_FILE_IDENTITY");
      sourceIdentities.add(identity);
    }
    result.validations.push("SOURCE_IDENTITIES");

    stage = "WORKSPACE_CREATION_FAILED";
    workspace = await createWorkspace(temporaryRoot);
    if (!workspace || !inside(temporaryRoot, workspace.root) || typeof workspace.cleanup !== "function") {
      throw new SimulationError("UNSAFE_WORKSPACE");
    }
    const root = await inspect(workspace.root);
    if (root?.kind !== "directory" || root.private !== true || root.isSymbolicLink ||
        root.realPath !== path.resolve(workspace.root) || typeof root.identity !== "string" || !root.identity) {
      throw new SimulationError("UNSAFE_WORKSPACE");
    }
    const outputPath = path.join(workspace.root, "mix.wav");
    const assertOutputAbsent = async () => {
      if (await inspect(outputPath)) throw new SimulationError("TEMP_OUTPUT_EXISTS");
    };
    await assertOutputAbsent();

    stage = "PROTECTED_COPY_FAILED";
    const copies = [];
    const copyIdentities = new Set();
    for (const [index, source] of ordered.entries()) {
      const filePath = path.join(workspace.root, `replica_${index + 1}${path.extname(source.filePath).toLowerCase()}`);
      if (await inspect(filePath)) throw new SimulationError("TEMP_INPUT_EXISTS");
      await copyProtected(source.filePath, filePath);
      await inspectExpected(source.filePath, source);
      const copy = { ...source, filePath, identity: undefined };
      copy.identity = await inspectExpected(filePath, copy, true);
      if (sourceIdentities.has(copy.identity) || copyIdentities.has(copy.identity)) {
        throw new SimulationError("COPY_NOT_INDEPENDENT", { segmentId: source.segmentId });
      }
      copyIdentities.add(copy.identity);
      copies.push(copy);
    }
    result.validations.push("PROTECTED_COPIES");

    stage = "COPY_REVALIDATION_FAILED";
    for (const [index, copy] of copies.entries()) {
      copy.durationSeconds = await measureDurationSeconds(copy.filePath);
      if (copy.durationSeconds !== current.inputs[index].durationSeconds) {
        throw new SimulationError("COPY_DURATION_CHANGED", { segmentId: copy.segmentId });
      }
    }
    const copyInput = { ...input, mode: "simulation", files: copies, outputPath };
    const report = preflightAudioReplicas(copyInput);
    const mixPlan = buildAudioReplicaMixPlan({ ...copyInput, report });
    const rebuilt = buildAudioReplicaFfmpegSpec({ ...copyInput, report, mixPlan });
    if (rebuilt.status !== "OK") {
      throw new SimulationError(stage, { validationErrors: rebuilt.errors });
    }
    for (const copy of copies) await inspectExpected(copy.filePath, copy, true);
    const currentRoot = await inspect(workspace.root);
    if (!isDeepStrictEqual(root, currentRoot)) throw new SimulationError("WORKSPACE_CHANGED");
    await assertOutputAbsent();
    result.validations.push("COPY_DURATIONS_AND_SPECIFICATION");

    stage = "SIMULATED_LAUNCH_FAILED";
    const controller = new AbortController();
    let timer;
    result.launch = { attempted: true, executable: rebuilt.executable, args: rebuilt.args,
      shell: false, timeoutMs, totalDurationSeconds: rebuilt.totalDurationSeconds,
      delaysMs: rebuilt.inputs.map(entry => entry.delayMs) };
    try {
      const response = await Promise.race([
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new SimulationError("SIMULATED_TIMEOUT"));
          }, timeoutMs);
        }),
        Promise.resolve().then(() => launchSimulation({
          ...result.launch, args: [...rebuilt.args], mode: "simulation", signal: controller.signal,
        })),
      ]);
      if (response?.timedOut === true) throw new SimulationError("SIMULATED_TIMEOUT");
      if (!Number.isInteger(response?.exitCode)) throw new SimulationError("INVALID_SIMULATED_EXIT");
      result.launch.exitCode = response.exitCode;
      if (response.exitCode !== 0) throw new SimulationError("SIMULATED_NONZERO_EXIT");
      result.status = "SIMULÉ";
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    result.errors.push(error instanceof SimulationError ? { code: error.message, ...error.details } : { code: stage });
  } finally {
    if (typeof workspace?.cleanup === "function") {
      try {
        await workspace.cleanup();
        result.cleanup = "TERMINÉ";
      } catch {
        result.cleanup = "ÉCHEC";
        result.status = "BLOQUÉ";
        result.errors.push({ code: "WORKSPACE_CLEANUP_FAILED" });
      }
    }
  }
  return result;
}

module.exports = { simulateAudioReplicaExecution };

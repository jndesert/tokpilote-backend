"use strict";

const { createHash } = require("node:crypto");
const path = require("node:path");
const { createAudioReplicaDurationProbe } = require("./audio-replica-ffprobe");
const { createAudioReplicaFsAdapter } = require("./audio-replica-fs-adapter");
const { createWindowsPrivateDirectoryVerifier } = require("./audio-replica-windows-acl");
const { preflightAudioReplicas } = require("./audio-replica-preflight");
const { buildAudioReplicaMixPlan } = require("./audio-replica-mix-plan");
const { buildAudioReplicaFfmpegSpec } = require("./audio-replica-ffmpeg-spec");

function createAudioMeasurementSourceReport({ audioGenerationPlan, scenes, files, expectedDurationSeconds }) {
  return { fingerprint: createHash("sha256").update(JSON.stringify([
    "audio-measurement-source-v1", audioGenerationPlan, scenes, files, expectedDurationSeconds,
  ])).digest("hex") };
}

// Only the measurement can be real. The final launcher is an injected test double.
async function measureProtectedAudioReplicas(input, { simulateProbe, launchSimulation } = {}) {
  const result = {
    status: "BLOQUÉ", measurementMode: input?.mode, executed: false, outputVerified: false,
    measurements: [], errors: [], launch: { attempted: false }, cleanup: "NON_NÉCESSAIRE",
  };
  let workspace;
  let segmentId;

  function reject(code, details) {
    throw Object.assign(new Error(code), { code, details });
  }

  try {
    const request = structuredClone(input);
    const { audioGenerationPlan, scenes, files, expectedDurationSeconds, sourceReport,
      sourceRoot, temporaryRoot, trustedRoot, ffprobePath, mode } = request;
    if (!["real", "simulation"].includes(mode) || typeof launchSimulation !== "function" ||
        (process.platform === "win32" && typeof trustedRoot !== "string") ||
        !Array.isArray(audioGenerationPlan) || !audioGenerationPlan.length || !Array.isArray(files) ||
        files.length !== audioGenerationPlan.length) reject("INVALID_MEASUREMENT_INPUT");
    if (sourceReport?.fingerprint !== createAudioMeasurementSourceReport(request).fingerprint) {
      reject("STALE_MEASUREMENT_SOURCE_REPORT");
    }
    const sources = new Map(files.map(file => [file?.segmentId, file]));
    const planIds = new Set(audioGenerationPlan.map(entry => entry?.segmentId));
    if (sources.size !== files.length || planIds.size !== audioGenerationPlan.length ||
        [...planIds].some(id => typeof id !== "string" || !id || !sources.has(id))) {
      reject("INVALID_MEASUREMENT_INVENTORY");
    }

    const filesystem = await createAudioReplicaFsAdapter({
      sourceRoot, temporaryRoot,
      verifyWindowsPrivateDirectory: process.platform === "win32"
        ? createWindowsPrivateDirectoryVerifier({ trustedRoot })
        : undefined,
    });
    workspace = await filesystem.createWorkspace();
    const rootBefore = await filesystem.inspect(workspace.root);
    const probe = createAudioReplicaDurationProbe({
      ffprobePath, protectedRoot: workspace.root, inspect: filesystem.inspect, mode, simulateProbe,
    });
    const measuredFiles = [];
    for (const [index, segment] of audioGenerationPlan.entries()) {
      segmentId = segment.segmentId;
      const source = sources.get(segmentId);
      if (typeof source.identity !== "string" || !source.identity ||
          typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256)) {
        reject("SOURCE_IDENTITY_REQUIRED");
      }
      const extension = path.extname(source.filePath).toLowerCase();
      if (![".wav", ".mp3", ".m4a"].includes(extension)) reject("INVALID_PROBE_INPUT");
      const filePath = path.join(workspace.root, `replica_${index + 1}${extension}`);
      const { identity, sha256 } = await filesystem.copyProtected(source.filePath, filePath, source);
      const measurement = await probe({ filePath, identity, sha256 });
      // Only the stream result feeds the existing synchronous APIs.
      measuredFiles.push({ ...source, filePath, identity, sha256, durationSeconds: measurement.streamDurationSeconds });
      result.measurements.push({ segmentId, filePath, identity, sha256, ...measurement });
    }
    segmentId = undefined;

    const durations = new Map(measuredFiles.map(file => [file.filePath, file.durationSeconds]));
    const context = {
      audioGenerationPlan, scenes, files: measuredFiles, expectedDurationSeconds, mode,
      measureDurationSeconds: filePath => durations.get(filePath),
      outputPath: path.join(workspace.root, "mix.wav"),
    };
    const report = preflightAudioReplicas(context);
    if (report.status !== "OK") reject("MEASURED_PREFLIGHT_BLOCKED", report.errors);
    const mixPlan = buildAudioReplicaMixPlan({ ...context, report });
    const specification = buildAudioReplicaFfmpegSpec({ ...context, report, mixPlan });
    if (specification.status !== "OK") reject("MEASURED_SPECIFICATION_BLOCKED", specification.errors);
    const inputArgs = specification.args.flatMap((arg, index) => arg === "-i" ? [specification.args[index + 1]] : []);
    if (inputArgs.length !== durations.size ||
        new Set(inputArgs).size !== durations.size || inputArgs.some(filePath => !durations.has(filePath))) {
      reject("UNEXPECTED_MIX_INPUTS");
    }
    for (const file of measuredFiles) {
      segmentId = file.segmentId;
      const current = await filesystem.inspect(file.filePath);
      if (!current || current.protected !== true || current.identity !== file.identity || current.sha256 !== file.sha256) {
        reject("MEASURED_COPY_CHANGED");
      }
    }
    segmentId = undefined;
    const rootAfter = await filesystem.inspect(workspace.root);
    if (rootAfter.identity !== rootBefore.identity || await filesystem.inspect(context.outputPath)) {
      reject("MIX_WORKSPACE_CHANGED");
    }
    result.report = report;
    result.mixPlan = mixPlan;
    result.specification = specification;
    result.launch.attempted = true;
    const response = await launchSimulation({ ...structuredClone(specification), launchMode: "simulation" });
    if (response?.exitCode !== 0) reject("SIMULATED_LAUNCH_FAILED");
    result.launch.exitCode = 0;
    result.status = "SIMULÉ";
  } catch (error) {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code : result.launch.attempted ? "SIMULATED_LAUNCH_FAILED" : "AUDIO_MEASUREMENT_BRIDGE_FAILED";
    result.errors.push({ code, ...(segmentId ? { segmentId } : {}), ...(error?.details ? { details: error.details } : {}) });
  } finally {
    if (workspace) {
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

module.exports = { createAudioMeasurementSourceReport, measureProtectedAudioReplicas };

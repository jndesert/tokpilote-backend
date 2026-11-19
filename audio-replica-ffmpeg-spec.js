"use strict";

const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { buildAudioReplicaMixPlan } = require("./audio-replica-mix-plan");

const inputFormats = new Map([[".mp3", "mp3"], [".wav", "wav"], [".m4a", "mov"]]);

function isLocalAbsolutePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) ||
      /^[\\/]{2}/.test(value) || /[\x00-\x1f\x7f]/.test(value)) return false;
  if (process.platform === "win32") {
    return /^[a-z]:[\\/]/i.test(value) && !/[:*?"<>|]/.test(value.slice(2));
  }
  return true;
}

function blocked(code, details = []) {
  return { status: "BLOQUÉ", errors: [{ code }, ...details], executed: false };
}

function buildAudioReplicaFfmpegSpec({
  mixPlan, report, audioGenerationPlan, files, scenes, expectedDurationSeconds,
  mode = "real", measureDurationSeconds, outputPath,
} = {}) {
  if (mixPlan?.status !== "OK") return blocked("MIX_PLAN_NOT_OK");
  if (!isLocalAbsolutePath(outputPath) || path.extname(outputPath).toLowerCase() !== ".wav") {
    return blocked("INVALID_OUTPUT_PATH");
  }
  if (!Array.isArray(files)) return blocked("INVALID_INPUT_INVENTORY");
  for (const file of files) {
    if (!isLocalAbsolutePath(file?.filePath) || !inputFormats.has(path.extname(file.filePath).toLowerCase())) {
      return blocked("INVALID_INPUT_PATH", [{ segmentId: file?.segmentId }]);
    }
  }

  const current = buildAudioReplicaMixPlan({
    report, audioGenerationPlan, files, scenes, expectedDurationSeconds, mode, measureDurationSeconds,
  });
  if (current.status !== "OK") return blocked("MIX_PLAN_REVALIDATION_FAILED", current.errors);
  if (!isDeepStrictEqual(mixPlan, current)) return blocked("STALE_OR_INCONSISTENT_MIX_PLAN");

  const pathKey = value => process.platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value);
  const inputs = current.replicas.map((replica, index) => ({
    index,
    segmentId: replica.segmentId,
    filePath: replica.filePath,
    startSeconds: replica.startSeconds,
    delayMs: replica.delayMs,
    durationSeconds: replica.durationSeconds,
    actualEndSeconds: replica.actualEndSeconds,
  }));
  if (inputs.some(input => pathKey(input.filePath) === pathKey(outputPath))) {
    return blocked("OUTPUT_COLLIDES_WITH_INPUT");
  }
  if (new Set(inputs.map(input => pathKey(input.filePath))).size !== inputs.length) {
    return blocked("DUPLICATE_INPUT_PATH");
  }

  const args = ["-hide_banner", "-nostdin", "-n"];
  for (const input of inputs) {
    const format = inputFormats.get(path.extname(input.filePath).toLowerCase());
    args.push("-protocol_whitelist", "file", "-f", format, "-i", input.filePath);
  }
  args.push("-filter_complex", current.filtergraph, "-map", current.outputLabel,
    "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", "-f", "wav", outputPath);

  return {
    status: "OK",
    mode,
    fingerprint: current.fingerprint,
    executable: "ffmpeg",
    shell: false,
    args,
    inputs,
    filtergraph: current.filtergraph,
    gaps: current.gaps,
    outputPath,
    totalDurationSeconds: current.totalDurationSeconds,
    requiresRealRevalidation: true,
    executed: false,
  };
}

// A future executor must call this on its protected inputs immediately before use.
// The real preflight probes current durations and verifies identities before and after probing.
function revalidateAudioReplicaFfmpegSpec(specification, currentInput) {
  if (specification?.status !== "OK" || specification.mode !== "real" || currentInput?.mode !== "real") {
    return blocked("REAL_SPECIFICATION_REQUIRED");
  }
  const current = buildAudioReplicaFfmpegSpec(currentInput);
  if (current.status !== "OK") return current;
  return isDeepStrictEqual(specification, current) ? current : blocked("STALE_OR_INCONSISTENT_FFMPEG_SPEC");
}

module.exports = { buildAudioReplicaFfmpegSpec, revalidateAudioReplicaFfmpegSpec };

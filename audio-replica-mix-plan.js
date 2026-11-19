"use strict";

const { isDeepStrictEqual } = require("node:util");
const { preflightAudioReplicas } = require("./audio-replica-preflight");

function buildAudioReplicaMixPlan({
  report, audioGenerationPlan, files, scenes, expectedDurationSeconds, mode = "real", measureDurationSeconds,
} = {}) {
  const blocked = (code, details = []) => ({ status: "BLOQUÉ", mode, errors: [{ code }, ...details] });
  if (report?.status !== "OK") return blocked("PREFLIGHT_NOT_OK");
  if (report.mode !== mode || typeof report.fingerprint !== "string") return blocked("UNBOUND_PREFLIGHT_REPORT");

  const current = preflightAudioReplicas({
    audioGenerationPlan, files, scenes, expectedDurationSeconds, mode, measureDurationSeconds,
  });
  if (current.status !== "OK") return blocked("CURRENT_PREFLIGHT_BLOCKED", current.errors);
  if (!isDeepStrictEqual(report, current)) return blocked("STALE_OR_INCONSISTENT_PREFLIGHT");

  const inventory = new Map(files.map(file => [file.segmentId, file]));
  const replicas = [];
  const filters = [];
  for (const [index, segment] of current.segments.entries()) {
    const delayMs = Math.round(segment.startSeconds * 1000);
    if (!Number.isSafeInteger(delayMs) || Math.abs(delayMs / 1000 - segment.startSeconds) > 1e-9) {
      return blocked("UNREPRESENTABLE_ABSOLUTE_DELAY", [{ segmentId: segment.segmentId }]);
    }
    const outputLabel = `a${index}`;
    replicas.push({
      ...segment,
      voice: inventory.get(segment.segmentId).voice,
      delayMs,
    });
    filters.push(`[${index}:a]aresample=44100,adelay=${delayMs}:all=1[${outputLabel}]`);
  }

  const duration = current.timelineDurationSeconds;
  const labels = replicas.map((_, index) => `[a${index}]`).join("");
  filters.push(`${labels}amix=inputs=${replicas.length}:duration=longest:normalize=0,atrim=duration=${duration},apad=whole_dur=${duration}[out]`);
  return {
    status: "OK",
    mode,
    fingerprint: current.fingerprint,
    totalDurationSeconds: duration,
    replicas,
    gaps: current.gaps,
    filtergraph: filters.join(";"),
    outputLabel: "[out]",
    executed: false,
  };
}

module.exports = { buildAudioReplicaMixPlan };

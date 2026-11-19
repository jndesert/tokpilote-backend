"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { getVoiceMapping } = require("./voice-mapping");

const EPSILON = 1e-9;
const validTime = value => Number.isFinite(value) && value >= 0;
const validId = value => typeof value === "string" && value.trim().length > 0;
const fileIdentity = stats => [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");

// The caller supplies the real duration probe. Simulation never touches the filesystem.
function preflightAudioReplicas({
  audioGenerationPlan, scenes, files, expectedDurationSeconds, mode = "real", measureDurationSeconds,
} = {}) {
  const errors = [];
  const segments = [];
  const gaps = [];
  const addError = (code, context = {}) => errors.push({ code, ...context });
  const report = { status: "BLOQUÉ", mode, expectedDurationSeconds, timelineDurationSeconds: null, errors, segments, gaps };

  if (!["real", "simulation"].includes(mode) || !Array.isArray(files) ||
      !Array.isArray(audioGenerationPlan) || !audioGenerationPlan.length ||
      !Array.isArray(scenes) || !scenes.length || !validTime(expectedDurationSeconds) ||
      expectedDurationSeconds === 0) {
    addError("INVALID_PREFLIGHT_INPUT");
    return report;
  }
  if (mode === "real" && typeof measureDurationSeconds !== "function") {
    addError("DURATION_PROBE_REQUIRED");
    return report;
  }

  const sceneByNumber = new Map();
  let previousEnd = 0;
  for (const scene of scenes) {
    if (!Number.isSafeInteger(scene?.sceneNumber) || scene.sceneNumber <= 0 ||
        !validTime(scene.startSeconds) || !validTime(scene.endSeconds) ||
        scene.endSeconds <= scene.startSeconds || sceneByNumber.has(scene.sceneNumber)) {
      addError("INVALID_SCENE", { sceneNumber: scene?.sceneNumber });
      continue;
    }
    if (Math.abs(scene.startSeconds - previousEnd) > EPSILON) {
      addError("DISCONTINUOUS_SCENES", { sceneNumber: scene.sceneNumber, previousEndSeconds: previousEnd });
    }
    sceneByNumber.set(scene.sceneNumber, scene);
    previousEnd = scene.endSeconds;
  }
  report.timelineDurationSeconds = previousEnd;
  if (Math.abs(previousEnd - expectedDurationSeconds) > EPSILON) {
    addError("TOTAL_DURATION_MISMATCH", { actualDurationSeconds: previousEnd });
  }

  const planIds = new Set();
  const planned = new Map();
  for (const segment of audioGenerationPlan) {
    const segmentId = segment?.segmentId;
    if (!validId(segmentId)) {
      addError("INVALID_SEGMENT_ID");
      continue;
    }
    if (planIds.has(segmentId)) {
      addError("DUPLICATE_PLAN_SEGMENT", { segmentId });
      continue;
    }
    planIds.add(segmentId);
    const scene = sceneByNumber.get(segment.sceneNumber);
    if (!scene || !validTime(segment.startSeconds) || !validTime(segment.endSeconds) ||
        segment.endSeconds <= segment.startSeconds) {
      addError("INVALID_SEGMENT_TIMING", { segmentId, sceneNumber: segment.sceneNumber });
      continue;
    }
    if (segment.startSeconds < scene.startSeconds - EPSILON || segment.endSeconds > scene.endSeconds + EPSILON) {
      addError("PLAN_OUTSIDE_SCENE", { segmentId, sceneNumber: segment.sceneNumber });
    }
    planned.set(segmentId, segment);
  }

  const inventory = new Map();
  for (const file of files) {
    const segmentId = file?.segmentId;
    if (!validId(segmentId) || !planIds.has(segmentId)) {
      addError("UNKNOWN_INVENTORY_SEGMENT", { segmentId });
    } else if (inventory.has(segmentId)) {
      addError("DUPLICATE_INVENTORY_SEGMENT", { segmentId });
    } else {
      inventory.set(segmentId, file);
    }
  }

  const usedFiles = new Set();
  const realFiles = new Map();
  for (const [segmentId, segment] of planned) {
    const { sceneNumber, character, voiceId, startSeconds, endSeconds } = segment;
    const context = { segmentId, sceneNumber };
    const position = { ...context, character, voiceId, startSeconds, plannedEndSeconds: endSeconds,
      durationSeconds: null, actualEndSeconds: null };
    segments.push(position);
    const expectedVoice = getVoiceMapping(voiceId)?.voice;
    if (!expectedVoice || !validId(character)) addError("INVALID_PLAN_VOICE", context);
    const file = inventory.get(segmentId);
    if (!file) {
      addError("MISSING_AUDIO_FILE", context);
      continue;
    }
    if (file.character !== character) addError("CHARACTER_MISMATCH", context);
    if (file.voiceId !== voiceId || file.voice !== expectedVoice) {
      addError("VOICE_MISMATCH", { ...context, expectedVoiceId: voiceId, expectedVoice });
    }
    if (!validId(file.filePath)) {
      addError("INVALID_AUDIO_FILE", context);
      continue;
    }

    let fileKey = path.normalize(file.filePath);
    let duration = file.durationSeconds;
    if (mode === "real") {
      try {
        if (!path.isAbsolute(file.filePath) || !/\.(mp3|wav|m4a)$/i.test(file.filePath)) throw new Error();
        const stats = fs.lstatSync(file.filePath, { bigint: true });
        if (!stats.isFile() || stats.size === 0n) throw new Error();
        fileKey = stats.ino ? `${stats.dev}:${stats.ino}` : fs.realpathSync(file.filePath);
        realFiles.set(segmentId, fileIdentity(stats));
      } catch (error) {
        addError(error.code === "ENOENT" ? "MISSING_AUDIO_FILE" : "INVALID_AUDIO_FILE", context);
        continue;
      }
      try {
        duration = measureDurationSeconds(file.filePath);
        if (fileIdentity(fs.lstatSync(file.filePath, { bigint: true })) !== realFiles.get(segmentId)) {
          addError("AUDIO_FILE_CHANGED_DURING_PROBE", context);
          continue;
        }
      } catch {
        addError("DURATION_NOT_MEASURABLE", context);
        continue;
      }
    }
    if (usedFiles.has(fileKey)) addError("AUDIO_FILE_REUSED", context);
    usedFiles.add(fileKey);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(startSeconds + duration)) {
      addError(mode === "real" ? "DURATION_NOT_MEASURABLE" : "INVALID_AUDIO_DURATION", context);
      continue;
    }
    position.filePath = file.filePath;
    position.durationSeconds = duration;
    position.actualEndSeconds = startSeconds + duration;
    if (position.actualEndSeconds > sceneByNumber.get(sceneNumber).endSeconds + EPSILON) {
      addError("AUDIO_OUTSIDE_SCENE", context);
    }
    if (position.actualEndSeconds > endSeconds + EPSILON) addError("AUDIO_EXCEEDS_PLANNED_SLOT", context);
  }

  segments.sort((a, b) => a.startSeconds - b.startSeconds);
  for (let index = 1; index < segments.length; index++) {
    const previous = segments[index - 1];
    const next = segments[index];
    const context = { segmentId: previous.segmentId, nextSegmentId: next.segmentId };
    if (previous.plannedEndSeconds > next.startSeconds + EPSILON) addError("PLAN_OVERLAP", context);
    if (previous.actualEndSeconds === null) continue;
    if (previous.actualEndSeconds > next.startSeconds + EPSILON) {
      addError("AUDIO_OVERLAP", context);
    } else if (next.startSeconds - previous.actualEndSeconds > EPSILON) {
      gaps.push({ ...context, startSeconds: previous.actualEndSeconds, endSeconds: next.startSeconds });
    }
  }
  if (errors.length === 0) {
    try {
      // Bind the complete plan (including text and voice metadata) and the inventory to the measurements.
      report.fingerprint = createHash("sha256").update(JSON.stringify([
        "audio-preflight-v1", mode, expectedDurationSeconds, scenes, audioGenerationPlan,
        [...inventory.values()].sort((a, b) => a.segmentId < b.segmentId ? -1 : a.segmentId > b.segmentId ? 1 : 0),
        segments.map(segment => [segment.segmentId, segment.durationSeconds, realFiles.get(segment.segmentId)]),
      ])).digest("hex");
      report.status = "OK";
    } catch {
      addError("UNSERIALIZABLE_PREFLIGHT_INPUT");
    }
  }
  return report;
}

module.exports = { preflightAudioReplicas };

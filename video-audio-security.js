"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([
  ".wav",
  ".mp3",
  ".m4a"
]);

function validateAudioFile({
  audioDirectory,
  audioFileName
} = {}) {
  if (
    typeof audioDirectory !== "string" ||
    !path.isAbsolute(audioDirectory)
  ) {
    throw new Error("INVALID_AUDIO_DIRECTORY");
  }

  if (
    typeof audioFileName !== "string" ||
    !/^[a-zA-Z0-9_-]+\.(wav|mp3|m4a)$/i.test(audioFileName)
  ) {
    throw new Error("INVALID_AUDIO_FILENAME");
  }

  const extension = path.extname(audioFileName).toLowerCase();

  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error("UNSUPPORTED_AUDIO_FORMAT");
  }

  const root = fs.realpathSync(audioDirectory);

  if (!fs.statSync(root).isDirectory()) {
    throw new Error("INVALID_AUDIO_DIRECTORY");
  }

  const candidate = path.join(root, audioFileName);
  const fileInfo = fs.lstatSync(candidate);

  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
    throw new Error("INVALID_AUDIO_FILE");
  }

  const resolved = fs.realpathSync(candidate);

  if (path.dirname(resolved) !== root) {
    throw new Error("AUDIO_PATH_OUTSIDE_DIRECTORY");
  }

  const stats = fs.statSync(resolved);

  if (
    stats.size <= 0 ||
    stats.size > MAX_AUDIO_BYTES
  ) {
    throw new Error("INVALID_AUDIO_SIZE");
  }

  let probe;

  try {
    const output = execFileSync("ffprobe", [
      "-v", "error",
      "-select_streams", "a",
      "-show_entries",
      "stream=codec_type,codec_name",
      "-of", "json",
      resolved
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024
    });

    probe = JSON.parse(output);

  } catch (error) {
    throw new Error("AUDIO_PROBE_FAILED");
  }

  if (
    !Array.isArray(probe.streams) ||
    probe.streams.length === 0 ||
    !probe.streams.some(
      stream =>
        stream.codec_type === "audio" &&
        typeof stream.codec_name === "string"
    )
  ) {
    throw new Error("AUDIO_STREAM_NOT_FOUND");
  }

  try {
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-v", "error",
      "-xerror",
      "-i", resolved,
      "-map", "0:a:0",
      "-vn",
      "-f", "null",
      "-"
    ], {
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });

  } catch (error) {
    throw new Error("AUDIO_DECODE_FAILED");
  }

  return {
    audioPath: resolved,
    sizeBytes: stats.size,
    extension
  };
}

module.exports = {
  validateAudioFile,
  MAX_AUDIO_BYTES
};
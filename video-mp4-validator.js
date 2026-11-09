"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 10000;
const PROBE_MAX_BUFFER = 1024 * 1024;
const MAX_WIDTH = 4096;
const MAX_HEIGHT = 4096;
const MAX_PIXELS = 16000000;
const MAX_DURATION_SECONDS = 600;
const MAX_CONCURRENT_MP4_VALIDATIONS = 2;
let activeMp4Validations = 0;

async function validateMp4ForStorage(body) {
  if (activeMp4Validations >= MAX_CONCURRENT_MP4_VALIDATIONS) {
    throw new Error("MEDIA_STORAGE_VIDEO_BUSY");
  }
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new Error("MEDIA_STORAGE_INVALID_VIDEO");
  }
  activeMp4Validations++;

  let directory;
  let validationError = null;

  try {
  try {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "videapilot-mp4-")
    );

    const file = path.join(directory, "video.mp4");

    await fs.writeFile(file, body, {
      flag: "wx",
      mode: 0o600
    });

    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries",
      "stream=codec_type,codec_name,width,height:format=duration",
      "-of", "json",
      file
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BUFFER
    });

    const result = JSON.parse(stdout);

    const stream = Array.isArray(result.streams)
      ? result.streams[0]
      : null;

    const duration = Number(result.format?.duration);

    if (
      !stream ||
      stream.codec_type !== "video" ||
      typeof stream.codec_name !== "string" ||
      stream.codec_name.length === 0 ||
      !Number.isSafeInteger(stream.width) ||
      !Number.isSafeInteger(stream.height) ||
      stream.width <= 0 ||
      stream.height <= 0 ||
      stream.width > MAX_WIDTH ||
      stream.height > MAX_HEIGHT ||
      stream.width * stream.height > MAX_PIXELS ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > MAX_DURATION_SECONDS
    ) {
      throw new Error("MEDIA_STORAGE_INVALID_VIDEO");
    }

    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-loglevel", "error",
      "-xerror",
      "-i", file,
      "-map", "0:v:0",
      "-an",
      "-f", "null",
      "-"
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });
  } catch (error) {
    validationError = new Error("MEDIA_STORAGE_INVALID_VIDEO");
  } finally {
    if (directory) {
      try {
        await fs.rm(directory, {
          recursive: true,
          force: true
        });
      } catch (error) {
        validationError = new Error(
          "MEDIA_STORAGE_TEMP_CLEANUP_FAILED"
        );
      }
    }
  }

  if (validationError) {
    throw validationError;
  }

  } finally {
    activeMp4Validations--;
  }
  return true;
}

module.exports = {
  validateMp4ForStorage
};
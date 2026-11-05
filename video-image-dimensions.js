"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const MAX_WIDTH = 4096;
const MAX_HEIGHT = 4096;
const MAX_PIXELS = 16000000;
const PROBE_TIMEOUT_MS = 10000;

async function validateImageDimensions(
  filePath,
  options = {}
) {
  if (
    typeof filePath !== "string" ||
    filePath.trim().length === 0
  ) {
    throw new Error("INVALID_IMAGE_PATH");
  }

  const ffprobePath = options.ffprobePath ?? "ffprobe";

  if (
    typeof ffprobePath !== "string" ||
    ffprobePath.trim().length === 0
  ) {
    throw new Error("INVALID_FFPROBE_PATH");
  }

  let output;

  try {
    const result = await execFileAsync(
      ffprobePath,
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries",
        "stream=width,height",
        "-of", "json",
        filePath
      ],
      {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true
      }
    );

    output = JSON.parse(result.stdout);

  } catch {
    throw new Error("IMAGE_DIMENSIONS_PROBE_FAILED");
  }

  const stream = output?.streams?.[0];

  const width = stream?.width;
  const height = stream?.height;

  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error("INVALID_IMAGE_DIMENSIONS");
  }

  if (
    width > MAX_WIDTH ||
    height > MAX_HEIGHT ||
    width * height > MAX_PIXELS
  ) {
    throw new Error("IMAGE_DIMENSIONS_LIMIT_EXCEEDED");
  }

  return {
    valid: true,
    width,
    height,
    pixels: width * height
  };
}

module.exports = {
  validateImageDimensions
};

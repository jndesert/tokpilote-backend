"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const {
  validateImageSignature
} = require("./video-image-signature");

const execFileAsync = promisify(execFile);

const DECODE_TIMEOUT_MS = 15000;

async function validateImageDecoding(
  filePath,
  expectedMime,
  options = {}
) {
  // Premiere protection : signature du fichier.
  validateImageSignature(filePath, expectedMime);

  const ffmpegPath = options.ffmpegPath || "ffmpeg";

  if (
    typeof ffmpegPath !== "string" ||
    ffmpegPath.trim().length === 0
  ) {
    throw new Error("INVALID_FFMPEG_PATH");
  }

  try {
    await execFileAsync(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel", "error",
        "-xerror",
        "-i", filePath,
        "-frames:v", "1",
        "-f", "null",
        "-"
      ],
      {
        timeout: DECODE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true
      }
    );

  } catch (error) {
    // Ne pas exposer les chemins locaux ni les messages FFmpeg.
    throw new Error("IMAGE_DECODING_FAILED");
  }

  return {
    valid: true,
    mimeType: expectedMime
  };
}

module.exports = {
  validateImageDecoding
};

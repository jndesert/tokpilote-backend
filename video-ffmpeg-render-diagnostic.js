"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 10000;
const MAX_BUFFER = 1024 * 1024;

async function checkExecutable(name) {
  try {
    await execFileAsync(
      name,
      ["-version"],
      {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true
      }
    );

    return {
      name,
      available: true
    };
  } catch {
    return {
      name,
      available: false
    };
  }
}

async function main() {
  console.log("=== VIDEAPILOT MEDIA DIAGNOSTIC ===");

  const ffmpeg = await checkExecutable("ffmpeg");
  const ffprobe = await checkExecutable("ffprobe");

  console.log(
    "FFMPEG :",
    ffmpeg.available ? "DISPONIBLE" : "INDISPONIBLE"
  );

  console.log(
    "FFPROBE :",
    ffprobe.available ? "DISPONIBLE" : "INDISPONIBLE"
  );

  const success = ffmpeg.available && ffprobe.available;

  console.log(
    "RESULTAT :",
    success ? "OK" : "ECHEC"
  );

  if (!success) {
    process.exitCode = 1;
  }
}

main().catch(() => {
  console.error("RESULTAT : ECHEC");
  process.exitCode = 1;
});
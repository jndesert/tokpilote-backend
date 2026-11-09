"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 20000;
const MAX_BUFFER = 1024 * 1024;

async function runMp4Test() {
  let tempDirectory = null;

  const result = {
    status: "pending",
    mp4Created: false,
    mp4Valid: false,
    codec: null,
    duration: null,
    width: null,
    height: null,
    sizeBytes: null
  };

  try {
    tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "videapilot-mp4-")
    );

    const outputFile = path.join(
      tempDirectory,
      "diagnostic.mp4"
    );

    await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-y",
        "-f", "lavfi",
        "-i", "color=c=black:s=320x240:r=25:d=2",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        outputFile
      ],
      {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true
      }
    );

    const stat = await fs.stat(outputFile);

    result.mp4Created = stat.size > 0;
    result.sizeBytes = stat.size;

    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries",
        "stream=codec_name,width,height:format=duration",
        "-of", "json",
        outputFile
      ],
      {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true
      }
    );

    const probe = JSON.parse(stdout);
    const stream = probe.streams?.[0];

    result.codec = stream?.codec_name ?? null;
    result.width = stream?.width ?? null;
    result.height = stream?.height ?? null;
    result.duration = Number(probe.format?.duration);

    result.mp4Valid =
      result.mp4Created &&
      result.codec === "h264" &&
      result.width === 320 &&
      result.height === 240 &&
      Number.isFinite(result.duration) &&
      result.duration >= 1.9 &&
      result.duration <= 2.1;

    result.status = result.mp4Valid
      ? "success"
      : "failed";
  } catch (error) {
    result.status = "error";
    result.error = error.message;
  } finally {
    if (tempDirectory) {
      await fs.rm(tempDirectory, {
        recursive: true,
        force: true
      });
    }
  }

  return result;
}

module.exports = { runMp4Test };

if (require.main === module) {
  runMp4Test()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "success") {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
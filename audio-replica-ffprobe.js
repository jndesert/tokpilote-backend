"use strict";

const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const exec = promisify(execFile);
const windows = process.platform === "win32";
const formats = new Map([[".wav", "wav"], [".mp3", "mp3"], [".m4a", "mov"]]);

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function localPath(value) {
  return typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value &&
    !/^[\\/]{2}|[\x00-\x1f\x7f]/.test(value) &&
    (!windows || (/^[a-z]:\\/i.test(value) && !/[:*?"<>|]/.test(value.slice(2))));
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function positiveDuration(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value))) {
    fail("INVALID_PROBE_DURATION");
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) fail("INVALID_PROBE_DURATION");
  return seconds;
}

function parseAudioProbe(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    fail("INVALID_PROBE_JSON");
  }
  if (!Array.isArray(data?.streams) || data.streams.length !== 1 ||
      data.streams[0]?.codec_type !== "audio" || typeof data.streams[0].codec_name !== "string" ||
      !/^[a-z0-9_]+$/i.test(data.streams[0].codec_name)) {
    fail("EXPECTED_SINGLE_AUDIO_STREAM");
  }
  const { codec_name: codec, duration } = data.streams[0];
  const streamDurationSeconds = positiveDuration(duration);
  const container = data.format?.duration;
  const containerDurationSeconds = container === undefined || container === "N/A"
    ? null : positiveDuration(container);
  const toleranceSeconds = codec.startsWith("pcm_") ? 0.002 : 0.080;
  if (containerDurationSeconds !== null &&
      Math.abs(streamDurationSeconds - containerDurationSeconds) > toleranceSeconds + 1e-9) {
    fail("INCONSISTENT_PROBE_DURATIONS");
  }
  return { codec, streamDurationSeconds, containerDurationSeconds, toleranceSeconds,
    ffprobeVersion: typeof data.program_version?.version === "string" ? data.program_version.version : null };
}

async function executableIdentity(executable) {
  try {
    const stat = await fs.lstat(executable, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.ino || await fs.realpath(executable) !== executable) {
      fail("UNSAFE_FFPROBE_EXECUTABLE");
    }
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch (error) {
    if (error.code === "UNSAFE_FFPROBE_EXECUTABLE") throw error;
    fail("FFPROBE_UNAVAILABLE");
  }
}

// inspect is the trusted protected-copy inspector. There is no PATH lookup.
function createAudioReplicaDurationProbe({
  ffprobePath, protectedRoot, inspect, mode = "real", simulateProbe, timeoutMs = 5000,
} = {}) {
  if (!localPath(ffprobePath) || path.basename(ffprobePath).toLowerCase() !== (windows ? "ffprobe.exe" : "ffprobe") ||
      !localPath(protectedRoot) || typeof inspect !== "function" ||
      !["real", "simulation"].includes(mode) ||
      (mode === "simulation" ? typeof simulateProbe !== "function" : simulateProbe !== undefined) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    fail("INVALID_PROBE_CONFIGURATION");
  }
  const maxBuffer = 64 * 1024;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === "FFREPORT") delete env[key];

  async function verifyFile(filePath, identity, sha256) {
    const info = await inspect(filePath);
    if (!info) fail("PROBE_FILE_MISSING");
    if (info.kind !== "file" || info.protected !== true || info.isSymbolicLink !== false ||
        info.realPath !== filePath || !Buffer.isBuffer(info.bytes) || info.bytes.length === 0) {
      fail("UNPROTECTED_PROBE_FILE");
    }
    if (info.identity !== identity) fail("PROBE_FILE_REPLACED");
    if (createHash("sha256").update(info.bytes).digest("hex") !== sha256) fail("PROBE_FINGERPRINT_MISMATCH");
  }

  return async ({ filePath, identity, sha256 } = {}) => {
    const format = typeof filePath === "string" && formats.get(path.extname(filePath).toLowerCase());
    if (!localPath(filePath) || !inside(protectedRoot, filePath) || !format ||
        typeof identity !== "string" || !identity || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
      fail("INVALID_PROBE_INPUT");
    }
    const executableBefore = mode === "real" ? await executableIdentity(ffprobePath) : null;
    await verifyFile(filePath, identity, sha256);
    const args = ["-v", "error", "-protocol_whitelist", "file", "-f", format];
    if (format === "mov") args.push("-enable_drefs", "0");
    args.push("-show_program_version", "-show_entries", "stream=codec_type,codec_name,duration:format=duration:program_version=version",
      "-of", "json", "-i", filePath);
    let stdout;
    try {
      ({ stdout } = await (mode === "real" ? exec : simulateProbe)(ffprobePath, args,
        { shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer, encoding: "utf8", env }));
    } catch (error) {
      if (error?.killed === true || error?.code === "ETIMEDOUT") fail("FFPROBE_TIMEOUT");
      if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") fail("FFPROBE_OUTPUT_TOO_LARGE");
      fail("FFPROBE_FAILED");
    } finally {
      await verifyFile(filePath, identity, sha256);
      if (mode === "real" && await executableIdentity(ffprobePath) !== executableBefore) fail("FFPROBE_EXECUTABLE_CHANGED");
    }
    if (typeof stdout !== "string") fail("INVALID_PROBE_JSON");
    if (Buffer.byteLength(stdout) > maxBuffer) fail("FFPROBE_OUTPUT_TOO_LARGE");
    return { mode, ...parseAudioProbe(stdout) };
  };
}

module.exports = { createAudioReplicaDurationProbe, parseAudioProbe };

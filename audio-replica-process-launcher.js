"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { revalidateAudioReplicaFfmpegSpec } = require("./audio-replica-ffmpeg-spec");

const windows = process.platform === "win32";
const boundedInteger = (value, limit) => Number.isInteger(value) && value > 0 && value <= limit;
const absoluteLocal = value => typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value &&
  !/^[\\/]{2}|[\x00-\x1f\x7f]/.test(value) &&
  (!windows || (/^[a-z]:\\/i.test(value) && !/[:*?"<>|]/.test(value.slice(2))));

async function binaryIdentity(executable) {
  const stat = await fs.lstat(executable, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.ino || !stat.size ||
      await fs.realpath(executable) !== executable) throw new Error("Invalid binary");
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

// The trusted supervisor must contain the whole process tree before starting it.
// completion must attest tree termination, not merely the direct child's exit.
// This module neither provides an OS supervisor nor owns workspace cleanup.
function createAudioReplicaProcessLauncher({
  ffmpegPath, supervisor, timeoutMs = 30000, stopGraceMs = 5000, maxOutputBytes = 65536,
} = {}) {
  const allowedPath = absoluteLocal(ffmpegPath) &&
    path.basename(ffmpegPath).toLowerCase() === (windows ? "ffmpeg.exe" : "ffmpeg");
  const limitsValid = boundedInteger(timeoutMs, 120000) && boundedInteger(stopGraceMs, 10000) &&
    boundedInteger(maxOutputBytes, 1024 * 1024);

  return async ({ specification, currentInput, workspaceRoot, inspect, signal } = {}) => {
    const result = { status: "BLOQUÉ", attempted: false, treeTerminated: false, cleanupAllowed: false,
      outputVerified: false, exitCode: null, output: { stdout: "", stderr: "", truncated: false }, errors: [] };
    const error = (code, details) => {
      result.errors.push({ code, ...(details ? { details } : {}) });
      return result;
    };
    if (!allowedPath || !limitsValid) return error("INVALID_LAUNCHER_CONFIGURATION");
    if (supervisor?.treeControl !== true || typeof supervisor.start !== "function") {
      return error("PROCESS_TREE_SUPERVISOR_REQUIRED");
    }
    if (signal?.aborted) return error("PROCESS_INTERRUPTED");
    if (!absoluteLocal(workspaceRoot) || typeof inspect !== "function") return error("UNSAFE_PROCESS_WORKSPACE");

    let checked;
    try {
      const { measureDurationSeconds, ...serializable } = currentInput;
      const input = { ...structuredClone(serializable), measureDurationSeconds };
      const supplied = structuredClone(specification);
      const executableId = await binaryIdentity(ffmpegPath);
      checked = revalidateAudioReplicaFfmpegSpec(supplied, input);
      if (checked.status !== "OK") return error("FFMPEG_SPEC_REVALIDATION_FAILED", checked.errors);

      const workspace = await inspect(workspaceRoot);
      if (workspace?.kind !== "directory" || workspace.private !== true || workspace.isSymbolicLink !== false ||
          workspace.realPath !== workspaceRoot || !workspace.identity ||
          path.dirname(checked.outputPath) !== workspaceRoot || await inspect(checked.outputPath)) {
        return error("UNSAFE_PROCESS_WORKSPACE");
      }
      const files = new Map(input.files.map(file => [file.segmentId, file]));
      for (const entry of checked.inputs) {
        const expected = files.get(entry.segmentId);
        if (path.dirname(entry.filePath) !== workspaceRoot) return error("UNPROTECTED_PROCESS_INPUT");
        const info = await inspect(entry.filePath);
        if (info?.kind !== "file" || info.protected !== true || info.isSymbolicLink !== false ||
            info.realPath !== entry.filePath || !info.identity || info.identity !== expected?.identity ||
            !Buffer.isBuffer(info.bytes) || createHash("sha256").update(info.bytes).digest("hex") !== expected?.sha256) {
          return error("UNPROTECTED_PROCESS_INPUT");
        }
      }
      const workspaceAfter = await inspect(workspaceRoot);
      if (workspaceAfter?.identity !== workspace.identity || workspaceAfter?.private !== true ||
          await inspect(checked.outputPath) || await binaryIdentity(ffmpegPath) !== executableId) {
        return error("PROCESS_IDENTITY_CHANGED");
      }
      checked = revalidateAudioReplicaFfmpegSpec(supplied, input);
      if (checked.status !== "OK") return error("FFMPEG_SPEC_REVALIDATION_FAILED", checked.errors);
    } catch {
      return error("PROCESS_VALIDATION_FAILED");
    }
    if (signal?.aborted) return error("PROCESS_INTERRUPTED");

    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toUpperCase() === "FFREPORT") delete env[key];
    let handle;
    result.attempted = true;
    try {
      handle = supervisor.start(ffmpegPath, [...checked.args], {
        shell: false, windowsHide: true, cwd: workspaceRoot, env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (typeof handle?.requestStop !== "function" || typeof handle.completion?.then !== "function" ||
          typeof handle.stdout?.on !== "function" || typeof handle.stderr?.on !== "function") {
        return error("INVALID_SUPERVISOR_HANDLE");
      }
    } catch {
      return error("PROCESS_START_FAILED");
    }

    let trigger;
    const stop = new Promise(resolve => { trigger = resolve; });
    const buffers = { stdout: [], stderr: [] };
    let buffered = 0;
    const observers = Object.keys(buffers).map(channel => {
      const stream = handle[channel];
      const onData = chunk => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        const capacity = maxOutputBytes - buffered;
        if (capacity > 0) {
          const kept = Buffer.from(bytes.subarray(0, capacity));
          if (kept.length) buffers[channel].push(kept);
          buffered += kept.length;
        }
        if (bytes.length > capacity) {
          result.output.truncated = true;
          trigger("PROCESS_OUTPUT_LIMIT");
        }
      };
      stream.on("data", onData);
      return [stream, onData];
    });
    const interrupted = () => trigger("PROCESS_INTERRUPTED");
    signal?.addEventListener("abort", interrupted, { once: true });
    if (signal?.aborted) interrupted();
    const completion = Promise.resolve(handle.completion).then(
      value => ({ value }), () => ({ value: null })
    );
    const timeout = setTimeout(() => trigger("PROCESS_TIMEOUT"), timeoutMs);
    let grace;
    try {
      let outcome = await Promise.race([completion, stop]);
      clearTimeout(timeout);
      if (typeof outcome === "string") {
        error(outcome);
        // A stop request is not evidence that the tree has exited.
        Promise.resolve().then(() => handle.requestStop()).catch(() => {});
        outcome = await Promise.race([completion, new Promise(resolve => {
          grace = setTimeout(() => resolve({ value: null }), stopGraceMs);
        })]);
      }
      const final = outcome.value;
      result.treeTerminated = final?.treeTerminated === true;
      result.cleanupAllowed = result.treeTerminated;
      if (Number.isInteger(final?.exitCode)) result.exitCode = final.exitCode;
      if (final?.startError === true) error("PROCESS_START_FAILED");
      if (!result.treeTerminated) error("PROCESS_TREE_TERMINATION_UNCONFIRMED");
      if (result.output.truncated && !result.errors.some(item => item.code === "PROCESS_OUTPUT_LIMIT")) {
        error("PROCESS_OUTPUT_LIMIT");
      }
      if (result.errors.length === 0) {
        if (result.exitCode === 0 && !final.signal) result.status = "TERMINÉ";
        else error(final?.signal ? "PROCESS_INTERRUPTED" : "PROCESS_NONZERO_EXIT");
      }
      return result;
    } finally {
      clearTimeout(timeout);
      clearTimeout(grace);
      signal?.removeEventListener("abort", interrupted);
      for (const [stream, listener] of observers) {
        stream.removeListener("data", listener);
        // Streams stay in flowing mode so unconfirmed descendants cannot grow buffers here.
      }
      for (const channel of Object.keys(buffers)) result.output[channel] = Buffer.concat(buffers[channel]).toString("utf8");
    }
  };
}

module.exports = { createAudioReplicaProcessLauncher };

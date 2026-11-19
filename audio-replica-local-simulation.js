"use strict";

const { createAudioReplicaFsAdapter } = require("./audio-replica-fs-adapter");
const { createWindowsPrivateDirectoryVerifier } = require("./audio-replica-windows-acl");
const { simulateAudioReplicaExecution } = require("./audio-replica-executor");

// Composition only: the duration probe and fake launcher remain caller-supplied.
async function simulateLocalAudioReplicas(input, { trustedRoot, measureDurationSeconds, launchSimulation } = {}) {
  const blocked = code => ({
    status: "BLOQUÉ", mode: "simulation", executed: false, outputVerified: false,
    validations: [], launch: { attempted: false }, cleanup: "NON_NÉCESSAIRE", errors: [{ code }],
  });
  if (input?.mode !== "simulation" || typeof measureDurationSeconds !== "function" ||
      typeof launchSimulation !== "function") return blocked("INVALID_LOCAL_SIMULATION_INPUT");
  if (process.platform === "win32" && typeof trustedRoot !== "string") {
    return blocked("WINDOWS_ACL_TRUST_ROOT_REQUIRED");
  }

  let request;
  let filesystem;
  try {
    request = structuredClone(input);
    filesystem = await createAudioReplicaFsAdapter({
      sourceRoot: request.sourceRoot,
      temporaryRoot: request.temporaryRoot,
      verifyWindowsPrivateDirectory: process.platform === "win32"
        ? createWindowsPrivateDirectoryVerifier({ trustedRoot })
        : undefined,
    });
  } catch {
    return blocked("LOCAL_AUDIO_FILESYSTEM_UNAVAILABLE");
  }
  const sources = new Map((Array.isArray(request.files) ? request.files : [])
    .map(file => [file?.filePath, file]));
  return simulateAudioReplicaExecution(request, {
    ...filesystem,
    copyProtected: (source, destination) => filesystem.copyProtected(source, destination, sources.get(source)),
    measureDurationSeconds,
    launchSimulation,
  });
}

module.exports = { simulateLocalAudioReplicas };

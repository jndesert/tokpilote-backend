"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");

const {
  validateAudioFile,
  MAX_AUDIO_BYTES
} = require("./video-audio-security.js");

function inspectAudioSource({
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

  const root = fs.realpathSync(audioDirectory);

  if (!fs.statSync(root).isDirectory()) {
    throw new Error("INVALID_AUDIO_DIRECTORY");
  }

  const candidate = path.join(root, audioFileName);
  const info = fs.lstatSync(candidate);

  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("INVALID_AUDIO_FILE");
  }

  const resolved = fs.realpathSync(candidate);

  if (path.dirname(resolved) !== root) {
    throw new Error("AUDIO_PATH_OUTSIDE_DIRECTORY");
  }

  if (
    info.size <= 0 ||
    info.size > MAX_AUDIO_BYTES
  ) {
    throw new Error("INVALID_AUDIO_SIZE");
  }

  return {
    audioPath: resolved,
    extension: path.extname(audioFileName).toLowerCase(),
    deviceId: info.dev,
    fileId: info.ino
  };
}
function sha256(buffer) {
  return createHash("sha256")
    .update(buffer)
    .digest("hex");
}

function copyAudioFromDescriptor(sourcePath, destinationPath, expectedIdentity) {
  let sourceFd;
  let destinationFd;

  try {
    sourceFd = fs.openSync(sourcePath, "r");

    const before = fs.fstatSync(sourceFd);
    const currentPathInfo = fs.lstatSync(sourcePath);

    if (
      !currentPathInfo.isFile() ||
      currentPathInfo.isSymbolicLink() ||
      before.dev !== currentPathInfo.dev ||
      before.ino !== currentPathInfo.ino ||
      before.dev !== expectedIdentity.deviceId ||
      before.ino !== expectedIdentity.fileId
    ) {
      throw new Error("AUDIO_SOURCE_IDENTITY_CHANGED");
    }

    if (
      !before.isFile() ||
      before.size <= 0 ||
      before.size > MAX_AUDIO_BYTES
    ) {
      throw new Error("INVALID_AUDIO_SIZE");
    }

    const content = Buffer.alloc(before.size);

    let totalRead = 0;

    while (totalRead < content.length) {
      const bytesRead = fs.readSync(
        sourceFd,
        content,
        totalRead,
        content.length - totalRead,
        totalRead
      );

      if (bytesRead === 0) {
        throw new Error("SOURCE_CHANGED_DURING_READ");
      }

      totalRead += bytesRead;
    }

    const after = fs.fstatSync(sourceFd);

    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error("SOURCE_CHANGED_DURING_READ");
    }

    const verificationBuffer = Buffer.alloc(content.length);
    let verificationRead = 0;

    while (verificationRead < verificationBuffer.length) {
      const bytesRead = fs.readSync(
        sourceFd,
        verificationBuffer,
        verificationRead,
        verificationBuffer.length - verificationRead,
        verificationRead
      );

      if (bytesRead === 0) {
        throw new Error("AUDIO_SOURCE_CONTENT_CHANGED");
      }

      verificationRead += bytesRead;
    }

    const verificationStats = fs.fstatSync(sourceFd);

    if (
      verificationStats.size !== before.size ||
      verificationStats.mtimeMs !== before.mtimeMs ||
      sha256(verificationBuffer) !== sha256(content)
    ) {
      throw new Error("AUDIO_SOURCE_CONTENT_CHANGED");
    }

    const expectedHash = sha256(content);

    destinationFd = fs.openSync(
      destinationPath,
      "wx",
      0o600
    );

    let totalWritten = 0;

    while (totalWritten < content.length) {
      const bytesWritten = fs.writeSync(
        destinationFd,
        content,
        totalWritten,
        content.length - totalWritten,
        totalWritten
      );

      if (bytesWritten <= 0) {
        throw new Error("SNAPSHOT_WRITE_FAILED");
      }

      totalWritten += bytesWritten;
    }

    fs.closeSync(destinationFd);
    destinationFd = undefined;

    const actualHash = sha256(
      fs.readFileSync(destinationPath)
    );

    if (actualHash !== expectedHash) {
      throw new Error("AUDIO_SNAPSHOT_INTEGRITY_FAILED");
    }

    return {
      sizeBytes: content.length,
      sha256: actualHash
    };

  } finally {
    if (destinationFd !== undefined) {
      fs.closeSync(destinationFd);
    }

    if (sourceFd !== undefined) {
      fs.closeSync(sourceFd);
    }
  }
}

async function withSecureAudioSnapshot(options, renderTask) {
  if (typeof renderTask !== "function") {
    throw new Error("INVALID_AUDIO_RENDER_TASK");
  }

  const validated = inspectAudioSource(options);

  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "videapilot-audio-snapshot-")
  );

  try {
    const snapshotName = randomUUID() + validated.extension;

    const snapshotPath = path.join(
      temporaryDirectory,
      snapshotName
    );

    copyAudioFromDescriptor(
      validated.audioPath,
      snapshotPath,
      validated
    );

    const snapshot = validateAudioFile({
      audioDirectory: temporaryDirectory,
      audioFileName: snapshotName
    });

    return await renderTask(snapshot.audioPath);

  } finally {
    fs.rmSync(temporaryDirectory, {
      recursive: true,
      force: true
    });
  }
}

module.exports = {
  withSecureAudioSnapshot
};
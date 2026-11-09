"use strict";

const fs = require("node:fs/promises");
const constants = require("node:fs").constants;
const os = require("node:os");
const path = require("node:path");

const {
  validateTempUploadManifest
} = require("./video-upload-temp-identity");

const MANIFEST_FILENAME = "manifest.json";
const MAX_MANIFEST_BYTES = 4096;

function validateDirectory(directory) {
  if (
    typeof directory !== "string" ||
    !path.isAbsolute(directory)
  ) {
    throw new Error("MEDIA_UPLOAD_INVALID_TEMP_DIRECTORY");
  }

  const normalized = path.resolve(directory);
  const root = path.resolve(os.tmpdir());

  if (
    path.dirname(normalized) !== root ||
    !path.basename(normalized).startsWith("videapilot-upload-")
  ) {
    throw new Error("MEDIA_UPLOAD_INVALID_TEMP_DIRECTORY");
  }

  return normalized;
}

async function verifyDirectory(directory) {
  const normalized = validateDirectory(directory);

  const stat = await fs.lstat(normalized);

  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("MEDIA_UPLOAD_UNSAFE_TEMP_DIRECTORY");
  }

  return normalized;
}

async function writeTempUploadManifest(directory, manifest) {
  if (!validateTempUploadManifest(manifest)) {
    throw new Error("MEDIA_UPLOAD_INVALID_MANIFEST");
  }

  const normalized = await verifyDirectory(directory);
  const filePath = path.join(
    normalized,
    MANIFEST_FILENAME
  );

  const content = JSON.stringify(manifest) + "\n";
  const bytes = Buffer.byteLength(content);

  if (bytes > MAX_MANIFEST_BYTES) {
    throw new Error("MEDIA_UPLOAD_MANIFEST_TOO_LARGE");
  }

  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (constants.O_NOFOLLOW || 0);

  const handle = await fs.open(
    filePath,
    flags,
    0o600
  );

  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }

  return filePath;
}

async function readTempUploadManifest(directory) {
  const normalized = await verifyDirectory(directory);

  const filePath = path.join(
    normalized,
    MANIFEST_FILENAME
  );

  const stat = await fs.lstat(filePath);

  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > MAX_MANIFEST_BYTES
  ) {
    throw new Error("MEDIA_UPLOAD_UNSAFE_MANIFEST");
  }

  const flags =
    constants.O_RDONLY |
    (constants.O_NOFOLLOW || 0);

  const handle = await fs.open(filePath, flags);

  let content;

  try {
    const openedStat = await handle.stat();

    if (
      !openedStat.isFile() ||
      openedStat.size > MAX_MANIFEST_BYTES
    ) {
      throw new Error("MEDIA_UPLOAD_UNSAFE_MANIFEST");
    }

    // Comparer le fichier inspecte avec celui
    // effectivement ouvert par le descripteur.
    if (
      openedStat.dev !== stat.dev ||
      openedStat.ino !== stat.ino ||
      openedStat.size !== stat.size
    ) {
      throw new Error("MEDIA_UPLOAD_MANIFEST_CHANGED");
    }

    content = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }

  let manifest;

  try {
    manifest = JSON.parse(content);
  } catch {
    throw new Error("MEDIA_UPLOAD_INVALID_MANIFEST");
  }

  if (!validateTempUploadManifest(manifest)) {
    throw new Error("MEDIA_UPLOAD_INVALID_MANIFEST");
  }

  return Object.freeze(manifest);
}

module.exports = {
  MANIFEST_FILENAME,
  MAX_MANIFEST_BYTES,
  writeTempUploadManifest,
  readTempUploadManifest
};

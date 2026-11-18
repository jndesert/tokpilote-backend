
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const {
  uploadMedia,
  downloadMedia
} = require("./media-storage");

const MAX_MP4_BYTES = 200 * 1024 * 1024;

function validateMp4FileName(fileName) {
  if (
    typeof fileName !== "string" ||
    !/^[a-zA-Z0-9_-]+\.mp4$/.test(fileName)
  ) {
    throw new Error("INVALID_MP4_FILE_NAME");
  }

  return fileName;
}

function createMp4StorageKey() {
  return "rendered-videos/" +
    randomUUID() + ".mp4";
}

async function uploadRenderedMp4({
  outputDirectory,
  fileName,
  enabled = false
}) {
  if (enabled !== true) {
    throw new Error("MP4_R2_STORAGE_DISABLED");
  }

  validateMp4FileName(fileName);

  if (
    typeof outputDirectory !== "string" ||
    !path.isAbsolute(outputDirectory)
  ) {
    throw new Error("INVALID_OUTPUT_DIRECTORY");
  }

  const root = await fs.realpath(outputDirectory);
  const filePath = path.join(root, fileName);

  if (path.dirname(filePath) !== root) {
    throw new Error("INVALID_MP4_PATH");
  }

  const fileStat = await fs.lstat(filePath, { bigint: true });

  if (
    !fileStat.isFile() ||
    fileStat.isSymbolicLink() ||
    fileStat.size <= 0n ||
    fileStat.size > BigInt(MAX_MP4_BYTES)
  ) {
    throw new Error("INVALID_MP4_FILE");
  }

  const handle = await fs.open(filePath, "r");
  let body;

  try {
    const openedStat = await handle.stat({ bigint: true });

    if (
      !openedStat.isFile() ||
      openedStat.dev !== fileStat.dev ||
      openedStat.ino !== fileStat.ino ||
      openedStat.size !== fileStat.size ||
      openedStat.size <= 0n ||
      openedStat.size > BigInt(MAX_MP4_BYTES)
    ) {
      throw new Error("INVALID_MP4_FILE");
    }

    body = await handle.readFile();

    const finalStat = await handle.stat({ bigint: true });

    if (
      BigInt(body.length) !== openedStat.size ||
      finalStat.dev !== openedStat.dev ||
      finalStat.ino !== openedStat.ino ||
      finalStat.size !== openedStat.size ||
      finalStat.mtimeNs !== openedStat.mtimeNs ||
      body.length > MAX_MP4_BYTES
    ) {
      throw new Error("INVALID_MP4_CONTENT");
    }
  } finally {
    await handle.close();
  }

  const key = createMp4StorageKey();

  const stored = await uploadMedia({
    key,
    body,
    contentType: "video/mp4"
  });

  return {
    provider: stored.provider,
    bucket: stored.bucket,
    key: stored.key,
    fileName,
    sizeBytes: body.length
  };
}

async function downloadRenderedMp4({
  key,
  enabled = false
}) {
  if (enabled !== true) {
    throw new Error("MP4_R2_STORAGE_DISABLED");
  }

  if (
    typeof key !== "string" ||
    !/^rendered-videos\/[0-9a-f-]{36}\.mp4$/i.test(key)
  ) {
    throw new Error("INVALID_MP4_STORAGE_KEY");
  }

  return downloadMedia({
    key,
    contentType: "video/mp4"
  });
}

module.exports = {
  MAX_MP4_BYTES,
  validateMp4FileName,
  createMp4StorageKey,
  uploadRenderedMp4,
  downloadRenderedMp4
};

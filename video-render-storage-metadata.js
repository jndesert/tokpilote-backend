"use strict";

const STORAGE_LOCAL = "local";
const STORAGE_R2 = "r2";

function validateFileName(fileName) {
  if (
    typeof fileName !== "string" ||
    !/^[a-zA-Z0-9_-]+\.mp4$/.test(fileName)
  ) {
    throw new Error("INVALID_MP4_FILE_NAME");
  }

  return fileName;
}

function validateStorageMetadata(metadata) {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    throw new Error("INVALID_STORAGE_METADATA");
  }

  const { mode, fileName, key } = metadata;

  validateFileName(fileName);

  if (mode === STORAGE_LOCAL) {
    if (key !== undefined && key !== null) {
      throw new Error("LOCAL_STORAGE_KEY_NOT_ALLOWED");
    }

    return {
      mode: STORAGE_LOCAL,
      fileName,
      key: null
    };
  }

  if (mode === STORAGE_R2) {
    if (
      typeof key !== "string" ||
      !/^rendered-videos\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.mp4$/i.test(key)
    ) {
      throw new Error("INVALID_MP4_STORAGE_KEY");
    }

    return {
      mode: STORAGE_R2,
      fileName,
      key
    };
  }

  throw new Error("INVALID_STORAGE_MODE");
}

module.exports = {
  STORAGE_LOCAL,
  STORAGE_R2,
  validateFileName,
  validateStorageMetadata
};

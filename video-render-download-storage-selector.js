"use strict";

const {
  STORAGE_LOCAL,
  STORAGE_R2,
  validateStorageMetadata
} = require("./video-render-storage-metadata");

function selectDownloadStorage({
  entry,
  allowR2 = false
} = {}) {
  if (
    !entry ||
    typeof entry !== "object" ||
    Array.isArray(entry)
  ) {
    throw new Error("INVALID_DOWNLOAD_ENTRY");
  }

  const metadata = validateStorageMetadata(
    entry.storage || {
      mode: STORAGE_LOCAL,
      fileName: entry.fileName
    }
  );

  if (
    entry.fileName !== undefined &&
    entry.fileName !== metadata.fileName
  ) {
    throw new Error("DOWNLOAD_FILE_NAME_MISMATCH");
  }

  if (metadata.mode === STORAGE_LOCAL) {
    return {
      mode: STORAGE_LOCAL,
      fileName: metadata.fileName,
      key: null
    };
  }

  if (metadata.mode === STORAGE_R2) {
    if (allowR2 !== true) {
      throw new Error("R2_DOWNLOAD_DISABLED");
    }

    return {
      mode: STORAGE_R2,
      fileName: metadata.fileName,
      key: metadata.key
    };
  }

  throw new Error("INVALID_STORAGE_MODE");
}

module.exports = {
  selectDownloadStorage
};

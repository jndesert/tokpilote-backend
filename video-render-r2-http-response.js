"use strict";

const {
  validateStorageMetadata
} = require("./video-render-storage-metadata");

const MAX_MP4_BYTES = 200 * 1024 * 1024;

function prepareR2Mp4Response({
  stored,
  fileName,
  key
} = {}) {
  const metadata = validateStorageMetadata({
    mode: "r2",
    fileName,
    key
  });

  if (
    !stored ||
    typeof stored !== "object" ||
    Array.isArray(stored)
  ) {
    throw new Error("INVALID_R2_RESPONSE");
  }

  if (stored.key !== metadata.key) {
    throw new Error("R2_KEY_MISMATCH");
  }

  if (stored.contentType !== "video/mp4") {
    throw new Error("INVALID_MP4_CONTENT_TYPE");
  }

  if (!Buffer.isBuffer(stored.body)) {
    throw new Error("INVALID_MP4_BODY");
  }

  const size = stored.body.length;

  if (size <= 0 || size > MAX_MP4_BYTES) {
    throw new Error("INVALID_MP4_SIZE");
  }

  if (
    !Number.isSafeInteger(stored.sizeBytes) ||
    stored.sizeBytes !== size
  ) {
    throw new Error("MP4_SIZE_MISMATCH");
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(size),
      "Content-Disposition":
        'attachment; filename="' + metadata.fileName + '"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    },
    body: stored.body
  };
}

module.exports = {
  MAX_MP4_BYTES,
  prepareR2Mp4Response
};

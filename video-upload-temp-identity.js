"use strict";

const crypto = require("node:crypto");

const MANIFEST_VERSION = 1;
const MANIFEST_KIND = "videapilot-temp-upload";

const PROCESS_INSTANCE_ID = crypto.randomUUID();

function createTempUploadIdentity() {
  const uploadId = crypto.randomUUID();


  const createdAt = new Date().toISOString();

  return Object.freeze({
    uploadId,
    processInstanceId: PROCESS_INSTANCE_ID,
    pid: process.pid,
    createdAt
  });
}

function createTempUploadManifest(identity) {
  if (
    !identity ||
    typeof identity.uploadId !== "string" ||
    typeof identity.processInstanceId !== "string" ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    typeof identity.createdAt !== "string"
  ) {
    throw new Error("MEDIA_UPLOAD_INVALID_IDENTITY");
  }

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (
    !uuidPattern.test(identity.uploadId) ||
    !uuidPattern.test(identity.processInstanceId)
  ) {
    throw new Error("MEDIA_UPLOAD_INVALID_IDENTITY");
  }

  if (
    !Number.isFinite(Date.parse(identity.createdAt))
  ) {
    throw new Error("MEDIA_UPLOAD_INVALID_IDENTITY");
  }

  return Object.freeze({
    version: MANIFEST_VERSION,
    kind: MANIFEST_KIND,
    uploadId: identity.uploadId,
    processInstanceId: identity.processInstanceId,
    pid: identity.pid,
    createdAt: identity.createdAt
  });
}

function validateTempUploadManifest(manifest) {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.version !== MANIFEST_VERSION ||
    manifest.kind !== MANIFEST_KIND
  ) {
    return false;
  }

  try {
    const identity = {
      uploadId: manifest.uploadId,
      processInstanceId: manifest.processInstanceId,
      pid: manifest.pid,
      createdAt: manifest.createdAt
    };

    createTempUploadManifest(identity);

    return true;
  } catch {
    return false;
  }
}

module.exports = {
  MANIFEST_VERSION,
  MANIFEST_KIND,
  createTempUploadIdentity,
  createTempUploadManifest,
  validateTempUploadManifest
};

"use strict";

const os = require("node:os");
const path = require("node:path");

const {
  createTempUploadIdentity,
  validateTempUploadManifest
} = require("./video-upload-temp-identity");

const CURRENT_INSTANCE_ID =
  createTempUploadIdentity().processInstanceId;

function createTempUploadRegistry() {
  const records = new Map();

  function register(manifest, directory) {
    if (!validateTempUploadManifest(manifest)) {
      throw new Error("MEDIA_UPLOAD_REGISTRY_INVALID_MANIFEST");
    }

    if (manifest.processInstanceId !== CURRENT_INSTANCE_ID) {
      throw new Error("MEDIA_UPLOAD_REGISTRY_FOREIGN_INSTANCE");
    }

    if (
      typeof directory !== "string" ||
      !path.isAbsolute(directory)
    ) {
      throw new Error("MEDIA_UPLOAD_REGISTRY_INVALID_DIRECTORY");
    }

    const normalized = path.resolve(directory);
    const tempRoot = path.resolve(os.tmpdir());

    if (
      path.dirname(normalized) !== tempRoot ||
      !path.basename(normalized).startsWith("videapilot-upload-")
    ) {
      throw new Error("MEDIA_UPLOAD_REGISTRY_INVALID_DIRECTORY");
    }

    if (records.has(manifest.uploadId)) {
      throw new Error("MEDIA_UPLOAD_REGISTRY_DUPLICATE");
    }

    for (const record of records.values()) {
      if (record.directory === normalized) {
        throw new Error("MEDIA_UPLOAD_REGISTRY_DUPLICATE_DIRECTORY");
      }
    }

    const record = Object.freeze({
      uploadId: manifest.uploadId,
      processInstanceId: manifest.processInstanceId,
      pid: manifest.pid,
      createdAt: manifest.createdAt,
      directory: normalized
    });

    records.set(record.uploadId, record);

    return record;
  }

  function get(uploadId) {
    return records.get(uploadId) ?? null;
  }

  function unregister(uploadId) {
    return records.delete(uploadId);
  }

  function list() {
    return Object.freeze([...records.values()]);
  }

  function getStatus() {
    return Object.freeze({
      count: records.size,
      processInstanceId: CURRENT_INSTANCE_ID
    });
  }

  return Object.freeze({
    register,
    get,
    unregister,
    list,
    getStatus
  });
}

const videoUploadTempRegistry = createTempUploadRegistry();

module.exports = {
  createTempUploadRegistry,
  videoUploadTempRegistry
};
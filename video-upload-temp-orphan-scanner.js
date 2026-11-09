"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  readTempUploadManifest
} = require("./video-upload-temp-manifest");

const {
  validateTempUploadManifest
} = require("./video-upload-temp-identity");

const {
  videoUploadTempRegistry
} = require("./video-upload-temp-registry");

const {
  inspectTempUploadPath,
  inspectTempUploadManifestPath
} = require("./video-upload-temp-path-guard");

const PREFIX = "videapilot-upload-";

async function scanTempUploadDirectories() {
  const root = path.resolve(os.tmpdir());

  const entries = await fs.readdir(root, {
    withFileTypes: true
  });

  const candidates = entries.filter(entry =>
    entry.name.startsWith(PREFIX)
  );

  const results = [];

  for (const entry of candidates) {
    const directory = path.join(root, entry.name);

    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      results.push(Object.freeze({
        name: entry.name,
        status: "UNINSPECTABLE",
        reason: "INVALID_DIRECTORY_TYPE"
      }));

      continue;
    }

    const directoryInspection =
      await inspectTempUploadPath(directory);

    if (!directoryInspection.safe) {
      results.push(Object.freeze({
        name: entry.name,
        status: "UNINSPECTABLE",
        reason: directoryInspection.reason
      }));
      continue;
    }

    const manifestInspection =
      await inspectTempUploadManifestPath(directory);

    if (!manifestInspection.safe) {
      results.push(Object.freeze({
        name: entry.name,
        status: manifestInspection.reason ===
          "MANIFEST_INSPECTION_FAILED:ENOENT"
          ? "MISSING_MANIFEST"
          : "UNINSPECTABLE",
        reason: manifestInspection.reason
      }));
      continue;
    }

    try {
      const manifest = await readTempUploadManifest(
        directory
      );

      if (validateTempUploadManifest(manifest) !== true) {
        throw new Error("INVALID_MANIFEST");
      }

      const record = videoUploadTempRegistry.get(
        manifest.uploadId
      );

      const registered =
        record !== null &&
        record.directory === directory &&
        record.processInstanceId ===
          manifest.processInstanceId;

      results.push(Object.freeze({
        name: entry.name,
        status: registered
          ? "REGISTERED"
          : "UNREGISTERED",
        uploadId: manifest.uploadId,
        processInstanceId: manifest.processInstanceId,
        pid: manifest.pid,
        registered
      }));
    } catch (error) {
      // Ne classer INVALID_MANIFEST que les erreurs
      // explicitement liees au contenu du manifeste.
      const invalidManifestErrors = new Set([
        "INVALID_MANIFEST",
        "MEDIA_UPLOAD_INVALID_MANIFEST",
        "MEDIA_UPLOAD_MANIFEST_TOO_LARGE"
      ]);

      let status = invalidManifestErrors.has(error.message)
        ? "INVALID_MANIFEST"
        : "UNINSPECTABLE";

      try {
        await fs.lstat(
          path.join(directory, "manifest.json")
        );
      } catch (statError) {
        if (statError.code === "ENOENT") {
          status = "MISSING_MANIFEST";
        } else {
          status = "UNINSPECTABLE";
        }
      }

      results.push(Object.freeze({
        name: entry.name,
        status,
        reason: error.code || error.message
      }));
    }
  }

  return Object.freeze({
    root,
    scannedAt: new Date().toISOString(),
    count: results.length,
    entries: Object.freeze(results)
  });
}

module.exports = {
  scanTempUploadDirectories
};
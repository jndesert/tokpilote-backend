"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const PREFIX = "videapilot-upload-";
const MANIFEST = "manifest.json";

function unsafe(reason) {
  return Object.freeze({
    safe: false,
    reason
  });
}

async function inspectTempUploadPath(directory) {
  if (
    typeof directory !== "string" ||
    !path.isAbsolute(directory)
  ) {
    return unsafe("INVALID_PATH");
  }

  const root = path.resolve(os.tmpdir());
  const normalized = path.resolve(directory);

  if (
    path.dirname(normalized) !== root ||
    !path.basename(normalized).startsWith(PREFIX)
  ) {
    return unsafe("OUTSIDE_TEMP_ROOT");
  }

  try {
    const rootStat = await fs.lstat(root);
    const directoryStat = await fs.lstat(normalized);

    if (
      !rootStat.isDirectory() ||
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink()
    ) {
      return unsafe("INVALID_DIRECTORY_TYPE");
    }

    const realRoot = await fs.realpath(root);
    const realDirectory = await fs.realpath(
      normalized
    );

    if (
      path.dirname(realDirectory) !== realRoot
    ) {
      return unsafe("REALPATH_MISMATCH");
    }

    const checkedAgain = await fs.lstat(
      normalized
    );

    if (
      !checkedAgain.isDirectory() ||
      checkedAgain.isSymbolicLink() ||
      checkedAgain.dev !== directoryStat.dev ||
      checkedAgain.ino !== directoryStat.ino
    ) {
      return unsafe("DIRECTORY_CHANGED");
    }

    return Object.freeze({
      safe: true,
      reason: "PATH_INSPECTED",
      directory: normalized
    });
  } catch (error) {
    return unsafe(
      "INSPECTION_FAILED:" +
      (error.code || "UNKNOWN")
    );
  }
}

async function inspectTempUploadManifestPath(
  directory
) {
  const parent = await inspectTempUploadPath(
    directory
  );

  if (!parent.safe) {
    return parent;
  }

  const filePath = path.join(
    parent.directory,
    MANIFEST
  );

  try {
    const stat = await fs.lstat(filePath);

    if (
      !stat.isFile() ||
      stat.isSymbolicLink()
    ) {
      return unsafe("INVALID_MANIFEST_TYPE");
    }

    const realDirectory = await fs.realpath(
      parent.directory
    );

    const realFile = await fs.realpath(filePath);

    if (
      path.dirname(realFile) !== realDirectory
    ) {
      return unsafe("MANIFEST_REALPATH_MISMATCH");
    }

    const checkedAgain = await fs.lstat(
      filePath
    );

    if (
      !checkedAgain.isFile() ||
      checkedAgain.isSymbolicLink() ||
      checkedAgain.dev !== stat.dev ||
      checkedAgain.ino !== stat.ino
    ) {
      return unsafe("MANIFEST_CHANGED");
    }

    return Object.freeze({
      safe: true,
      reason: "MANIFEST_PATH_INSPECTED",
      directory: parent.directory,
      manifestPath: filePath
    });
  } catch (error) {
    return unsafe(
      "MANIFEST_INSPECTION_FAILED:" +
      (error.code || "UNKNOWN")
    );
  }
}

module.exports = {
  inspectTempUploadPath,
  inspectTempUploadManifestPath
};
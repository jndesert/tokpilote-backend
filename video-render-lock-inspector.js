"use strict";

const fs = require("node:fs");
const path = require("node:path");

function inspectRenderLock(lockFilePath) {
  if (
    typeof lockFilePath !== "string" ||
    !path.isAbsolute(lockFilePath)
  ) {
    throw new Error("INVALID_RENDER_LOCK_PATH");
  }

  const lockPath = path.resolve(lockFilePath);

  let stats;

  try {
    stats = fs.lstatSync(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        status: "ABSENT",
        path: lockPath
      };
    }

    throw error;
  }

  if (!stats.isFile() || stats.isSymbolicLink()) {
    return {
      status: "INVALID",
      path: lockPath,
      reason: "NOT_REGULAR_FILE"
    };
  }

  if (stats.size <= 0 || stats.size > 4096) {
    return {
      status: "INVALID",
      path: lockPath,
      reason: "INVALID_METADATA_SIZE"
    };
  }

  let metadata;

  try {
    metadata = JSON.parse(
      fs.readFileSync(lockPath, "utf8")
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        status: "UNKNOWN",
        path: lockPath,
        reason: "LOCK_CHANGED_DURING_INSPECTION"
      };
    }

    if (error instanceof SyntaxError) {
      return {
        status: "INVALID",
        path: lockPath,
        reason: "INVALID_JSON"
      };
    }

    throw error;
  }

  if (
    !metadata ||
    !Number.isSafeInteger(metadata.pid) ||
    metadata.pid <= 0 ||
    typeof metadata.token !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      metadata.token
    ) ||
    typeof metadata.createdAt !== "string" ||
    !Number.isFinite(Date.parse(metadata.createdAt))
  ) {
    return {
      status: "INVALID",
      path: lockPath,
      reason: "INVALID_METADATA"
    };
  }

  try {
    process.kill(metadata.pid, 0);

    return {
      status: "ACTIVE",
      path: lockPath,
      pid: metadata.pid,
      createdAt: metadata.createdAt
    };

  } catch (error) {
    if (error.code === "ESRCH") {
      return {
        status: "STALE_CANDIDATE",
        path: lockPath,
        pid: metadata.pid,
        createdAt: metadata.createdAt
      };
    }

    return {
      status: "UNKNOWN",
      path: lockPath,
      pid: metadata.pid,
      createdAt: metadata.createdAt,
      reason: "PROCESS_STATUS_UNAVAILABLE"
    };
  }
}

module.exports = {
  inspectRenderLock
};

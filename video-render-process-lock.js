"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function createProcessRenderLock(lockFilePath) {
  if (
    typeof lockFilePath !== "string" ||
    !path.isAbsolute(lockFilePath)
  ) {
    throw new Error("INVALID_RENDER_LOCK_PATH");
  }

  const lockPath = path.resolve(lockFilePath);
  let held = false;

  async function run(task) {
    if (typeof task !== "function") {
      throw new Error("INVALID_RENDER_TASK");
    }

    if (held) {
      throw new Error("VIDEO_RENDER_BUSY");
    }

    let descriptor;
    const token = randomUUID();

    try {
      descriptor = fs.openSync(
        lockPath,
        "wx",
        0o600
      );
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error("VIDEO_RENDER_BUSY");
      }

      throw error;
    }

    held = true;

    try {
      const metadata = JSON.stringify({
        pid: process.pid,
        token,
        createdAt: new Date().toISOString()
      });

      fs.writeFileSync(descriptor, metadata, "utf8");

      return await task();

    } finally {
      try {
        if (descriptor !== undefined) {
          fs.closeSync(descriptor);
        }
      } finally {
        // Ne supprimer que le verrou encore associe
        // au fichier cree par cette instance.
        try {
          const metadata = JSON.parse(
            fs.readFileSync(lockPath, "utf8")
          );

          if (metadata.token === token) {
            fs.unlinkSync(lockPath);
          }
        } catch (error) {
          if (
            error.code !== "ENOENT" &&
            !(error instanceof SyntaxError)
          ) {
            throw error;
          }
        } finally {
          held = false;
        }
      }
    }
  }

  return Object.freeze({
    run,
    isBusy: () => held
  });
}

module.exports = {
  createProcessRenderLock
};

"use strict";

const path = require("node:path");

function createActiveRenderRegistry() {
  const activeDirectories = new Set();

  function normalizeDirectory(directory) {
    if (
      typeof directory !== "string" ||
      !path.isAbsolute(directory)
    ) {
      throw new Error("INVALID_ACTIVE_RENDER_DIRECTORY");
    }

    return path.resolve(directory);
  }

  function register(directory) {
    const normalized = normalizeDirectory(directory);

    if (activeDirectories.has(normalized)) {
      throw new Error("RENDER_DIRECTORY_ALREADY_ACTIVE");
    }

    activeDirectories.add(normalized);

    return normalized;
  }

  function unregister(directory) {
    const normalized = normalizeDirectory(directory);

    return activeDirectories.delete(normalized);
  }

  function isActive(directory) {
    const normalized = normalizeDirectory(directory);

    return activeDirectories.has(normalized);
  }

  function listActive() {
    return [...activeDirectories];
  }

  function count() {
    return activeDirectories.size;
  }

  return Object.freeze({
    register,
    unregister,
    isActive,
    listActive,
    count
  });
}

module.exports = {
  createActiveRenderRegistry
};

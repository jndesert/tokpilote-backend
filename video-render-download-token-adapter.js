"use strict";

const {
  createDownloadTokenStore
} = require("./video-render-download-token-store");

const STORAGE_MEMORY = "memory";
const STORAGE_POSTGRES = "postgres";

function createDownloadTokenAdapter({
  pool,
  mode = STORAGE_MEMORY,
  memoryStore = null,
  allowPostgres = false
} = {}) {
  if (mode === STORAGE_MEMORY) {
    if (!memoryStore || typeof memoryStore !== "object") {
      throw new Error("MEMORY_STORE_REQUIRED");
    }

    const methods = [
      "createToken",
      "findToken",
      "deleteToken",
      "cleanupExpiredTokens"
    ];

    for (const method of methods) {
      if (typeof memoryStore[method] !== "function") {
        throw new Error(
          "MEMORY_STORE_METHOD_MISSING: " + method
        );
      }
    }

    return {
      mode: STORAGE_MEMORY,
      createToken: (...args) => memoryStore.createToken(...args),
      findToken: (...args) => memoryStore.findToken(...args),
      deleteToken: (...args) => memoryStore.deleteToken(...args),
      cleanupExpiredTokens: (...args) =>
        memoryStore.cleanupExpiredTokens(...args)
    };
  }

  if (mode === STORAGE_POSTGRES) {
    if (allowPostgres !== true) {
      throw new Error("POSTGRES_TOKEN_STORAGE_NOT_ENABLED");
    }

    if (!pool || typeof pool.query !== "function") {
      throw new Error("INVALID_DATABASE_POOL");
    }

    const store = createDownloadTokenStore(pool);

    return {
      mode: STORAGE_POSTGRES,
      ...store
    };
  }

  throw new Error("INVALID_TOKEN_STORAGE_MODE");
}

module.exports = {
  STORAGE_MEMORY,
  STORAGE_POSTGRES,
  createDownloadTokenAdapter
};

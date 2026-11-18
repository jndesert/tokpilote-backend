"use strict";
const { validateStorageMetadata } = require("./video-render-storage-metadata");

const { createHash, randomUUID } = require("node:crypto");

const TOKEN_TTL_MS = 15 * 60 * 1000;

function hashDownloadToken(token) {
  if (
    typeof token !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)
  ) {
    throw new Error("INVALID_DOWNLOAD_TOKEN");
  }

  return createHash("sha256")
    .update(token, "utf8")
    .digest("hex");
}

function createDownloadTokenStore(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new Error("INVALID_DATABASE_POOL");
  }

  async function createToken({ projectId, userId, fileName, storage = null }) {
    if (
      !Number.isSafeInteger(Number(projectId)) ||
      Number(projectId) <= 0 ||
      typeof userId !== "string" ||
      !userId.trim() ||
      typeof fileName !== "string" ||
      !/^[a-zA-Z0-9_-]+[.]mp4$/.test(fileName)
    ) {
      throw new Error("INVALID_TOKEN_METADATA");
    }

    const validatedStorage = validateStorageMetadata(
      storage || { mode: "local", fileName }
    );

    if (validatedStorage.fileName !== fileName) {
      throw new Error("TOKEN_FILE_NAME_MISMATCH");
    }

    const token = randomUUID();
    const tokenHash = hashDownloadToken(token);

    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    await pool.query(
      `INSERT INTO video_render_download_tokens
         (token_hash, project_id, user_id, file_name, expires_at, storage_mode, storage_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        tokenHash,
        Number(projectId),
        userId,
        fileName,
        expiresAt,
        validatedStorage.mode,
        validatedStorage.key
      ]
    );

    return {
      token,
      expiresAt
    };
  }

  async function findToken(token, userId) {
    const tokenHash = hashDownloadToken(token);

    if (typeof userId !== "string" || !userId.trim()) {
      throw new Error("INVALID_TOKEN_OWNER");
    }

    const result = await pool.query(
      `SELECT project_id, user_id, file_name, expires_at, storage_mode, storage_key
         FROM video_render_download_tokens
        WHERE token_hash = $1
          AND user_id = $2
          AND expires_at > NOW()
        LIMIT 1`,
      [tokenHash, userId]
    );

    const row = result.rows[0];

    if (!row) return null;

    return {
      projectId: Number(row.project_id),
      userId: row.user_id,
      fileName: row.file_name,
      storage: validateStorageMetadata({
        mode: row.storage_mode,
        fileName: row.file_name,
        key: row.storage_key
      }),
      expiresAt: row.expires_at
    };
  }

  async function deleteToken(token, userId) {
    const tokenHash = hashDownloadToken(token);

    if (typeof userId !== "string" || !userId.trim()) {
      throw new Error("INVALID_TOKEN_OWNER");
    }

    const result = await pool.query(
      `DELETE FROM video_render_download_tokens
        WHERE token_hash = $1
          AND user_id = $2`,
      [tokenHash, userId]
    );

    return result.rowCount;
  }

  async function cleanupExpiredTokens() {
    const result = await pool.query(
      `DELETE FROM video_render_download_tokens
        WHERE expires_at <= NOW()`
    );

    return result.rowCount;
  }

  return {
    createToken,
    findToken,
    deleteToken,
    cleanupExpiredTokens
  };
}

module.exports = {
  TOKEN_TTL_MS,
  hashDownloadToken,
  createDownloadTokenStore
};

"use strict";

const { randomUUID } = require("node:crypto");

const MAX_BIGINT = 9223372036854775807n;

const PUBLISH_SQL = `
UPDATE video_render_jobs
SET published_result = $5
WHERE job_id = $1
  AND owner_id = $2
  AND fencing_token = $3::bigint
  AND generation_id = $4::uuid
RETURNING job_id, fencing_token, generation_id
`;

function validateToken(token) {
  if (
    typeof token !== "string" ||
    !/^[1-9][0-9]*$/.test(token)
  ) {
    throw new Error("INVALID_FENCING_TOKEN");
  }

  if (BigInt(token) > MAX_BIGINT) {
    throw new Error("INVALID_FENCING_TOKEN");
  }

  return token;
}

function validateGenerationId(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error("INVALID_GENERATION_ID");
  }

  return value.toLowerCase();
}

function createGenerationId() {
  return randomUUID();
}

function createGenerationPublisher(db) {
  if (!db || typeof db.query !== "function") {
    throw new Error("INVALID_FENCING_DB");
  }

  async function publish(options = {}) {
    const {
      jobId,
      ownerId,
      token,
      generationId,
      resultPath
    } = options;

    if (typeof jobId !== "string" || !jobId.trim()) {
      throw new Error("INVALID_JOB_ID");
    }

    if (typeof ownerId !== "string" || !ownerId.trim()) {
      throw new Error("INVALID_OWNER_ID");
    }

    const validToken = validateToken(token);
    const validGenerationId =
      validateGenerationId(generationId);

    if (
      typeof resultPath !== "string" ||
      !resultPath.trim()
    ) {
      throw new Error("INVALID_RESULT_PATH");
    }

    const result = await db.query(PUBLISH_SQL, [
      jobId,
      ownerId,
      validToken,
      validGenerationId,
      resultPath
    ]);

    if (!result || !Array.isArray(result.rows)) {
      throw new Error("INVALID_DB_RESPONSE");
    }

    if (result.rows.length > 1) {
      throw new Error("INVALID_ROW_COUNT");
    }

    if (result.rows.length === 0) {
      return Object.freeze({
        accepted: false,
        reason: "STALE_GENERATION"
      });
    }

    const row = result.rows[0];

    if (
      !row ||
      row.job_id !== jobId ||
      String(row.fencing_token) !== validToken ||
      String(row.generation_id).toLowerCase() !==
        validGenerationId
    ) {
      throw new Error("INVALID_DB_RESPONSE");
    }

    return Object.freeze({
      accepted: true,
      jobId,
      token: validToken,
      generationId: validGenerationId,
      resultPath
    });
  }

  return Object.freeze({ publish });
}

module.exports = {
  PUBLISH_SQL,
  validateToken,
  validateGenerationId,
  createGenerationId,
  createGenerationPublisher
};

"use strict";

const {
  validateToken,
  validateGenerationId
} = require("./video-render-generation-guard");

const VERIFY_SQL = `
SELECT
  job_id,
  owner_id,
  fencing_token,
  generation_id,
  published_result
FROM video_render_jobs
WHERE job_id = $1
`;

function createPublicationVerifier(db) {
  if (!db || typeof db.query !== "function") {
    throw new Error("INVALID_FENCING_DB");
  }

  async function verify(options = {}) {
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
    const validGeneration =
      validateGenerationId(generationId);

    if (
      typeof resultPath !== "string" ||
      !resultPath.trim()
    ) {
      throw new Error("INVALID_RESULT_PATH");
    }

    let response;

    try {
      response = await db.query(VERIFY_SQL, [jobId]);
    } catch (error) {
      return Object.freeze({
        status: "UNKNOWN",
        reason: "READ_FAILED"
      });
    }

    if (
      !response ||
      !Array.isArray(response.rows) ||
      response.rows.length > 1
    ) {
      return Object.freeze({
        status: "UNKNOWN",
        reason: "INVALID_READ_RESPONSE"
      });
    }

    if (response.rows.length === 0) {
      return Object.freeze({
        status: "UNKNOWN",
        reason: "JOB_NOT_FOUND"
      });
    }

    const row = response.rows[0];

    if (
      !row ||
      row.job_id !== jobId ||
      typeof row.owner_id !== "string" ||
      typeof row.generation_id !== "string" ||
      !(
        row.published_result === null ||
        typeof row.published_result === "string"
      )
    ) {
      return Object.freeze({
        status: "UNKNOWN",
        reason: "INVALID_READ_RESPONSE"
      });
    }

    let storedToken;
    let storedGeneration;

    try {
      storedToken = validateToken(
        String(row.fencing_token)
      );

      storedGeneration = validateGenerationId(
        row.generation_id
      );
    } catch (error) {
      return Object.freeze({
        status: "UNKNOWN",
        reason: "INVALID_READ_RESPONSE"
      });
    }

    if (
      row.owner_id !== ownerId ||
      storedToken !== validToken ||
      storedGeneration !== validGeneration
    ) {
      return Object.freeze({
        status: "STALE_GENERATION"
      });
    }

    if (row.published_result === resultPath) {
      return Object.freeze({
        status: "CONFIRMED"
      });
    }

    if (row.published_result === null) {
      return Object.freeze({
        status: "NOT_PUBLISHED"
      });
    }

    return Object.freeze({
      status: "CONFLICTING_RESULT"
    });
  }

  return Object.freeze({ verify });
}

module.exports = {
  VERIFY_SQL,
  createPublicationVerifier
};

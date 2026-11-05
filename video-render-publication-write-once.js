"use strict";

/*
 * VideaPilot - Publication atomique a ecriture unique.
 *
 * Module experimental.
 * Aucune connexion PostgreSQL directe.
 * Aucune publication automatique.
 */

const PUBLISH_ONCE_SQL = `
UPDATE video_render_jobs
SET published_result = $5
WHERE job_id = $1
  AND owner_id = $2
  AND fencing_token = $3::bigint
  AND generation_id = $4::uuid
  AND published_result IS NULL
RETURNING job_id, fencing_token, generation_id
`;

function createWriteOncePublisher(db) {
  if (!db || typeof db.query !== "function") {
    throw new Error("INVALID_DATABASE");
  }

  async function publish(options) {
    if (!options || typeof options !== "object") {
      throw new Error("INVALID_OPTIONS");
    }

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

    const tokenText = String(token);

    if (
      !/^[1-9][0-9]*$/.test(tokenText) ||
      BigInt(tokenText) > 9223372036854775807n ||
      (typeof token === "number" &&
        !Number.isSafeInteger(token))
    ) {
      throw new Error("INVALID_TOKEN");
    }

    if (
      typeof generationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        generationId
      )
    ) {
      throw new Error("INVALID_GENERATION_ID");
    }

    if (
      typeof resultPath !== "string" ||
      !resultPath.trim()
    ) {
      throw new Error("INVALID_RESULT_PATH");
    }

    const response = await db.query(
      PUBLISH_ONCE_SQL,
      [
        jobId,
        ownerId,
        tokenText,
        generationId,
        resultPath
      ]
    );

    if (
      !response ||
      !Number.isInteger(response.rowCount) ||
      !Array.isArray(response.rows) ||
      response.rowCount !== response.rows.length ||
      response.rowCount > 1
    ) {
      throw new Error("INVALID_DATABASE_RESPONSE");
    }

    if (response.rowCount === 0) {
      return Object.freeze({
        accepted: false,
        status: "RECHECK_REQUIRED",
        reason: "WRITE_CONDITION_NOT_MET",
        allowAutomaticPublish: false
      });
    }

    const row = response.rows[0];

    if (
      !row ||
      row.job_id !== jobId ||
      String(row.fencing_token) !== tokenText ||
      String(row.generation_id).toLowerCase() !==
        generationId.toLowerCase()
    ) {
      throw new Error("INVALID_RETURNED_ROW");
    }

    return Object.freeze({
      accepted: true,
      status: "PUBLISHED",
      jobId,
      generationId,
      allowAutomaticPublish: false
    });
  }

  return Object.freeze({ publish });
}

module.exports = {
  PUBLISH_ONCE_SQL,
  createWriteOncePublisher
};

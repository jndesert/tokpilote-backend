"use strict";

/*
 * VidéaPilot - Publication conditionnelle BIGINT.
 *
 * Version experimentale non connectee a la production.
 *
 * Les jetons sont transmis a PostgreSQL sous forme
 * de chaines decimales pour eviter toute perte
 * de precision JavaScript.
 *
 * La generation persistante des jetons et la protection
 * physique des fichiers MP4 restent a implementer.
 */

const MAX_BIGINT = 9223372036854775807n;

const PUBLISH_SQL = `
UPDATE video_render_jobs
SET published_result = $4
WHERE job_id = $1
  AND owner_id = $2
  AND fencing_token = $3::bigint
RETURNING job_id, fencing_token, published_result
`;

function normalizeFencingToken(token) {
  let value;

  if (typeof token === "bigint") {
    value = token;
  } else if (typeof token === "number") {
    if (!Number.isSafeInteger(token)) {
      throw new Error("INVALID_FENCING_TOKEN");
    }

    value = BigInt(token);
  } else if (typeof token === "string") {
    if (!/^[1-9][0-9]*$/.test(token)) {
      throw new Error("INVALID_FENCING_TOKEN");
    }

    value = BigInt(token);
  } else {
    throw new Error("INVALID_FENCING_TOKEN");
  }

  if (value <= 0n || value > MAX_BIGINT) {
    throw new Error("INVALID_FENCING_TOKEN");
  }

  return value.toString();
}

function createFencingPublisher(db) {
  if (!db || typeof db.query !== "function") {
    throw new Error("INVALID_FENCING_DB");
  }

  async function publish(options = {}) {
    const {
      jobId,
      ownerId,
      token,
      resultPath
    } = options;

    if (typeof jobId !== "string" || !jobId.trim()) {
      throw new Error("INVALID_JOB_ID");
    }

    if (typeof ownerId !== "string" || !ownerId.trim()) {
      throw new Error("INVALID_OWNER_ID");
    }

    const normalizedToken = normalizeFencingToken(token);

    if (
      typeof resultPath !== "string" ||
      !resultPath.trim()
    ) {
      throw new Error("INVALID_RESULT_PATH");
    }

    const result = await db.query(
      PUBLISH_SQL,
      [jobId, ownerId, normalizedToken, resultPath]
    );

    if (!result || !Array.isArray(result.rows)) {
      throw new Error("INVALID_FENCING_DB_RESPONSE");
    }

    if (result.rows.length > 1) {
      throw new Error("INVALID_FENCING_ROW_COUNT");
    }

    if (result.rows.length === 0) {
      return Object.freeze({
        accepted: false,
        reason: "STALE_FENCING_TOKEN"
      });
    }

    return Object.freeze({
      accepted: true,
      jobId,
      token: normalizedToken,
      resultPath
    });
  }

  return Object.freeze({ publish });
}

module.exports = {
  MAX_BIGINT,
  PUBLISH_SQL,
  normalizeFencingToken,
  createFencingPublisher
};

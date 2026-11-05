"use strict";

/*
 * VidéaPilot - Publication conditionnelle experimentale.
 *
 * Table SQL attendue pour une future integration :
 *
 * video_render_jobs (
 *   job_id TEXT PRIMARY KEY,
 *   fencing_token BIGINT NOT NULL,
 *   owner_id TEXT NOT NULL,
 *   published_result TEXT
 * )
 *
 * IMPORTANT :
 * - Aucune table n'est creee ici.
 * - Le jeton doit etre genere durablement et de
 *   maniere strictement croissante pour un job.
 * - Cette fonction protege uniquement une ligne SQL.
 * - Elle ne protege pas directement le fichier MP4.
 * - Elle ne remplace pas le verrou de rendu.
 */

const PUBLISH_SQL = `
UPDATE video_render_jobs
SET published_result = $4
WHERE job_id = $1
  AND owner_id = $2
  AND fencing_token = $3
RETURNING job_id, fencing_token, published_result
`;

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

    if (
      !Number.isSafeInteger(token) ||
      token <= 0
    ) {
      throw new Error("INVALID_FENCING_TOKEN");
    }

    if (
      typeof resultPath !== "string" ||
      !resultPath.trim()
    ) {
      throw new Error("INVALID_RESULT_PATH");
    }

    const result = await db.query(
      PUBLISH_SQL,
      [jobId, ownerId, token, resultPath]
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
      token,
      resultPath
    });
  }

  return Object.freeze({ publish });
}

module.exports = {
  PUBLISH_SQL,
  createFencingPublisher
};

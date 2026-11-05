"use strict";

/*
 * VidéaPilot - Allocateur de jetons de generation.
 *
 * Experimental, non connecte a la production.
 *
 * Schema attendu pour une future integration :
 *
 * CREATE TABLE video_render_jobs (
 *   job_id TEXT PRIMARY KEY,
 *   fencing_token BIGINT NOT NULL
 *     CHECK (fencing_token > 0),
 *   owner_id TEXT NOT NULL,
 *   published_result TEXT
 * );
 *
 * IMPORTANT :
 * Ce commentaire ne cree aucune table.
 *
 * L'instruction SQL utilise un conflit sur job_id
 * pour incrementer atomiquement le jeton.
 *
 * Le jeton maximal ne peut pas etre incremente.
 *
 * La reutilisation ou la suppression de la ligne
 * doit etre interdite pendant la duree de validite
 * des anciens jetons.
 */

const MAX_BIGINT = 9223372036854775807n;

const ACQUIRE_SQL = `
INSERT INTO video_render_jobs (
  job_id,
  fencing_token,
  owner_id,
  published_result
)
VALUES ($1, 1, $2, NULL)
ON CONFLICT (job_id)
DO UPDATE SET
  fencing_token =
    video_render_jobs.fencing_token + 1,
  owner_id = EXCLUDED.owner_id,
  published_result = NULL
WHERE video_render_jobs.fencing_token <
  9223372036854775807::bigint
RETURNING job_id, fencing_token, owner_id
`;

function normalizeReturnedToken(value) {
  let token;

  if (typeof value === "bigint") {
    token = value;
  } else if (typeof value === "string") {
    if (!/^[1-9][0-9]*$/.test(value)) {
      throw new Error("INVALID_ALLOCATED_TOKEN");
    }

    token = BigInt(value);
  } else if (
    typeof value === "number" &&
    Number.isSafeInteger(value)
  ) {
    token = BigInt(value);
  } else {
    throw new Error("INVALID_ALLOCATED_TOKEN");
  }

  if (token <= 0n || token > MAX_BIGINT) {
    throw new Error("INVALID_ALLOCATED_TOKEN");
  }

  return token.toString();
}

function createFencingAllocator(db) {
  if (!db || typeof db.query !== "function") {
    throw new Error("INVALID_FENCING_DB");
  }

  async function acquire(options = {}) {
    const { jobId, ownerId } = options;

    if (typeof jobId !== "string" || !jobId.trim()) {
      throw new Error("INVALID_JOB_ID");
    }

    if (
      typeof ownerId !== "string" ||
      !ownerId.trim()
    ) {
      throw new Error("INVALID_OWNER_ID");
    }

    const result = await db.query(
      ACQUIRE_SQL,
      [jobId, ownerId]
    );

    if (!result || !Array.isArray(result.rows)) {
      throw new Error("INVALID_ALLOCATOR_DB_RESPONSE");
    }

    if (result.rows.length === 0) {
      throw new Error("FENCING_TOKEN_EXHAUSTED");
    }

    if (result.rows.length !== 1) {
      throw new Error("INVALID_ALLOCATOR_ROW_COUNT");
    }

    const row = result.rows[0];

    if (
      row.job_id !== jobId ||
      row.owner_id !== ownerId
    ) {
      throw new Error("INVALID_ALLOCATOR_DB_RESPONSE");
    }

    const token = normalizeReturnedToken(
      row.fencing_token
    );

    return Object.freeze({
      jobId,
      ownerId,
      token
    });
  }

  return Object.freeze({ acquire });
}

module.exports = {
  MAX_BIGINT,
  ACQUIRE_SQL,
  normalizeReturnedToken,
  createFencingAllocator
};

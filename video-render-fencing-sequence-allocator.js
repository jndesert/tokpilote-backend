"use strict";

/*
 * VidéaPilot - Allocation experimentale par sequence PostgreSQL.
 *
 * Aucune connexion reelle a PostgreSQL.
 *
 * Schema SQL propose, NON EXECUTE :
 *
 * CREATE SEQUENCE video_render_fencing_seq
 *   AS bigint
 *   START WITH 1
 *   INCREMENT BY 1
 *   MINVALUE 1
 *   MAXVALUE 9223372036854775807
 *   NO CYCLE
 *   CACHE 1;
 *
 * Prerequis :
 * - sequence creee et protegee contre les resets ;
 * - table video_render_jobs existante ;
 * - job_id PRIMARY KEY ;
 * - fencing_token BIGINT NOT NULL ;
 * - owner_id TEXT NOT NULL ;
 * - published_result TEXT ;
 *
 * La condition ON CONFLICT evite qu'un jeton
 * plus ancien remplace un jeton plus recent,
 * meme si les requetes terminent dans le
 * desordre.
 *
 * IMPORTANT :
 * Une sequence ne remplace pas les protections
 * contre les restaurations, les resets,
 * les erreurs de bascule ou les pertes de donnees.
 */

const ACQUIRE_SQL = `
INSERT INTO video_render_jobs (
  job_id,
  fencing_token,
  owner_id,
  published_result
)
VALUES (
  $1,
  nextval('video_render_fencing_seq'),
  $2,
  NULL
)
ON CONFLICT (job_id)
DO UPDATE SET
  fencing_token = EXCLUDED.fencing_token,
  owner_id = EXCLUDED.owner_id,
  published_result = NULL
WHERE video_render_jobs.fencing_token <
  EXCLUDED.fencing_token
RETURNING job_id, fencing_token, owner_id
`;

const MAX_BIGINT = 9223372036854775807n;

function normalizeToken(value) {
  let token;

  if (typeof value === "string") {
    if (!/^[1-9][0-9]*$/.test(value)) {
      throw new Error("INVALID_ALLOCATED_TOKEN");
    }
    token = BigInt(value);
  } else if (typeof value === "bigint") {
    token = value;
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

function createSequenceAllocator(db) {
  if (!db || typeof db.query !== "function") {
    throw new Error("INVALID_FENCING_DB");
  }

  async function acquire(options = {}) {
    const { jobId, ownerId } = options;

    if (typeof jobId !== "string" || !jobId.trim()) {
      throw new Error("INVALID_JOB_ID");
    }

    if (typeof ownerId !== "string" || !ownerId.trim()) {
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
      throw new Error("STALE_FENCING_ALLOCATION");
    }

    if (result.rows.length !== 1) {
      throw new Error("INVALID_ALLOCATOR_ROW_COUNT");
    }

    const row = result.rows[0];

    if (
      !row ||
      row.job_id !== jobId ||
      row.owner_id !== ownerId
    ) {
      throw new Error("INVALID_ALLOCATOR_DB_RESPONSE");
    }

    return Object.freeze({
      jobId,
      ownerId,
      token: normalizeToken(row.fencing_token)
    });
  }

  return Object.freeze({ acquire });
}

module.exports = {
  ACQUIRE_SQL,
  MAX_BIGINT,
  normalizeToken,
  createSequenceAllocator
};

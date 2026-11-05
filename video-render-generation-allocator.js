"use strict";

const { randomUUID } = require("node:crypto");

const {
  validateGenerationId
} = require("./video-render-generation-guard");

/*
 * VidéaPilot - Allocation experimentale avec UUID.
 *
 * SQL prepare uniquement : aucune execution reelle.
 *
 * Schema futur attendu :
 * - job_id TEXT PRIMARY KEY
 * - fencing_token BIGINT NOT NULL
 * - owner_id TEXT NOT NULL
 * - generation_id UUID NOT NULL
 * - published_result TEXT
 *
 * La sequence globale doit exister, etre protegee
 * et ne jamais etre reinitialisee.
 *
 * L'UUID est genere avant la requete.
 * Le jeton est attribue par nextval().
 *
 * Une acquisition obsolete ne peut pas remplacer
 * une ligne contenant un jeton superieur.
 */

const ACQUIRE_SQL = `
INSERT INTO video_render_jobs (
  job_id,
  fencing_token,
  owner_id,
  generation_id,
  published_result
)
VALUES (
  $1,
  nextval('video_render_fencing_seq'),
  $2,
  $3::uuid,
  NULL
)
ON CONFLICT (job_id)
DO UPDATE SET
  fencing_token = EXCLUDED.fencing_token,
  owner_id = EXCLUDED.owner_id,
  generation_id = EXCLUDED.generation_id,
  published_result = NULL
WHERE video_render_jobs.fencing_token <
  EXCLUDED.fencing_token
RETURNING
  job_id,
  fencing_token,
  owner_id,
  generation_id
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

function createGenerationAllocator(db) {
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

    const generationId = randomUUID();

    const result = await db.query(
      ACQUIRE_SQL,
      [jobId, ownerId, generationId]
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
      row.owner_id !== ownerId ||
      typeof row.generation_id !== "string" ||
      row.generation_id.toLowerCase() !== generationId
    ) {
      throw new Error("INVALID_ALLOCATOR_DB_RESPONSE");
    }

    return Object.freeze({
      jobId,
      ownerId,
      token: normalizeToken(row.fencing_token),
      generationId: validateGenerationId(
        row.generation_id
      )
    });
  }

  return Object.freeze({ acquire });
}

module.exports = {
  ACQUIRE_SQL,
  normalizeToken,
  createGenerationAllocator
};

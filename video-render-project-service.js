"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const {
  FIND_PROJECT_SCENES_FOR_RENDER
} = require("./video-render-integrity-v2");

const {
  prepareDatabaseRenderScenesSecure
} = require("./video-render-db-bridge-secure");

const {
  renderVideo
} = require("./video-renderer");

const {
  withSecureImageSnapshots
} = require("./video-render-snapshot-secure");

function validateRenderIdentity(projectId, userId) {
  if (
    !/^[1-9]\d*$/.test(String(projectId)) ||
    !Number.isSafeInteger(Number(projectId))
  ) {
    throw new Error("INVALID_PROJECT_ID");
  }

  if (
    typeof userId !== "string" ||
    userId.trim().length === 0
  ) {
    throw new Error("INVALID_USER_ID");
  }
}

const {
  createRenderConcurrencyGuard
} = require("./video-render-concurrency");

const renderGuard = createRenderConcurrencyGuard();
async function renderProjectVideo(options = {}) {
  const {
    pool,
    projectId,
    userId,
    imageDirectory,
    outputDirectory
  } = options;

  if (!pool || typeof pool.query !== "function") {
    throw new Error("DATABASE_UNAVAILABLE");
  }

  validateRenderIdentity(projectId, userId);

  if (
    typeof outputDirectory !== "string" ||
    !path.isAbsolute(outputDirectory)
  ) {
    throw new Error("INVALID_OUTPUT_DIRECTORY");
  }

  // Verifier explicitement le proprietaire du projet.
  const projectResult = await pool.query(
    `
    SELECT id
    FROM video_projects
    WHERE id = $1 AND user_id = $2
    `,
    [projectId, userId]
  );

  if (projectResult.rows.length !== 1) {
    throw new Error("PROJECT_NOT_FOUND");
  }

  // Recuperer uniquement les scenes de ce projet
  // et les images associees au bon utilisateur.
  const sceneResult = await pool.query(
    FIND_PROJECT_SCENES_FOR_RENDER,
    [projectId, userId]
  );

  // Le verrou protege la preparation et le rendu MP4.
  const { prepared, result, outputName } = await renderGuard.run(
    async () => {
      // Verifier les chemins, tailles, dimensions et decodage.
      const prepared = await prepareDatabaseRenderScenesSecure(
        sceneResult.rows,
        { imageDirectory }
      );

      // Verifier le dossier de sortie avant le rendu.
      const outputRoot = fs.realpathSync(outputDirectory);

      if (!fs.statSync(outputRoot).isDirectory()) {
        throw new Error("INVALID_OUTPUT_DIRECTORY");
      }

      const outputName = `videapilot_${randomUUID()}.mp4`;
      const outputPath = path.join(outputRoot, outputName);

      // FFmpeg utilise uniquement les copies validees.
      // Les copies sont supprimees apres le rendu.
      const result = await withSecureImageSnapshots(
        prepared.scenes,
        async snapshotScenes => {
          return renderVideo({
            scenes: snapshotScenes,
            outputPath,
            width: 1080,
            height: 1920,
            fps: 30
          });
        }
      );

      return { prepared, result, outputName };
    }
  );

  // Ne pas retourner le chemin absolu du serveur.
  return {
    success: result.success,
    videoId: path.basename(outputName, ".mp4"),
    fileName: outputName,
    sceneCount: prepared.sceneCount,
    totalDurationSeconds: prepared.totalDurationSeconds,
    sizeBytes: result.sizeBytes,
    format: "mp4"
  };
}

module.exports = {
  validateRenderIdentity,
  renderProjectVideo
};

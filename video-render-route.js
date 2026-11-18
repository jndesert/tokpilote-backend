"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { renderProjectVideo } = require("./video-render-project-service");
const { uploadRenderedMp4 } = require("./video-render-mp4-storage-adapter");
const { validateStorageMetadata } = require("./video-render-storage-metadata");
const { selectDownloadStorage } = require("./video-render-download-storage-selector");
const { downloadRenderedMp4 } = require("./video-render-mp4-storage-adapter");
const { prepareR2Mp4Response } = require("./video-render-r2-http-response");
const { mapRenderErrorToHttp } = require("./video-render-http-errors");
const {
  createDownloadTokenAdapter
} = require("./video-render-download-token-adapter");

function localRenderAuthorized(req) {
  if (process.env.NODE_ENV === "production" ||
      process.env.VIDEO_RENDER_ENABLED !== "true" ||
      process.env.VIDEO_RENDER_LOCAL_TEST !== "true") return false;
  const host = req.get("Host") || "";
  const origin = req.get("Origin") || "";
  // Local-only: no remote host and no cross-origin rendering.
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress) &&
    /^(localhost|127\.0\.0\.1):[0-9]{1,5}$/.test(host) &&
    (req.method === "GET" && !origin ||
     origin === "http://" + host || origin === "https://" + host);
}

function productionRenderReadAuthorized(req) {
  const origin = req.get("Origin");
  const site = req.get("Sec-Fetch-Site");
  return process.env.VIDEO_MVP_ENABLED === "true" &&
    process.env.NODE_ENV === "production" &&
    process.env.VIDEO_RENDER_ENABLED === "true" &&
    process.env.VIDEO_RENDER_PRODUCTION_ENABLED === "true" &&
    req.secure && "https://" + req.get("Host") === process.env.VIDEO_RENDER_ALLOWED_ORIGIN &&
    (!origin || origin === process.env.VIDEO_RENDER_ALLOWED_ORIGIN) &&
    (!site || ["same-origin", "none"].includes(site));
}


function productionRenderAuthorized(req) {
  if (
    process.env.NODE_ENV !== "production" ||
    process.env.VIDEO_RENDER_ENABLED !== "true" ||
    process.env.VIDEO_RENDER_PRODUCTION_ENABLED !== "true"
  ) {
    return false;
  }

  const configuredOrigin =
    process.env.VIDEO_RENDER_ALLOWED_ORIGIN;

  if (typeof configuredOrigin !== "string") {
    return false;
  }

  let parsed;

  try {
    parsed = new URL(configuredOrigin);
  } catch {
    return false;
  }

  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== configuredOrigin
  ) {
    return false;
  }
  if (!req.secure || "https://" + req.get("Host") !== configuredOrigin) return false;

  const origin = req.get("Origin");

  if (
    typeof origin !== "string" ||
    origin !== configuredOrigin
  ) {
    return false;
  }

  const rawHeaders = req.rawHeaders;

  if (!Array.isArray(rawHeaders)) {
    return false;
  }

  let originCount = 0;

  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (
      typeof rawHeaders[i] === "string" &&
      rawHeaders[i].toLowerCase() === "origin"
    ) {
      originCount++;
    }
  }

  if (originCount !== 1) {
    return false;
  }

  const fetchSite = req.get("Sec-Fetch-Site");
  const fetchMode = req.get("Sec-Fetch-Mode");

  // Rejeter explicitement les requetes intersites.
  if (
    fetchSite !== undefined &&
    fetchSite !== "same-origin"
  ) {
    return false;
  }

  // Refuser les contextes de navigation non attendus.
  if (
    fetchMode !== undefined &&
    fetchMode !== "cors" &&
    fetchMode !== "same-origin"
  ) {
    return false;
  }

  return true;
}

function registerVideoRenderRoute(app, pool) {
  if (!app || !pool) {
    throw new Error("RENDER_ROUTE_DEPENDENCIES_MISSING");
  }

  const completedRenders = new Map();
  const DOWNLOAD_TOKEN_TTL_MS = 15 * 60 * 1000;

  function cleanupExpiredDownloadTokens(now = Date.now()) {
    let removed = 0;

    for (const [token, entry] of completedRenders) {
      if (
        !entry ||
        !Number.isSafeInteger(entry.expiresAt) ||
        now >= entry.expiresAt
      ) {
        completedRenders.delete(token);
        removed++;
      }
    }

    return removed;
  }
  const activeRenders = new Set();

  // Adaptateur preparatoire : stockage memoire uniquement.
  // Les routes existantes conservent completedRenders.
  // Preparation uniquement : PostgreSQL reste verrouille.
  const postgresTokenStorageAllowed = false;
  const requestedTokenStorageMode =
    process.env.VIDEO_RENDER_TOKEN_STORAGE === "postgres"
      ? "postgres" : "memory";

  const downloadTokenStorageMode =
    postgresTokenStorageAllowed &&
    requestedTokenStorageMode === "postgres"
      ? "postgres" : "memory";

  const downloadTokenAdapter = createDownloadTokenAdapter({
    pool,
    mode: downloadTokenStorageMode,
    allowPostgres: postgresTokenStorageAllowed,
    memoryStore: {
      async createToken({ projectId, userId, fileName, storage = null }) {
        const token = randomUUID();

        const validatedStorage = validateStorageMetadata(
          storage || { mode: "local", fileName }
        );

        completedRenders.set(token, {
          projectId,
          userId,
          fileName: validatedStorage.fileName,
          storage: validatedStorage,
          expiresAt: Date.now() + DOWNLOAD_TOKEN_TTL_MS
        });

        return {
          token,
          expiresAt: new Date(
            completedRenders.get(token).expiresAt
          )
        };
      },

      async findToken(token, userId) {
        const entry = completedRenders.get(token);

        if (!entry || entry.userId !== userId) {
          return null;
        }

        if (
          !Number.isSafeInteger(entry.expiresAt) ||
          Date.now() >= entry.expiresAt
        ) {
          completedRenders.delete(token);
          return null;
        }

        return entry;
      },

      async deleteToken(token, userId) {
        const entry = completedRenders.get(token);

        if (!entry || entry.userId !== userId) {
          return 0;
        }

        completedRenders.delete(token);
        return 1;
      },

      async cleanupExpiredTokens() {
        return cleanupExpiredDownloadTokens();
      }
    }
  });

  if (
    downloadTokenAdapter.mode !== "memory" &&
    !(
      postgresTokenStorageAllowed === true &&
      downloadTokenAdapter.mode === "postgres"
    )
  ) {
    throw new Error("UNEXPECTED_TOKEN_STORAGE_MODE");
  }

  app.get("/api/videos/render/status", (req, res) => {
    res.set("Cache-Control", "no-store");
    const enabled = Boolean(req.session?.tiktokUser?.openId) &&
      (localRenderAuthorized(req) || productionRenderReadAuthorized(req));
    return res.json({
      enabled,
      mvpEnabled: enabled && process.env.VIDEO_MVP_ENABLED === "true",
      productionAuthorizationReady:
        Boolean(req.session?.tiktokUser?.openId) &&
        productionRenderAuthorized(req)
    });
  });

  app.get("/api/videos/render/download/:token", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const userId = req.session?.tiktokUser?.openId;
    if (!userId) return res.status(401).json({success:false,error:"TIKTOK_LOGIN_REQUIRED"});
    if (!localRenderAuthorized(req) && !productionRenderReadAuthorized(req)) {
      return res.status(403).json({success:false,error:"DOWNLOAD_NOT_AUTHORIZED"});
    }
    let entry;

    try {
      entry = await downloadTokenAdapter.findToken(
        req.params.token,
        userId
      );
    } catch (_) {
      return res.status(404).json({
        success: false,
        error: "VIDEO_NOT_FOUND"
      });
    }

    if (!entry) {
      return res.status(404).json({
        success: false,
        error: "VIDEO_NOT_FOUND"
      });
    }

    // Le stockage distant reste explicitement interdit.
    const r2DownloadAllowed = false;
    let downloadStorage;

    try {
      downloadStorage = selectDownloadStorage({
        entry,
        allowR2: r2DownloadAllowed
      });
    } catch (_) {
      return res.status(404).json({
        success: false,
        error: "VIDEO_NOT_FOUND"
      });
    }


    try {
      const owner = await pool.query(
        "SELECT p.id, to_jsonb(p)->>'mvp_local_images' AS mvp_local_images FROM video_projects p WHERE p.id = $1 AND p.user_id = $2",
        [entry.projectId, userId]
      );
      if (owner.rows.length !== 1) return res.status(404).json({success:false,error:"VIDEO_NOT_FOUND"});

      // Parcours R2 prepare, mais inaccessible tant que
      // r2DownloadAllowed reste strictement false.
      if (downloadStorage.mode === "r2") {
        if (r2DownloadAllowed !== true) {
          return res.status(404).json({success:false,error:"VIDEO_NOT_FOUND"});
        }

        const stored = await downloadRenderedMp4({
          key: downloadStorage.key,
          enabled: r2DownloadAllowed
        });

        const prepared = prepareR2Mp4Response({
          stored,
          fileName: downloadStorage.fileName,
          key: downloadStorage.key
        });

        for (const [name, value] of Object.entries(prepared.headers)) {
          res.set(name, value);
        }

        return res.status(prepared.statusCode).send(prepared.body);
      }

      if (downloadStorage.mode !== "local") {
        return res.status(404).json({success:false,error:"VIDEO_NOT_FOUND"});
      }
      const outputDirectory = owner.rows[0].mvp_local_images === "true"
        ? (process.env.VIDEO_MVP_OUTPUT_DIRECTORY || process.env.VIDEO_OUTPUT_DIRECTORY)
        : process.env.VIDEO_OUTPUT_DIRECTORY;
      const root = fs.realpathSync(outputDirectory);
      const file = path.join(root, entry.fileName);
      const realFile = fs.realpathSync(file);

      if (
        path.dirname(realFile) !== root ||
        !fs.statSync(realFile).isFile()
      ) {
        return res.status(404).json({
          success: false,
          error: "VIDEO_NOT_FOUND"
        });
      }

      if (req.query.preview === "1") {
        res.type("mp4");
        return res.sendFile(realFile);
      }
      return res.download(realFile, entry.fileName);
    } catch (_) {
      return res.status(404).json({success:false,error:"VIDEO_NOT_FOUND"});
    }
  });

  app.post("/api/videos/render", async (req, res) => {
    res.set("Cache-Control", "no-store");

    // Fonction desactivee par defaut.
    if (process.env.VIDEO_RENDER_ENABLED !== "true") {
      return res.status(503).json({
        success: false,
        error: "VIDEO_RENDER_DISABLED"
      });
    }

    const production = process.env.NODE_ENV === "production";
    if (!production && process.env.VIDEO_RENDER_LOCAL_TEST !== "true") {
      return res.status(503).json({
        success: false,
        error: "VIDEO_RENDER_LOCAL_TEST_DISABLED"
      });
    }

    if (production && (process.env.VIDEO_MVP_ENABLED !== "true" ||
      process.env.VIDEO_RENDER_PRODUCTION_ENABLED !== "true")) {
      return res.status(503).json({
        success: false,
        error: "VIDEO_RENDER_PRODUCTION_NOT_ENABLED"
      });
    }
    if (!(production ? productionRenderAuthorized(req) : localRenderAuthorized(req))) {
      return res.status(403).json({ success: false, error: "ORIGIN_NOT_ALLOWED" });
    }

    // Verifier la session TikTok.
    const userId = req.session?.tiktokUser?.openId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "TIKTOK_LOGIN_REQUIRED"
      });
    }

    // Accepter projectId et un mode de rendu facultatif.
    // Le mode classique reste le comportement par defaut.
    const body = req.body;

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !Object.prototype.hasOwnProperty.call(body, "projectId") ||
      Object.keys(body).length < 1 ||
      Object.keys(body).length > 2 ||
      Object.keys(body).some(
        key => key !== "projectId" && key !== "renderMode"
      )
    ) {
      return res.status(400).json({
        success: false,
        error: "INVALID_RENDER_REQUEST"
      });
    }

    const { projectId } = body;

    const renderMode =
      Object.prototype.hasOwnProperty.call(body, "renderMode")
        ? body.renderMode
        : "classic";

    if (
      renderMode !== "classic" &&
      renderMode !== "leo-lip-sync"
    ) {
      return res.status(400).json({
        success: false,
        error: "INVALID_RENDER_MODE"
      });
    }


    if (
      (typeof projectId !== "string" &&
        typeof projectId !== "number") ||
      (typeof projectId === "number" &&
        !Number.isSafeInteger(projectId)) ||
      !/^[1-9]\d*$/.test(String(projectId)) ||
      !Number.isSafeInteger(Number(projectId))
    ) {
      return res.status(400).json({
        success: false,
        error: "INVALID_PROJECT_ID"
      });
    }

    try {
      const projectResult = await pool.query(
        `
        SELECT p.id, to_jsonb(p)->>'mvp_local_images' AS mvp_local_images,
               to_jsonb(p)->>'narration_file_name' AS narration_file_name
        FROM video_projects p
        WHERE p.id = $1 AND p.user_id = $2
        `,
        [projectId, userId]
      );

      if (projectResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "PROJECT_NOT_FOUND"
        });
      }

      // Mode Léo : préparation expérimentale, sans rendu MP4.
      if (renderMode === "leo-lip-sync") {
        if (
          process.env.NODE_ENV === "test" &&
          process.env.LEO_ANIMATION_PREPARATION_TEST_ENABLED === "true"
        ) {
          const { prepareLeoRenderIntegration } = require("./leo-render-integration-36-231-43");
          const { prepareLeoBackendRenderBridge } = require("./leo-backend-render-bridge-36-231-55");
          const leoPreparation = prepareLeoRenderIntegration();

          if (
            leoPreparation.executionAllowed !== false ||
            leoPreparation.frameCount !== 288 ||
            leoPreparation.fps !== 30
          ) {
            throw new Error("LEO_PREPARATION_INVALID");
          }

          // Preparation MP4 experimentale apres verification du projet.
          // Aucune execution FFmpeg n'est autorisee.
          const leoBridge = prepareLeoBackendRenderBridge({
            renderMode: "leo-lip-sync",
            projectAuthorized: true
          });

          if (
            leoBridge.executionAllowed !== false ||
            leoBridge.frameCount !== leoPreparation.frameCount ||
            leoBridge.fps !== leoPreparation.fps ||
            leoBridge.durationSeconds !== leoPreparation.durationSeconds
          ) {
            throw new Error("LEO_BACKEND_BRIDGE_INVALID");
          }
        }

        return res.status(503).json({
          success: false,
          error: "VIDEO_LIP_SYNC_NOT_READY"
        });
      }
      // Source des images configuree uniquement par le serveur.
      const manualProject = projectResult.rows[0].mvp_local_images === "true";
      const imageSource =
        !manualProject && process.env.VIDEO_RENDER_IMAGE_SOURCE === "s3"
          ? "s3"
          : "local";

      if (
        imageSource === "s3" &&
        process.env.MEDIA_STORAGE_ENABLED !== "true"
      ) {
        return res.status(503).json({
          success: false,
          error: "VIDEO_RENDER_S3_STORAGE_DISABLED"
        });
      }

      const imageDirectory = manualProject
        ? (process.env.VIDEO_MVP_IMAGE_DIRECTORY || process.env.VIDEO_IMAGE_DIRECTORY)
        : process.env.VIDEO_IMAGE_DIRECTORY;
      const outputDirectory = manualProject
        ? (process.env.VIDEO_MVP_OUTPUT_DIRECTORY || process.env.VIDEO_OUTPUT_DIRECTORY)
        : process.env.VIDEO_OUTPUT_DIRECTORY;

      if (
        (imageSource === "local" && (
          typeof imageDirectory !== "string" ||
          !path.isAbsolute(imageDirectory)
        )) ||
        typeof outputDirectory !== "string" ||
        !path.isAbsolute(outputDirectory)
      ) {
        return res.status(503).json({
          success: false,
          error: "VIDEO_RENDER_STORAGE_NOT_CONFIGURED"
        });
      }

      const projectNarration = projectResult.rows[0].narration_file_name;
      const localAudioEnabled = Boolean(projectNarration) ||
        (!manualProject &&
          process.env.VIDEO_RENDER_LOCAL_AUDIO_ENABLED === "true");
      const audioDirectory = !localAudioEnabled ? null : manualProject
        ? (process.env.VIDEO_MVP_AUDIO_DIRECTORY || process.env.VIDEO_AUDIO_DIRECTORY)
        : process.env.VIDEO_AUDIO_DIRECTORY;
      const audioFileName = localAudioEnabled
        ? (projectNarration || process.env.VIDEO_AUDIO_FILE_NAME) : null;

      if (localAudioEnabled && (
        typeof audioDirectory !== "string" ||
        !path.isAbsolute(audioDirectory) ||
        typeof audioFileName !== "string" ||
        !/^[a-zA-Z0-9_-]+\.(wav|mp3|m4a)$/i.test(audioFileName)
      )) {
        return res.status(503).json({
          success: false,
          error: "VIDEO_AUDIO_STORAGE_NOT_CONFIGURED"
        });
      }

      if (activeRenders.has(userId)) {
        return res.status(429).json({
          success: false,
          error: "VIDEO_RENDER_ALREADY_RUNNING"
        });
      }

      activeRenders.add(userId);

      try {
        const result = await renderProjectVideo({
          pool,
          projectId,
          userId,
          imageSource,
          manualProject,
          imageDirectory,
          outputDirectory,
          audioDirectory,
          audioFileName
        });

        // Stockage local par defaut.
        // Le stockage R2 reste explicitement desactive.
        const mp4R2StorageAllowed = false;

        let storage = validateStorageMetadata({
          mode: "local",
          fileName: result.fileName
        });

        if (mp4R2StorageAllowed) {
          const uploaded = await uploadRenderedMp4({
            outputDirectory,
            fileName: result.fileName,
            enabled: mp4R2StorageAllowed
          });

          storage = validateStorageMetadata({
            mode: "r2",
            fileName: result.fileName,
            key: uploaded.key
          });
        }

        await downloadTokenAdapter.cleanupExpiredTokens();

        const { token } = await downloadTokenAdapter.createToken({
          userId,
          projectId: Number(projectId),
          fileName: result.fileName,
          storage
        });
        // Les jetons ne survivent pas au redemarrage du serveur local.
        return res.status(200).json({
          ...result,
          downloadUrl: "/api/videos/render/download/" + token
        });
      } catch (renderError) {
        const mapped = mapRenderErrorToHttp(renderError);
        return res.status(mapped.status).json(mapped.body);
      } finally {
        activeRenders.delete(userId);
      }

    } catch (error) {
      console.error(
        "Erreur verification projet pour rendu :",
        error.message
      );

      return res.status(503).json({
        success: false,
        error: "PROJECT_LOOKUP_UNAVAILABLE"
      });
    }
  });
}

module.exports = {
  registerVideoRenderRoute,
  localRenderAuthorized,
  productionRenderAuthorized,
  productionRenderReadAuthorized
};

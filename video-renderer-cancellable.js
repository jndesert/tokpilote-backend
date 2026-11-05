"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomUUID } = require("node:crypto");

const execFileAsync = promisify(execFile);

// VidéaPilot — Moteur de rendu vidéo FFmpeg.
// Module indépendant du moteur de préparation existant.

const VIDEO_RENDERER_CONFIG = {
  enabled: false,
  provider: "ffmpeg",
  outputFormat: "mp4",
  videoCodec: "libx264",
  pixelFormat: "yuv420p",
  defaultWidth: 1080,
  defaultHeight: 1920,
  defaultFps: 30
};

// Vérifier la disponibilité de FFmpeg.
async function checkFfmpeg() {
  try {
    const { stdout } = await execFileAsync(
      "ffmpeg",
      ["-version"],
      { timeout: 10000, windowsHide: true }
    );

    const version = stdout.split(/\r?\n/)[0];

    return {
      available: true,
      version,
      error: null
    };

  } catch (error) {
    return {
      available: false,
      version: null,
      error: error.message
    };
  }
}

module.exports = {
  VIDEO_RENDERER_CONFIG,
  checkFfmpeg
};

// Générer un fichier MP4 à partir des scènes illustrées.
async function renderVideo(options = {}) {
  const {
    scenes,
    outputPath,
    width = VIDEO_RENDERER_CONFIG.defaultWidth,
    height = VIDEO_RENDERER_CONFIG.defaultHeight,
    fps = VIDEO_RENDERER_CONFIG.defaultFps,
    signal
  } = options;

  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error("Aucune scène fournie.");
  }

  if (
    !Number.isInteger(width) || width <= 0 ||
    !Number.isInteger(height) || height <= 0 ||
    !Number.isInteger(fps) || fps <= 0
  ) {
    throw new Error("Paramètres vidéo invalides.");
  }

  if (typeof outputPath !== "string" || !outputPath.trim()) {
    throw new Error("Chemin de sortie invalide.");
  }

  if (
    signal !== undefined &&
    (
      !signal ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function"
    )
  ) {
    throw new Error("INVALID_RENDER_ABORT_SIGNAL");
  }

  if (signal?.aborted) {
    throw signal.reason || new Error("RENDER_CANCELLED");
  }

  const destination = path.resolve(outputPath);

  if (fs.existsSync(destination)) {
    throw new Error("Le fichier de sortie existe déjà.");
  }

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];

    if (
      typeof scene.image !== "string" ||
      !path.isAbsolute(scene.image) ||
      !fs.existsSync(scene.image) ||
      !fs.statSync(scene.image).isFile()
    ) {
      throw new Error(`Image invalide pour la scène ${i + 1}.`);
    }

    if (
      !Number.isFinite(scene.durationSeconds) ||
      scene.durationSeconds <= 0
    ) {
      throw new Error(`Durée invalide pour la scène ${i + 1}.`);
    }
  }

  const dossierSortie = path.dirname(destination);
  fs.mkdirSync(dossierSortie, { recursive: true });

  const temporaryPath = path.join(
    dossierSortie,
    `videapilot_${process.pid}_${randomUUID()}.mp4`
  );

  const args = ["-hide_banner", "-loglevel", "error"];

  for (const scene of scenes) {
    args.push(
      "-loop", "1",
      "-framerate", String(fps),
      "-t", String(scene.durationSeconds),
      "-i", scene.image
    );
  }

  const filters = scenes.map((scene, index) =>
    `[${index}:v]fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${index}]`
  );

  const inputs = scenes.map(
    (_, index) => `[v${index}]`
  ).join("");

  filters.push(
    `${inputs}concat=n=${scenes.length}:v=1:a=0[v]`
  );

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[v]",
    "-c:v", VIDEO_RENDERER_CONFIG.videoCodec,
    "-preset", "ultrafast",
    "-pix_fmt", VIDEO_RENDERER_CONFIG.pixelFormat,
    "-movflags", "+faststart",
    "-y",
    temporaryPath
  );

  try {
    await execFileAsync("ffmpeg", args, {
      timeout: 300000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      signal
    });

    if (
      !fs.existsSync(temporaryPath) ||
      fs.statSync(temporaryPath).size === 0
    ) {
      throw new Error("Le fichier MP4 généré est vide.");
    }

    if (signal?.aborted) {
      throw signal.reason || new Error("RENDER_CANCELLED");
    }

    fs.renameSync(temporaryPath, destination);

    return {
      success: true,
      outputPath: destination,
      sizeBytes: fs.statSync(destination).size,
      sceneCount: scenes.length,
      format: "mp4"
    };

  } catch (error) {
    let cleanupError = null;

    // Nettoyer uniquement le fichier temporaire de ce rendu.
    // Les erreurs EBUSY et EPERM peuvent etre transitoires.
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        await fs.promises.unlink(temporaryPath);
        cleanupError = null;
        break;
      } catch (unlinkError) {
        if (unlinkError.code === "ENOENT") {
          cleanupError = null;
          break;
        }

        cleanupError = unlinkError;

        const retryable =
          unlinkError.code === "EBUSY" ||
          unlinkError.code === "EPERM";

        if (!retryable || attempt === 10) {
          break;
        }

        await new Promise(resolve =>
          setTimeout(resolve, 200)
        );
      }
    }

    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "RENDER_FAILED_AND_TEMP_CLEANUP_FAILED"
      );
    }

    throw error;
  }
}

module.exports.renderVideo = renderVideo;

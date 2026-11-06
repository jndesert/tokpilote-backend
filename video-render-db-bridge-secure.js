"use strict";

const {
  prepareDatabaseRenderScenes
} = require("./video-render-db-bridge");

const {
  validateImageDimensions
} = require("./video-image-dimensions");

const {
  validateImageDecoding
} = require("./video-image-decoder");

const {
  validateImageSignature
} = require("./video-image-signature");

async function prepareDatabaseRenderScenesSecure(
  rows,
  options = {}
) {
  // 1. Verifier les donnees, chemins et tailles.
  const prepared = prepareDatabaseRenderScenes(
    rows,
    options
  );

  // 2. Controler chaque image avant le rendu.
  for (let i = 0; i < prepared.scenes.length; i++) {
    const scene = prepared.scenes[i];
    const row = rows[i];

    // Refuser les fichiers dont la signature est invalide.
    validateImageSignature(
      scene.image,
      row.mime_type
    );

    // Refuser les dimensions excessives.
    await validateImageDimensions(scene.image, {
      ffprobePath: options.ffprobePath || "ffprobe"
    });

    // Verifier la signature et le decodage reel.
    await validateImageDecoding(
      scene.image,
      row.mime_type,
      {
        ffmpegPath: options.ffmpegPath || "ffmpeg"
      }
    );
  }

  return prepared;
}

module.exports = {
  prepareDatabaseRenderScenesSecure
};

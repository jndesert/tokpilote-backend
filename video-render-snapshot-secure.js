"use strict";

const path = require("node:path");

const {
  withImageSnapshots
} = require("./video-render-image-snapshot");

const {
  validateImageDimensions
} = require("./video-image-dimensions");

const {
  validateImageDecoding
} = require("./video-image-decoder");

function getExpectedMime(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".png") {
    return "image/png";
  }

  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }

  throw new Error("INVALID_SNAPSHOT_EXTENSION");
}

async function withSecureImageSnapshots(
  scenes,
  callback,
  options = {}
) {
  if (typeof callback !== "function") {
    throw new Error("INVALID_SNAPSHOT_CALLBACK");
  }

  return withImageSnapshots(
    scenes,
    async snapshotScenes => {

      // Toutes les copies doivent etre validees
      // avant de lancer le traitement.
      for (const scene of snapshotScenes) {
        const expectedMime = getExpectedMime(scene.image);

        await validateImageDimensions(scene.image, {
          ffprobePath: options.ffprobePath ?? "ffprobe"
        });

        await validateImageDecoding(
          scene.image,
          expectedMime,
          {
            ffmpegPath: options.ffmpegPath ?? "ffmpeg"
          }
        );
      }

      // Le traitement ne demarre qu'apres validation.
      return callback(snapshotScenes);
    }
  );
}

module.exports = {
  withSecureImageSnapshots
};

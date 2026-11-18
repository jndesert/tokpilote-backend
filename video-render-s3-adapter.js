"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { downloadMedia } = require("./media-storage");
const {
  validateProjectScenesForRender
} = require("./video-render-integrity-v2");

async function withS3RenderImages(rows, callback) {
  if (typeof callback !== "function") {
    throw new Error("INVALID_RENDER_CALLBACK");
  }

  validateProjectScenesForRender(rows);

  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "videapilot-render-")
  );

  try {
    const preparedRows = [];

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];

      const media = await downloadMedia({
        key: row.storage_key,
        contentType: row.mime_type
      });

      if (media.sizeBytes !== Number(row.size_bytes)) {
        throw new Error("IMAGE_SIZE_MISMATCH");
      }

      const extension =
        row.mime_type === "image/png" ? ".png" : ".jpg";

      const localName =
        "scene_" + String(index + 1).padStart(3, "0") + extension;

      await fs.writeFile(
        path.join(temporaryDirectory, localName),
        media.body,
        { flag: "wx", mode: 0o600 }
      );

      preparedRows.push({
        ...row,
        storage_key: localName
      });
    }

    return await callback({
      rows: preparedRows,
      imageDirectory: temporaryDirectory
    });

  } finally {
    await fs.rm(temporaryDirectory, {
      recursive: true,
      force: true
    });
  }
}

module.exports = {
  withS3RenderImages
};

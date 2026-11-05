"use strict";

const fs = require("node:fs");

function detectImageMime(filePath) {
  const fd = fs.openSync(filePath, "r");

  try {
    const stats = fs.fstatSync(fd);

    if (!stats.isFile() || stats.size < 4) {
      return null;
    }

    const header = Buffer.alloc(24);
    const headerLength = fs.readSync(
      fd,
      header,
      0,
      header.length,
      0
    );

    // PNG : signature officielle + premier bloc IHDR.
    const pngSignature = Buffer.from(
      "89504e470d0a1a0a",
      "hex"
    );

    if (
      headerLength >= 24 &&
      header.subarray(0, 8).equals(pngSignature) &&
      header.readUInt32BE(8) === 13 &&
      header.toString("ascii", 12, 16) === "IHDR"
    ) {
      const footer = Buffer.alloc(12);

      const footerLength = fs.readSync(
        fd,
        footer,
        0,
        footer.length,
        stats.size - 12
      );

      if (
        footerLength === 12 &&
        footer.readUInt32BE(0) === 0 &&
        footer.toString("ascii", 4, 8) === "IEND" &&
        footer.toString("hex", 8, 12) === "ae426082"
      ) {
        return "image/png";
      }
    }

    // JPEG : marqueur SOI et marqueur EOI.
    if (
      headerLength >= 3 &&
      header[0] === 0xff &&
      header[1] === 0xd8 &&
      header[2] === 0xff
    ) {
      const footer = Buffer.alloc(2);

      const footerLength = fs.readSync(
        fd,
        footer,
        0,
        2,
        stats.size - 2
      );

      if (
        footerLength === 2 &&
        footer[0] === 0xff &&
        footer[1] === 0xd9
      ) {
        return "image/jpeg";
      }
    }

    return null;

  } finally {
    fs.closeSync(fd);
  }
}

function validateImageSignature(filePath, expectedMime) {
  const detectedMime = detectImageMime(filePath);

  if (
    !detectedMime ||
    detectedMime !== expectedMime
  ) {
    throw new Error("IMAGE_SIGNATURE_MISMATCH");
  }

  return detectedMime;
}

module.exports = {
  detectImageMime,
  validateImageSignature
};

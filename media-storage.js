"use strict";

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const zlib = require("node:zlib");

const MEDIA_STORAGE_CONFIG = {
  enabled: false,
  provider: "s3-compatible",
  region: process.env.MEDIA_STORAGE_REGION || "auto",
  endpoint: process.env.MEDIA_STORAGE_ENDPOINT || "",
  bucket: process.env.MEDIA_STORAGE_BUCKET || "",
  maxImageBytes: 10 * 1024 * 1024,
  maxPngInflatedBytes: 64 * 1024 * 1024,
  maxVideoBytes: 200 * 1024 * 1024
};

function isMediaStorageConfigured() {
  return Boolean(
    MEDIA_STORAGE_CONFIG.endpoint &&
    MEDIA_STORAGE_CONFIG.bucket &&
    process.env.MEDIA_STORAGE_ACCESS_KEY_ID &&
    process.env.MEDIA_STORAGE_SECRET_ACCESS_KEY
  );
}

function createMediaStorageClient() {
  if (!MEDIA_STORAGE_CONFIG.enabled) {
    throw new Error("MEDIA_STORAGE_DISABLED");
  }

  if (!isMediaStorageConfigured()) {
    throw new Error("MEDIA_STORAGE_NOT_CONFIGURED");
  }

  return new S3Client({
    region: MEDIA_STORAGE_CONFIG.region,
    endpoint: MEDIA_STORAGE_CONFIG.endpoint,
    credentials: {
      accessKeyId: process.env.MEDIA_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: process.env.MEDIA_STORAGE_SECRET_ACCESS_KEY
    }
  });
}

function validateMediaContentType(contentType) {
  const allowedContentTypes = [
    "image/png",
    "video/mp4"
  ];

  if (!allowedContentTypes.includes(contentType)) {
    throw new Error("MEDIA_STORAGE_UNSUPPORTED_TYPE");
  }

  return true;
}

function validateMediaSize(contentType, sizeBytes) {
  validateMediaContentType(contentType);

  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error("MEDIA_STORAGE_INVALID_SIZE");
  }

  const maxBytes = contentType === "image/png"
    ? MEDIA_STORAGE_CONFIG.maxImageBytes
    : MEDIA_STORAGE_CONFIG.maxVideoBytes;

  if (sizeBytes > maxBytes) {
    throw new Error("MEDIA_STORAGE_FILE_TOO_LARGE");
  }

  return true;
}
function calculatePngCrc32(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("MEDIA_STORAGE_INVALID_BODY");
  }

  let crc = 0xFFFFFFFF;

  for (const byte of buffer) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 1) !== 0) {
        crc = (crc >>> 1) ^ 0xEDB88320;
      } else {
        crc = crc >>> 1;
      }
    }
  }

  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function calculatePngExpectedInflatedBytes(body) {
  if (!Buffer.isBuffer(body) || body.length < 33) {
    throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
  }

  const width = body.readUInt32BE(16);
  const height = body.readUInt32BE(20);
  const bitDepth = body.readUInt8(24);
  const colorType = body.readUInt8(25);
  const interlace = body.readUInt8(28);

  const channels = {
    0: 1,
    2: 3,
    3: 1,
    4: 2,
    6: 4
  };

  const allowedBitDepths = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16]
  };

  if (
    width === 0 ||
    height === 0 ||
    !Object.prototype.hasOwnProperty.call(channels, colorType) ||
    !allowedBitDepths[colorType].includes(bitDepth) ||
    ![0, 1].includes(interlace)
  ) {
    throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
  }

  const bitsPerPixel = channels[colorType] * bitDepth;

  function passSize(startX, startY, stepX, stepY) {
    if (width <= startX || height <= startY) {
      return 0;
    }

    const passWidth = Math.ceil((width - startX) / stepX);
    const passHeight = Math.ceil((height - startY) / stepY);
    const rowBytes = Math.ceil(passWidth * bitsPerPixel / 8);

    return passHeight * (1 + rowBytes);
  }

  let expectedBytes;

  if (interlace === 0) {
    expectedBytes = passSize(0, 0, 1, 1);
  } else {
    const adam7 = [
      [0, 0, 8, 8],
      [4, 0, 8, 8],
      [0, 4, 4, 8],
      [2, 0, 4, 4],
      [0, 2, 2, 4],
      [1, 0, 2, 2],
      [0, 1, 1, 2]
    ];

    expectedBytes = adam7.reduce(
      (total, pass) => total + passSize(...pass),
      0
    );
  }

  if (!Number.isSafeInteger(expectedBytes)) {
    throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
  }

  return expectedBytes;
}
function validatePngFilters(body, inflatedData) {
  if (
    !Buffer.isBuffer(body) ||
    !Buffer.isBuffer(inflatedData) ||
    body.length < 33
  ) {
    throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
  }

  const expectedBytes = calculatePngExpectedInflatedBytes(body);

  if (inflatedData.length !== expectedBytes) {
    throw new Error("MEDIA_STORAGE_INVALID_PNG_IDAT");
  }

  const width = body.readUInt32BE(16);
  const height = body.readUInt32BE(20);
  const bitDepth = body.readUInt8(24);
  const colorType = body.readUInt8(25);
  const interlace = body.readUInt8(28);

  const channels = {
    0: 1,
    2: 3,
    3: 1,
    4: 2,
    6: 4
  };

  const bitsPerPixel = channels[colorType] * bitDepth;

  let position = 0;

  function checkPass(startX, startY, stepX, stepY) {
    if (width <= startX || height <= startY) {
      return;
    }

    const passWidth = Math.ceil((width - startX) / stepX);
    const passHeight = Math.ceil((height - startY) / stepY);
    const rowBytes = Math.ceil(passWidth * bitsPerPixel / 8);

    for (let row = 0; row < passHeight; row++) {
      if (position >= inflatedData.length) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_IDAT");
      }

      const filterType = inflatedData[position];

      if (filterType > 4) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_FILTER");
      }

      position += 1 + rowBytes;
    }
  }

  if (interlace === 0) {
    checkPass(0, 0, 1, 1);
  } else {
    const adam7 = [
      [0, 0, 8, 8],
      [4, 0, 8, 8],
      [0, 4, 4, 8],
      [2, 0, 4, 4],
      [0, 2, 2, 4],
      [1, 0, 2, 2],
      [0, 1, 1, 2]
    ];

    for (const pass of adam7) {
      checkPass(...pass);
    }
  }

  if (position !== inflatedData.length) {
    throw new Error("MEDIA_STORAGE_INVALID_PNG_IDAT");
  }

  return true;
}
function validatePngPaletteIndices(body, inflatedData, paletteEntriesCount) {
  if (body.readUInt8(25) !== 3) {
    return true;
  }

  const width = body.readUInt32BE(16);
  const height = body.readUInt32BE(20);
  const bitDepth = body.readUInt8(24);
  const interlace = body.readUInt8(28);

  if (
    ![1, 2, 4, 8].includes(bitDepth) ||
    !Number.isInteger(paletteEntriesCount) ||
    paletteEntriesCount < 1 ||
    paletteEntriesCount > (1 << bitDepth)
  ) {
    throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
  }

  const passes = interlace === 0
    ? [[0, 0, 1, 1]]
    : [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2]
      ];

  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);

    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  let position = 0;

  for (const [sx, sy, dx, dy] of passes) {
    if (width <= sx || height <= sy) {
      continue;
    }

    const passWidth = Math.ceil((width - sx) / dx);
    const passHeight = Math.ceil((height - sy) / dy);
    const rowBytes = Math.ceil(passWidth * bitDepth / 8);

    let previous = Buffer.alloc(rowBytes);

    for (let y = 0; y < passHeight; y++) {
      if (position + 1 + rowBytes > inflatedData.length) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_IDAT");
      }

      const filter = inflatedData[position++];
      const row = Buffer.alloc(rowBytes);

      if (filter > 4) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_FILTER");
      }

      for (let i = 0; i < rowBytes; i++) {
        const raw = inflatedData[position++];
        const left = i > 0 ? row[i - 1] : 0;
        const up = previous[i];
        const upperLeft = i > 0 ? previous[i - 1] : 0;

        let predictor = 0;

        switch (filter) {
          case 0:
            predictor = 0;
            break;
          case 1:
            predictor = left;
            break;
          case 2:
            predictor = up;
            break;
          case 3:
            predictor = Math.floor((left + up) / 2);
            break;
          case 4:
            predictor = paeth(left, up, upperLeft);
            break;
        }

        row[i] = (raw + predictor) & 255;
      }

      const mask = (1 << bitDepth) - 1;

      for (let pixel = 0; pixel < passWidth; pixel++) {
        const bitOffset = pixel * bitDepth;
        const byteIndex = Math.floor(bitOffset / 8);
        const shift = 8 - bitDepth - (bitOffset % 8);
        const index = (row[byteIndex] >>> shift) & mask;

        if (index >= paletteEntriesCount) {
          throw new Error("MEDIA_STORAGE_INVALID_PNG_PALETTE_INDEX");
        }
      }

      previous = row;
    }
  }

  if (position !== inflatedData.length) {
    throw new Error("MEDIA_STORAGE_INVALID_PNG_IDAT");
  }

  return true;
}
function validatePngTextKeyword(keyword) {
  if (
    !Buffer.isBuffer(keyword) ||
    keyword.length < 1 ||
    keyword.length > 79
  ) {
    throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
  }

  if (
    keyword[0] === 32 ||
    keyword[keyword.length - 1] === 32
  ) {
    throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
  }

  for (let i = 0; i < keyword.length; i++) {
    const value = keyword[i];

    const allowed =
      (value >= 32 && value <= 126) ||
      (value >= 161 && value <= 255);

    if (!allowed) {
      throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
    }

    if (
      value === 32 &&
      i > 0 &&
      keyword[i - 1] === 32
    ) {
      throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
    }
  }
}

function validatePngLanguageTag(language) {
  if (!Buffer.isBuffer(language)) {
    throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
  }

  if (language.length === 0) {
    return;
  }

  let previousHyphen = true;

  for (const value of language) {
    const letter =
      (value >= 65 && value <= 90) ||
      (value >= 97 && value <= 122);

    const digit = value >= 48 && value <= 57;

    if (value === 45) {
      if (previousHyphen) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
      }

      previousHyphen = true;
    } else if (letter || digit) {
      previousHyphen = false;
    } else {
      throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
    }
  }

  if (previousHyphen) {
    throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
  }
}
function validatePngChunks(body) {
  if (!Buffer.isBuffer(body)) {
    throw new Error("MEDIA_STORAGE_INVALID_BODY");
  }

  if (body.length < 33) {
    throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
  }

  const expectedInflatedBytes =
    calculatePngExpectedInflatedBytes(body);

  if (expectedInflatedBytes > MEDIA_STORAGE_CONFIG.maxPngInflatedBytes) {
    throw new Error("MEDIA_STORAGE_PNG_INFLATED_TOO_LARGE");
  }

  let offset = 8;
  let chunkCount = 0;
  let hasIHDR = false;
  let hasIDAT = false;
  let hasIEND = false;
  let idatFinished = false;
  let hasPLTE = false;
  let hasGAMA = false;
  let hasSRGB = false;
  let hasPHYS = false;
  let hasTRNS = false;
  let paletteEntriesCount = 0;
  const idatParts = [];
  let totalIdatBytes = 0;

  while (offset < body.length) {
    if (body.length - offset < 12) {
      throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
    }

    const chunkLength = body.readUInt32BE(offset);
    const chunkType = body.toString("ascii", offset + 4, offset + 8);

    const allowedChunkTypes = new Set([
      "IHDR", "PLTE", "IDAT", "IEND",
      "tRNS", "gAMA", "sRGB", "pHYs",
      "tEXt", "zTXt", "iTXt"
    ]);

    if (!allowedChunkTypes.has(chunkType)) {
      throw new Error("MEDIA_STORAGE_INVALID_PNG_CHUNK_TYPE");
    }

    if (chunkLength > body.length - offset - 12) {
      throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
    }

    const crcOffset = offset + 8 + chunkLength;
    const storedChunkCrc = body.readUInt32BE(crcOffset);
    const calculatedChunkCrc = calculatePngCrc32(
      body.subarray(offset + 4, crcOffset)
    );

    if (storedChunkCrc !== calculatedChunkCrc) {
      throw new Error("MEDIA_STORAGE_INVALID_PNG_CRC");
    }

    if (chunkType === "gAMA") {
      if (
        hasGAMA ||
        hasPLTE ||
        hasIDAT ||
        chunkLength !== 4 ||
        body.readUInt32BE(offset + 8) === 0
      ) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
      }
      hasGAMA = true;
    }

    if (chunkType === "sRGB") {
      if (
        hasSRGB ||
        hasPLTE ||
        hasIDAT ||
        chunkLength !== 1 ||
        body.readUInt8(offset + 8) > 3
      ) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
      }
      hasSRGB = true;
    }

    if (chunkType === "tEXt") {
      const textDataStart = offset + 8;
      const textDataEnd = textDataStart + chunkLength;

      let separatorPosition = -1;

      for (
        let i = textDataStart;
        i < textDataEnd;
        i++
      ) {
        if (body[i] === 0) {
          separatorPosition = i;
          break;
        }
      }

      const keywordLength =
        separatorPosition - textDataStart;

      if (separatorPosition !== -1) {
        validatePngTextKeyword(
          body.subarray(textDataStart, separatorPosition)
        );
      }

      if (
        separatorPosition === -1 ||
        keywordLength < 1 ||
        keywordLength > 79
      ) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
      }
    }
    if (chunkType === "zTXt") {
      const dataStart = offset + 8;
      const dataEnd = dataStart + chunkLength;

      let separatorPosition = -1;

      for (let i = dataStart; i < dataEnd; i++) {
        if (body[i] === 0) {
          separatorPosition = i;
          break;
        }
      }

      const keywordLength = separatorPosition - dataStart;

      if (separatorPosition !== -1) {
        validatePngTextKeyword(
          body.subarray(dataStart, separatorPosition)
        );
      }
      const methodPosition = separatorPosition + 1;

      if (
        separatorPosition === -1 ||
        keywordLength < 1 ||
        keywordLength > 79 ||
        methodPosition >= dataEnd ||
        body[methodPosition] !== 0
      ) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
      }

      const compressedText = body.subarray(
        methodPosition + 1,
        dataEnd
      );

      if (compressedText.length === 0) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
      }

      try {
        const textResult = zlib.inflateSync(
          compressedText,
          {
            maxOutputLength: 1024 * 1024,
            info: true
          }
        );

        if (
          !textResult.engine ||
          textResult.engine.bytesWritten !== compressedText.length
        ) {
          throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
        }
      } catch (error) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
      }
    }
    if (chunkType === "iTXt") {
      const dataStart = offset + 8;
      const dataEnd = dataStart + chunkLength;

      let keywordEnd = -1;

      for (let i = dataStart; i < dataEnd; i++) {
        if (body[i] === 0) {
          keywordEnd = i;
          break;
        }
      }

      const keywordLength = keywordEnd - dataStart;

      if (keywordEnd !== -1) {
        validatePngTextKeyword(
          body.subarray(dataStart, keywordEnd)
        );
      }
      const flagPosition = keywordEnd + 1;
      const methodPosition = keywordEnd + 2;

      if (
        keywordEnd === -1 ||
        keywordLength < 1 ||
        keywordLength > 79 ||
        methodPosition >= dataEnd
      ) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
      }

      const compressionFlag = body[flagPosition];
      const compressionMethod = body[methodPosition];

      if (
        (compressionFlag !== 0 && compressionFlag !== 1) ||
        compressionMethod !== 0
      ) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
      }

      const languageStart = methodPosition + 1;
      let languageEnd = -1;

      for (let i = languageStart; i < dataEnd; i++) {
        if (body[i] === 0) {
          languageEnd = i;
          break;
        }
      }

      if (languageEnd === -1) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
      }

      validatePngLanguageTag(
        body.subarray(languageStart, languageEnd)
      );

      const translatedStart = languageEnd + 1;
      let translatedEnd = -1;

      for (let i = translatedStart; i < dataEnd; i++) {
        if (body[i] === 0) {
          translatedEnd = i;
          break;
        }
      }

      if (translatedEnd === -1) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
      }

      const { TextDecoder } = require("node:util");
      const utf8Decoder = new TextDecoder("utf-8", {
        fatal: true
      });

      try {
        utf8Decoder.decode(
          body.subarray(translatedStart, translatedEnd)
        );

        const textData = body.subarray(
          translatedEnd + 1,
          dataEnd
        );

        if (compressionFlag === 0) {
          utf8Decoder.decode(textData);
        } else {
          const result = zlib.inflateSync(textData, {
            maxOutputLength: 1024 * 1024,
            info: true
          });

          if (
            !result.engine ||
            result.engine.bytesWritten !== textData.length
          ) {
            throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
          }

          utf8Decoder.decode(result.buffer);
        }
      } catch (error) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
      }
    }
    if (chunkType === "pHYs") {
      if (
        hasPHYS ||
        !hasIHDR ||
        hasIDAT ||
        hasIEND ||
        chunkLength !== 9 ||
        body.readUInt8(offset + 16) > 1
      ) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
      }

      hasPHYS = true;
    }

    if (chunkType === "PLTE") {
      const pngBitDepth = body.readUInt8(24);
      const pngColorType = body.readUInt8(25);
      const paletteEntries = chunkLength / 3;

      if (
        hasPLTE ||
        hasIDAT ||
        chunkLength === 0 ||
        chunkLength > 768 ||
        chunkLength % 3 !== 0 ||
        [0, 4].includes(pngColorType) ||
        (pngColorType === 3 &&
          paletteEntries > Math.pow(2, pngBitDepth))
      ) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
      }

      hasPLTE = true;
      paletteEntriesCount = paletteEntries;
    }

    if (chunkType === "tRNS") {
      const pngColorType = body.readUInt8(25);

      if (
        hasTRNS ||
        hasIDAT ||
        !hasIHDR ||
        (pngColorType === 0 && chunkLength !== 2) ||
        (pngColorType === 2 && chunkLength !== 6) ||
        (pngColorType === 3 &&
          (!hasPLTE ||
           chunkLength < 1 ||
           chunkLength > paletteEntriesCount)) ||
        ![0, 2, 3].includes(pngColorType)
      ) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
      }

      const pngBitDepth = body.readUInt8(24);
      const maxSampleValue = Math.pow(2, pngBitDepth) - 1;

      if (pngColorType === 0) {
        const graySample = body.readUInt16BE(offset + 8);

        if (graySample > maxSampleValue) {
          throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
        }
      }

      if (pngColorType === 2) {
        const redSample = body.readUInt16BE(offset + 8);
        const greenSample = body.readUInt16BE(offset + 10);
        const blueSample = body.readUInt16BE(offset + 12);

        if (
          redSample > maxSampleValue ||
          greenSample > maxSampleValue ||
          blueSample > maxSampleValue
        ) {
          throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
        }
      }

      hasTRNS = true;
    }
    if (chunkCount === 0 && chunkType !== "IHDR") {
      throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
    }

    if (chunkType === "IHDR") {
      if (hasIHDR || chunkCount !== 0 || chunkLength !== 13) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
      }
      hasIHDR = true;
    }

    if (chunkType === "IDAT") {
      const pngColorType = body.readUInt8(25);

      if (pngColorType === 3 && !hasPLTE) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
      }

      if (!hasIHDR || idatFinished || hasIEND) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
      }
      const idatPart = body.subarray(
        offset + 8,
        offset + 8 + chunkLength
      );

      totalIdatBytes += chunkLength;

      if (totalIdatBytes > MEDIA_STORAGE_CONFIG.maxImageBytes) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
      }

      idatParts.push(idatPart);
      hasIDAT = true;
    } else if (hasIDAT) {
      idatFinished = true;
    }

    if (chunkType === "IEND") {
      if (!hasIDAT || hasIEND || chunkLength !== 0) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
      }

      hasIEND = true;

      if (offset + 12 !== body.length) {
        throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
      }
    }

    offset += 12 + chunkLength;
    chunkCount++;
  }

  if (!hasIHDR || !hasIDAT || !hasIEND || offset !== body.length) {
    throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
  }

  let inflatedData;

  try {
    const compressedData = Buffer.concat(
      idatParts,
      totalIdatBytes
    );

    const result = zlib.inflateSync(
      compressedData,
      {
        maxOutputLength: expectedInflatedBytes,
        info: true
      }
    );

    if (
      !result.engine ||
      result.engine.bytesWritten !== compressedData.length
    ) {
      throw new Error("MEDIA_STORAGE_INVALID_PNG_IDAT");
    }

    inflatedData = result.buffer;
  } catch (error) {
    throw new Error("MEDIA_STORAGE_INVALID_PNG_IDAT");
  }

  if (inflatedData.length !== expectedInflatedBytes) {
    throw new Error("MEDIA_STORAGE_INVALID_PNG_IDAT");
  }

  validatePngFilters(body, inflatedData);
  validatePngPaletteIndices(body, inflatedData, paletteEntriesCount);

  return { chunkCount };
}
function validateMediaSignature(body, contentType) {
  if (!Buffer.isBuffer(body)) {
    throw new Error("MEDIA_STORAGE_INVALID_BODY");
  }

  validateMediaContentType(contentType);

  if (contentType === "image/png") {
    const pngSignature = Buffer.from([
      0x89, 0x50, 0x4E, 0x47,
      0x0D, 0x0A, 0x1A, 0x0A
    ]);

    if (
      body.length < pngSignature.length ||
      !body.subarray(0, pngSignature.length).equals(pngSignature)
    ) {
      throw new Error("MEDIA_STORAGE_INVALID_SIGNATURE");
    }

    if (body.length < 33) {
      throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
    }

    const ihdrLength = body.readUInt32BE(8);
    const ihdrType = body.toString("ascii", 12, 16);
    const width = body.readUInt32BE(16);
    const height = body.readUInt32BE(20);

    if (
      ihdrLength !== 13 ||
      ihdrType !== "IHDR" ||
      width === 0 ||
      height === 0
    ) {
      throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
    }

    const bitDepth = body.readUInt8(24);
    const colorType = body.readUInt8(25);
    const compression = body.readUInt8(26);
    const filter = body.readUInt8(27);
    const interlace = body.readUInt8(28);

    const allowedBitDepths = {
      0: [1, 2, 4, 8, 16],
      2: [8, 16],
      3: [1, 2, 4, 8],
      4: [8, 16],
      6: [8, 16]
    };

    if (
      !Object.prototype.hasOwnProperty.call(allowedBitDepths, colorType) ||
      !allowedBitDepths[colorType].includes(bitDepth) ||
      compression !== 0 ||
      filter !== 0 ||
      ![0, 1].includes(interlace)
    ) {
      throw new Error("MEDIA_STORAGE_INVALID_PNG_STRUCTURE");
    }

    const storedCrc = body.readUInt32BE(29);
    const calculatedCrc = calculatePngCrc32(
      body.subarray(12, 29)
    );

    if (storedCrc !== calculatedCrc) {
      throw new Error("MEDIA_STORAGE_INVALID_PNG_CRC");
    }

    // Verifier la structure et le CRC de tous les blocs PNG.
    validatePngChunks(body);
  }

  if (contentType === "video/mp4") {
    if (body.length < 16) {
      throw new Error("MEDIA_STORAGE_INVALID_SIGNATURE");
    }

    const boxSize = body.readUInt32BE(0);
    const boxType = body.toString("ascii", 4, 8);
    const majorBrand = body.toString("ascii", 8, 12);

    const allowedBrands = [
      "isom",
      "iso2",
      "mp41",
      "mp42",
      "avc1",
      "M4V "
    ];

    if (
      boxType !== "ftyp" ||
      boxSize < 16 ||
      boxSize > body.length ||
      !allowedBrands.includes(majorBrand)
    ) {
      throw new Error("MEDIA_STORAGE_INVALID_SIGNATURE");
    }
  }

  return true;
}
function validateMediaUpload(body, contentType) {
  validateMediaContentType(contentType);

  if (!Buffer.isBuffer(body)) {
    throw new Error("MEDIA_STORAGE_INVALID_BODY");
  }

  validateMediaSize(contentType, body.length);
  validateMediaSignature(body, contentType);

  return true;
}
async function uploadMedia({ key, body, contentType }) {
  if (!MEDIA_STORAGE_CONFIG.enabled) {
    throw new Error("MEDIA_STORAGE_DISABLED");
  }

  if (!key || !body || !contentType) {
    throw new Error("MEDIA_STORAGE_INVALID_INPUT");
  }

  validateMediaUpload(body, contentType);

  const client = createMediaStorageClient();

  try {
    const command = new PutObjectCommand({
      Bucket: MEDIA_STORAGE_CONFIG.bucket,
      Key: key,
      Body: body,
      ContentType: contentType
    });

    await client.send(command);

    return {
      provider: MEDIA_STORAGE_CONFIG.provider,
      bucket: MEDIA_STORAGE_CONFIG.bucket,
      key
    };
  } finally {
    client.destroy();
  }
}

module.exports = {
  MEDIA_STORAGE_CONFIG,
  isMediaStorageConfigured,
  createMediaStorageClient,
  validateMediaContentType,
  validateMediaSize,
  validateMediaUpload,
  uploadMedia
};

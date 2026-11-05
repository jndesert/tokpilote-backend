"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { renderVideo } = require("./video-renderer");

const IMAGES_DIR = path.resolve(__dirname, "..", "images");
const OUTPUT_DIR = path.resolve(__dirname, "..", "sorties");

const MAX_SCENES = 30;
const MAX_DURATION_SECONDS = 600;

function prepareRenderScenes(timeline, imageNames) {
  if (
    !Array.isArray(timeline) ||
    timeline.length === 0 ||
    timeline.length > MAX_SCENES
  ) {
    throw new Error("INVALID_TIMELINE");
  }

  if (
    !Array.isArray(imageNames) ||
    imageNames.length !== timeline.length
  ) {
    throw new Error("INVALID_IMAGE_MAPPING");
  }

  let totalDuration = 0;

  const scenes = timeline.map((scene, index) => {
    const duration = Number(scene.durationSeconds);
    const imageName = imageNames[index];

    if (
      !Number.isFinite(duration) ||
      duration <= 0
    ) {
      throw new Error("INVALID_SCENE_DURATION");
    }

    totalDuration += duration;

    if (
      typeof imageName !== "string" ||
      !/^[a-zA-Z0-9_-]+\.(png|jpg|jpeg)$/i.test(imageName)
    ) {
      throw new Error("INVALID_IMAGE_NAME");
    }

    const imagePath = path.join(IMAGES_DIR, imageName);

    if (
      !fs.existsSync(imagePath) ||
      !fs.statSync(imagePath).isFile()
    ) {
      throw new Error("IMAGE_NOT_FOUND");
    }

    return {
      image: imagePath,
      durationSeconds: duration
    };
  });

  if (totalDuration > MAX_DURATION_SECONDS) {
    throw new Error("VIDEO_DURATION_LIMIT_EXCEEDED");
  }

  return scenes;
}

async function renderPreparedTimeline({
  timeline,
  imageNames
}) {
  const scenes = prepareRenderScenes(timeline, imageNames);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const outputPath = path.join(
    OUTPUT_DIR,
    `videapilot_${randomUUID()}.mp4`
  );

  return renderVideo({
    scenes,
    outputPath,
    width: 1080,
    height: 1920,
    fps: 30
  });
}

module.exports = {
  prepareRenderScenes,
  renderPreparedTimeline
};
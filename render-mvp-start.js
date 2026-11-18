"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Pool } = require("pg");

async function start() {
  if (process.env.VIDEO_MVP_ENABLED !== "true") {
    require("./server");
    return;
  }
  const mount = "/var/data";
  // A directory in the container image is ephemeral. Require an actual disk.
  const mounts = fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n");
  if (!mounts.some(line => line.split(" ")[4] === mount)) {
    throw new Error("MVP_PERSISTENT_DISK_NOT_MOUNTED");
  }
  for (const variable of ["VIDEO_MVP_IMAGE_DIRECTORY", "VIDEO_MVP_AUDIO_DIRECTORY", "VIDEO_MVP_OUTPUT_DIRECTORY"]) {
    const directory = process.env[variable];
    if (!directory || path.dirname(directory) !== mount) throw new Error(`INVALID_${variable}`);
    fs.mkdirSync(directory, { recursive: true });
    if (fs.realpathSync(directory) !== directory) throw new Error(`UNSAFE_${variable}`);
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  }
  for (const name of ["DATABASE_URL", "SESSION_SECRET", "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"]) {
    if (!process.env[name]) throw new Error(`MISSING_${name}`);
  }
  const origin = new URL(process.env.VIDEO_RENDER_ALLOWED_ORIGIN);
  if (origin.protocol !== "https:" || origin.origin !== process.env.VIDEO_RENDER_ALLOWED_ORIGIN) {
    throw new Error("INVALID_VIDEO_RENDER_ALLOWED_ORIGIN");
  }
  execFileSync("ffprobe", ["-version"], { stdio: "ignore", timeout: 10000 });
  const encoders = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8", timeout: 10000 });
  if (!/\blibx264\s/.test(encoders) || !/\baac\s/.test(encoders)) throw new Error("MVP_ENCODERS_UNAVAILABLE");

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 7000
  });
  try {
    await pool.query("SELECT narration_file_name, mvp_local_images FROM video_projects LIMIT 0");
    await pool.query("SELECT duration_seconds, image_asset_id FROM video_project_scenes LIMIT 0");
    await pool.query("SELECT storage_key FROM video_image_assets LIMIT 0");
  } finally {
    await pool.end();
  }
  require("./server");
}

if (require.main === module) {
  start().catch(error => {
    // Keep secrets and connection details out of the startup log.
    const safe = typeof error.message === "string" && /^[A-Z_]+$/.test(error.message);
    console.error(safe ? error.message : "MVP_STARTUP_CHECK_FAILED");
    process.exitCode = 1;
  });
}

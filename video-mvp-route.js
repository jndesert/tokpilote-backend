"use strict";

const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { validateImageSignature } = require("./video-image-signature");
const { validateImageDimensions } = require("./video-image-dimensions");
const { validateImageDecoding } = require("./video-image-decoder");
const { validateAudioFile } = require("./video-audio-security");
const { localRenderAuthorized, productionRenderAuthorized, productionRenderReadAuthorized } = require("./video-render-route");

const media = new Map([["image/png", "png"], ["image/jpeg", "jpg"], ["audio/mpeg", "mp3"]]);
const prefix = "/api/videos/:id/mvp";

function authorize(req, res, next) {
  res.set("Cache-Control", "no-store");
  req.owner = req.session?.tiktokUser?.openId;
  if (!req.owner) return res.status(401).json({ error: "TIKTOK_LOGIN_REQUIRED" });
  if (process.env.VIDEO_MVP_ENABLED !== "true" ||
      !(localRenderAuthorized(req) || (req.method === "GET"
        ? productionRenderReadAuthorized(req) : productionRenderAuthorized(req)))) {
    return res.status(403).json({ error: "VIDEO_MVP_NOT_AUTHORIZED" });
  }
  if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) {
    return res.status(400).json({ error: "INVALID_PROJECT_ID" });
  }
  return next();
}

function registerVideoMvpRoutes(app, pool) {
  const ownerQuery = "SELECT id, narration_file_name, mvp_local_images FROM video_projects WHERE id = $1 AND user_id = $2";
  app.get(prefix, authorize, async (req, res) => {
    const params = [req.params.id, req.owner];
    const { rows } = await pool.query(ownerQuery, params);
    if (!rows.length) return res.status(404).json({ error: "PROJECT_NOT_FOUND" });
    const scenes = await pool.query(
      `SELECT s.scene_number, s.title, s.duration_seconds, s.image_asset_id IS NOT NULL AS has_image
       FROM video_project_scenes s JOIN video_projects p ON p.id = s.project_id
       WHERE p.id = $1 AND p.user_id = $2 ORDER BY s.scene_number`, params
    );
    return res.json({
      scenes: scenes.rows,
      narration: Boolean(rows[0].narration_file_name),
      manualAllowed: rows[0].mvp_local_images || scenes.rows.length === 0
    });
  });

  const raw = express.raw({ type: [...media.keys()], limit: "20mb", inflate: false });
  async function upload(req, res) {
    const audio = req.path.endsWith("/narration");
    const mime = req.get("Content-Type")?.split(";")[0].trim().toLowerCase();
    const ext = media.get(mime);
    const title = typeof req.query.title === "string" ? req.query.title.trim() : "";
    const seconds = typeof req.query.seconds === "string" ? Number(req.query.seconds) : NaN;
    if (!Buffer.isBuffer(req.body) || !req.body.length ||
        !(audio ? ext === "mp3" : ext === "png" || ext === "jpg")) {
      return res.status(415).json({ error: "INVALID_MEDIA_TYPE" });
    }
    if (!audio && (!title || title.length > 120 || !Number.isInteger(seconds) || seconds < 1 || seconds > 600)) {
      return res.status(400).json({ error: "INVALID_SCENE" });
    }
    const kind = audio ? "AUDIO" : "IMAGE";
    const directory = process.env[`VIDEO_MVP_${kind}_DIRECTORY`] || process.env[`VIDEO_${kind}_DIRECTORY`];
    if (!directory || !path.isAbsolute(directory)) {
      return res.status(503).json({ error: "MVP_LOCAL_STORAGE_REQUIRED" });
    }
    const params = [req.params.id, req.owner];
    const client = await pool.connect();
    const asset = randomUUID();
    const filename = `${asset}.${ext}`;
    const file = path.join(directory, filename);
    let written = false;
    let commitAttempted = false;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(ownerQuery + " FOR UPDATE", params);
      if (!rows.length || (audio && rows[0].narration_file_name)) {
        await client.query("ROLLBACK");
        return res.status(rows.length ? 409 : 404).json({ error: rows.length ? "NARRATION_ALREADY_SET" : "PROJECT_NOT_FOUND" });
      }
      const scenes = (await client.query(
        `SELECT count(*) AS count, COALESCE(max(scene_number),0) AS last,
                COALESCE(sum(duration_seconds),0) AS duration
         FROM video_project_scenes WHERE project_id = $1`, [params[0]]
      )).rows[0];
      if (!rows[0].mvp_local_images && Number(scenes.count) !== 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "LEGACY_PROJECT_STORAGE" });
      }
      if (!audio && (Number(scenes.count) >= 30 || Number(scenes.duration) + seconds > 600)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "PROJECT_SCENE_LIMIT" });
      }
      await fs.writeFile(file, req.body, { flag: "wx" });
      written = true;
      try {
        if (audio) validateAudioFile({ audioDirectory: directory, audioFileName: filename });
        else {
          validateImageSignature(file, mime);
          await validateImageDimensions(file);
          await validateImageDecoding(file, mime);
        }
      } catch {
        await client.query("ROLLBACK");
        return res.status(422).json({ error: "INVALID_MEDIA_CONTENT" });
      }
      if (audio) {
        await client.query("UPDATE video_projects SET narration_file_name = $3, mvp_local_images = true WHERE id = $1 AND user_id = $2", [...params, filename]);
      } else {
        const scene = randomUUID();
        await client.query(
          "INSERT INTO video_project_scenes (scene_id, project_id, scene_number, title, duration_seconds) VALUES ($1,$2,$3,$4,$5)",
          [scene, params[0], Number(scenes.last) + 1, title, seconds]
        );
        await client.query(
          "INSERT INTO video_image_assets (id, project_id, scene_id, user_id, storage_key, mime_type, size_bytes) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [asset, params[0], scene, params[1], filename, mime, req.body.length]
        );
        await client.query("UPDATE video_project_scenes SET image_asset_id = $1 WHERE scene_id = $2 AND project_id = $3", [asset, scene, params[0]]);
        await client.query("UPDATE video_projects SET mvp_local_images = true WHERE id = $1 AND user_id = $2", params);
      }
      commitAttempted = true;
      await client.query("COMMIT");
      return res.status(201).json({ success: true });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
      // If COMMIT's outcome is uncertain, keep the file for reconciliation.
      if (written && !commitAttempted) await fs.unlink(file).catch(() => {});
    }
  }

  app.post(prefix + "/scenes", authorize, raw, upload);
  app.post(prefix + "/narration", authorize, raw, upload);
}

module.exports = { registerVideoMvpRoutes };

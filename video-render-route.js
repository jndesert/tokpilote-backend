"use strict";

function registerVideoRenderRoute(app, pool) {
  if (!app || !pool) {
    throw new Error("RENDER_ROUTE_DEPENDENCIES_MISSING");
  }

  app.post("/api/videos/render", async (req, res) => {
    res.set("Cache-Control", "no-store");

    // Fonction desactivee par defaut.
    if (process.env.VIDEO_RENDER_ENABLED !== "true") {
      return res.status(503).json({
        success: false,
        error: "VIDEO_RENDER_DISABLED"
      });
    }

    // Verifier l'origine.
    if (
      req.get("Origin") !==
      "https://videapilot-api.onrender.com"
    ) {
      return res.status(403).json({
        success: false,
        error: "ORIGIN_NOT_ALLOWED"
      });
    }

    // Verifier la session TikTok.
    const userId = req.session?.tiktokUser?.openId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "TIKTOK_LOGIN_REQUIRED"
      });
    }

    // Accepter uniquement l'identifiant du projet.
    const body = req.body;

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(body, "projectId")
    ) {
      return res.status(400).json({
        success: false,
        error: "INVALID_RENDER_REQUEST"
      });
    }

    const { projectId } = body;

    if (
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
        SELECT id
        FROM video_projects
        WHERE id = $1 AND user_id = $2
        `,
        [projectId, userId]
      );

      if (projectResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "PROJECT_NOT_FOUND"
        });
      }

      // Aucun rendu tant que les images du projet
      // ne sont pas associees de facon securisee.
      return res.status(503).json({
        success: false,
        status: "render_not_ready",
        error: "PROJECT_IMAGES_NOT_READY",
        message:
          "Projet verifie. Association des images en preparation."
      });

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
  registerVideoRenderRoute
};
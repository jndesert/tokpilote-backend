"use strict";

// Traduit les erreurs du service en reponses HTTP.
// Ne lance aucun rendu par lui-meme.

function mapRenderError(error) {
  const code = error?.message;

  switch (code) {
    case "VIDEO_RENDER_BUSY":
      return {
        status: 429,
        body: {
          success: false,
          error: "VIDEO_RENDER_BUSY"
        }
      };

    case "PROJECT_NOT_FOUND":
      return {
        status: 404,
        body: {
          success: false,
          error: "PROJECT_NOT_FOUND"
        }
      };

    case "INVALID_PROJECT_ID":
    case "INVALID_USER_ID":
      return {
        status: 400,
        body: {
          success: false,
          error: code
        }
      };

    case "DATABASE_UNAVAILABLE":
      return {
        status: 503,
        body: {
          success: false,
          error: "RENDER_SERVICE_UNAVAILABLE"
        }
      };

    default:
      return {
        status: 503,
        body: {
          success: false,
          error: "VIDEO_RENDER_FAILED"
        }
      };
  }
}

function mapRenderSuccess(result) {
  if (
    !result ||
    result.success !== true ||
    typeof result.videoId !== "string" ||
    typeof result.fileName !== "string"
  ) {
    throw new Error("INVALID_RENDER_RESULT");
  }

  return {
    status: 200,
    body: {
      success: true,
      videoId: result.videoId,
      fileName: result.fileName,
      sceneCount: result.sceneCount,
      totalDurationSeconds: result.totalDurationSeconds,
      sizeBytes: result.sizeBytes,
      format: "mp4"
    }
  };
}

module.exports = {
  mapRenderError,
  mapRenderSuccess
};

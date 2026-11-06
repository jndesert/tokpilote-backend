"use strict";

const ERROR_RESPONSES = Object.freeze({
  PROJECT_NOT_FOUND: 404,
  NO_PROJECT_SCENES: 409,
  SCENE_IMAGE_NOT_READY: 409,
  SCENE_IMAGE_FILE_NOT_FOUND: 409,
  VIDEO_RENDER_BUSY: 429,
  TOO_MANY_SCENES: 422,
  INVALID_SCENE_DURATION: 422,
  VIDEO_DURATION_LIMIT_EXCEEDED: 422,
  INVALID_STORAGE_KEY: 422,
  IMAGE_OUTSIDE_ALLOWED_DIRECTORY: 422,
  INVALID_IMAGE_FILE: 422,
  IMAGE_SIZE_MISMATCH: 422,
  IMAGE_MIME_MISMATCH: 422
});

function mapRenderErrorToHttp(error) {
  const code = error && error.message;

  if (
    typeof code === "string" &&
    Object.prototype.hasOwnProperty.call(
      ERROR_RESPONSES, code
    )
  ) {
    return {
      status: ERROR_RESPONSES[code],
      body: { success: false, error: code }
    };
  }

  return {
    status: 503,
    body: {
      success: false,
      error: "VIDEO_RENDER_UNAVAILABLE"
    }
  };
}

module.exports = { mapRenderErrorToHttp };

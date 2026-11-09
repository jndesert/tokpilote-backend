"use strict";

function parseAdminOpenIds(value) {
  if (typeof value !== "string" || !value.trim()) {
    return new Set();
  }

  return new Set(
    value
      .split(",")
      .map(id => id.trim())
      .filter(Boolean)
  );
}

function isVideoAdmin(req, configuredIds) {
  const openId = req?.session?.tiktokUser?.openId;

  if (typeof openId !== "string" || !openId) {
    return false;
  }

  if (!(configuredIds instanceof Set)) {
    return false;
  }

  return configuredIds.has(openId);
}

function requireVideoAdmin(configuredIds) {
  const allowedIds =
    configuredIds instanceof Set
      ? new Set(configuredIds)
      : new Set();

  return function videoAdminMiddleware(req, res, next) {
    if (!req?.session?.tiktokUser?.openId) {
      return res.status(401).json({
        success: false,
        error: "AUTHENTICATION_REQUIRED"
      });
    }

    if (!isVideoAdmin(req, allowedIds)) {
      return res.status(403).json({
        success: false,
        error: "ADMIN_ACCESS_DENIED"
      });
    }

    return next();
  };
}

module.exports = {
  parseAdminOpenIds,
  isVideoAdmin,
  requireVideoAdmin
};

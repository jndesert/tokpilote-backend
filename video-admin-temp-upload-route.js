"use strict";

const {
  parseAdminOpenIds,
  requireVideoAdmin
} = require("./video-admin-access");

const {
  buildTempUploadRecoveryReport
} = require("./video-upload-temp-recovery-report");

const ALLOWED_STATUSES = Object.freeze([
  "REGISTERED",
  "UNREGISTERED",
  "INVALID_MANIFEST",
  "MISSING_MANIFEST",
  "UNINSPECTABLE"
]);

function summarizeTempUploadRecovery(report) {
  if (
    !report ||
    !Array.isArray(report.entries) ||
    !Number.isSafeInteger(report.count) ||
    report.count < 0 ||
    report.count !== report.entries.length
  ) {
    throw new Error("INVALID_RECOVERY_REPORT");
  }

  const counts = Object.create(null);

  for (const status of ALLOWED_STATUSES) {
    counts[status] = 0;
  }

  for (const entry of report.entries) {
    if (
      !entry ||
      !ALLOWED_STATUSES.includes(entry.status) ||
      entry.automaticRecoveryAllowed !== false ||
      entry.automaticDeletionAllowed !== false ||
      entry.eligible !== false
    ) {
      throw new Error("INVALID_RECOVERY_REPORT");
    }

    counts[entry.status]++;
  }

  if (
    report.automaticRecoveryEnabled !== false ||
    report.automaticDeletionEnabled !== false
  ) {
    throw new Error("INVALID_RECOVERY_REPORT");
  }

  return Object.freeze({
    count: report.count,
    countsByStatus: Object.freeze({ ...counts }),
    automaticRecoveryEnabled: false,
    automaticDeletionEnabled: false
  });
}

function registerAdminTempUploadRoute(
  app,
  options = {}
) {
  if (!app || typeof app.get !== "function") {
    throw new Error("INVALID_EXPRESS_APP");
  }

  const configuredIds = parseAdminOpenIds(
    options.adminOpenIds
  );

  const guard = requireVideoAdmin(configuredIds);

  const reportBuilder =
    options.reportBuilder ||
    buildTempUploadRecoveryReport;

  if (typeof reportBuilder !== "function") {
    throw new Error("INVALID_REPORT_BUILDER");
  }

  app.get(
    "/api/admin/temp-upload-recovery-report",
    guard,
    async (req, res) => {
      res.set("Cache-Control", "no-store");

      try {
        const report = await reportBuilder();
        const summary = summarizeTempUploadRecovery(report);

        return res.json({
          success: true,
          ...summary
        });
      } catch (error) {
        return res.status(500).json({
          success: false,
          error: "ADMIN_DIAGNOSTIC_UNAVAILABLE"
        });
      }
    }
  );
}

module.exports = {
  summarizeTempUploadRecovery,
  registerAdminTempUploadRoute
};

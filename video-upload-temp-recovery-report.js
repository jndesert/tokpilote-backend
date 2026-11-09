"use strict";

const {
  scanTempUploadDirectories
} = require("./video-upload-temp-orphan-scanner");

const {
  evaluateTempUploadRecovery
} = require("./video-upload-temp-recovery-policy");

const VALID_STATUSES = new Set([
  "REGISTERED",
  "UNREGISTERED",
  "INVALID_MANIFEST",
  "MISSING_MANIFEST",
  "UNINSPECTABLE"
]);

function invalidScanReport() {
  return new Error("MEDIA_UPLOAD_INVALID_SCAN_REPORT");
}

function validateScanReport(scan) {
  if (
    scan === null ||
    typeof scan !== "object" ||
    Array.isArray(scan)
  ) {
    throw invalidScanReport();
  }

  if (
    !Array.isArray(scan.entries) ||
    !Number.isSafeInteger(scan.count) ||
    scan.count < 0 ||
    scan.count !== scan.entries.length
  ) {
    throw invalidScanReport();
  }

  if (
    typeof scan.root !== "string" ||
    scan.root.length === 0 ||
    typeof scan.scannedAt !== "string" ||
    !Number.isFinite(Date.parse(scan.scannedAt))
  ) {
    throw invalidScanReport();
  }

  const seenCandidateNames = new Set();

  for (const entry of scan.entries) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry)
    ) {
      throw invalidScanReport();
    }

    if (
      typeof entry.name !== "string" ||
      !/^videapilot-upload-[A-Za-z0-9_-]+$/.test(entry.name)
    ) {
      throw invalidScanReport();
    }

    if (seenCandidateNames.has(entry.name.toLowerCase())) {
      throw invalidScanReport();
    }

    seenCandidateNames.add(entry.name.toLowerCase());

    if (
      typeof entry.status !== "string" ||
      !VALID_STATUSES.has(entry.status)
    ) {
      throw invalidScanReport();
    }

    if (
      entry.reason !== undefined &&
      entry.reason !== null &&
      typeof entry.reason !== "string"
    ) {
      throw invalidScanReport();
    }
  }

  return true;
}

async function buildTempUploadRecoveryReport() {
  const scan = await scanTempUploadDirectories();

  validateScanReport(scan);

  const entries = scan.entries.map(entry => {
    const policy = evaluateTempUploadRecovery(entry);

    return Object.freeze({
      name: entry.name,
      status: entry.status,
      reason: entry.reason || null,
      recoveryDecision: policy.decision,
      recoveryReason: policy.reason,
      eligible: policy.eligible,
      automaticRecoveryAllowed:
        policy.automaticRecoveryAllowed,
      automaticDeletionAllowed:
        policy.automaticDeletionAllowed
    });
  });

  return Object.freeze({
    root: scan.root,
    scannedAt: scan.scannedAt,
    count: entries.length,
    automaticRecoveryEnabled: false,
    automaticDeletionEnabled: false,
    entries: Object.freeze(entries)
  });
}

module.exports = {
  validateScanReport,
  buildTempUploadRecoveryReport
};

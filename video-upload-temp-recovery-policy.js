"use strict";

const KNOWN_STATUSES = Object.freeze([
  "REGISTERED",
  "UNREGISTERED",
  "INVALID_MANIFEST",
  "MISSING_MANIFEST",
  "UNINSPECTABLE"
]);

function evaluateTempUploadRecovery(entry) {
  if (
    entry === null ||
    typeof entry !== "object" ||
    Array.isArray(entry)
  ) {
    return Object.freeze({
      eligible: false,
      automaticRecoveryAllowed: false,
      automaticDeletionAllowed: false,
      decision: "REJECT",
      reason: "INVALID_ENTRY"
    });
  }

  const status = entry.status;

  if (!KNOWN_STATUSES.includes(status)) {
    return Object.freeze({
      eligible: false,
      automaticRecoveryAllowed: false,
      automaticDeletionAllowed: false,
      decision: "REJECT",
      reason: "UNKNOWN_STATUS"
    });
  }

  let decision = "REJECT";
  let reason = "RECOVERY_NOT_ALLOWED";

  switch (status) {
    case "REGISTERED":
      decision = "NO_ACTION";
      reason = "ALREADY_REGISTERED";
      break;

    case "UNREGISTERED":
      decision = "MANUAL_REVIEW";
      reason = "OWNERSHIP_NOT_ESTABLISHED";
      break;

    case "INVALID_MANIFEST":
      reason = "INVALID_MANIFEST";
      break;

    case "MISSING_MANIFEST":
      reason = "MISSING_MANIFEST";
      break;

    case "UNINSPECTABLE":
      reason = "UNINSPECTABLE";
      break;
  }

  return Object.freeze({
    eligible: false,
    automaticRecoveryAllowed: false,
    automaticDeletionAllowed: false,
    decision,
    reason,
    status
  });
}

module.exports = {
  KNOWN_STATUSES,
  evaluateTempUploadRecovery
};

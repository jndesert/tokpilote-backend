"use strict";

/*
 * VideaPilot - Politique experimentale de reprise.
 *
 * Ce module ne publie rien.
 * Il ne modifie aucune base de donnees.
 * Il classe uniquement les resultats d'une
 * verification effectuee apres une erreur.
 *
 * IMPORTANT :
 * NOT_PUBLISHED n'autorise jamais une
 * nouvelle publication automatique.
 */

const ACTIONS = Object.freeze({
  CONFIRMED: "COMPLETE",
  NOT_PUBLISHED: "WAIT_AND_RECHECK",
  STALE_GENERATION: "ABANDON",
  UNKNOWN: "INVESTIGATE",
  CONFLICTING_RESULT: "INVESTIGATE"
});

function decideRecovery(verification) {
  if (
    !verification ||
    typeof verification !== "object" ||
    Array.isArray(verification)
  ) {
    throw new Error("INVALID_VERIFICATION");
  }

  const status = verification.status;

  if (
    typeof status !== "string" ||
    !Object.prototype.hasOwnProperty.call(
      ACTIONS,
      status
    )
  ) {
    throw new Error("INVALID_VERIFICATION_STATUS");
  }

  const action = ACTIONS[status];

  return Object.freeze({
    status,
    action,
    allowAutomaticPublish: false,
    requiresRecheck:
      status === "NOT_PUBLISHED",
    requiresInvestigation:
      status === "UNKNOWN" ||
      status === "CONFLICTING_RESULT"
  });
}

module.exports = {
  ACTIONS,
  decideRecovery
};

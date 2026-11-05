"use strict";

const {
  decideRecovery
} = require("./video-render-recovery-policy");

/*
 * VideaPilot - Controleur experimental de reprise.
 *
 * Effectue au maximum maxChecks lectures successives.
 * Ne publie jamais.
 * N'utilise aucun timer.
 * Ne modifie aucune base de donnees.
 *
 * IMPORTANT :
 * Ce module est une simulation de decisions.
 * Les lectures consecutives ne prouvent pas
 * qu'une transaction concurrente est terminee.
 */

function createRecoveryChecker(verifier) {
  if (!verifier || typeof verifier.verify !== "function") {
    throw new Error("INVALID_VERIFIER");
  }

  async function check(options = {}, maxChecks = 3) {
    if (
      !Number.isSafeInteger(maxChecks) ||
      maxChecks < 1 ||
      maxChecks > 10
    ) {
      throw new Error("INVALID_MAX_CHECKS");
    }

    const history = [];

    for (let attempt = 1; attempt <= maxChecks; attempt++) {
      let verification;

      try {
        verification = await verifier.verify(options);
      } catch (error) {
        verification = {
          status: "UNKNOWN",
          reason: "VERIFIER_FAILED"
        };
      }

      let decision;

      try {
        decision = decideRecovery(verification);
      } catch (error) {
        decision = decideRecovery({
          status: "UNKNOWN"
        });
      }

      history.push(decision.status);

      if (decision.action !== "WAIT_AND_RECHECK") {
        return Object.freeze({
          action: decision.action,
          status: decision.status,
          attempts: attempt,
          limitReached: false,
          allowAutomaticPublish: false,
          history: Object.freeze([...history])
        });
      }
    }

    return Object.freeze({
      action: "WAIT_AND_RECHECK",
      status: "NOT_PUBLISHED",
      attempts: maxChecks,
      limitReached: true,
      allowAutomaticPublish: false,
      history: Object.freeze([...history])
    });
  }

  return Object.freeze({ check });
}

module.exports = {
  createRecoveryChecker
};

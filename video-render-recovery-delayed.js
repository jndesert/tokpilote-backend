"use strict";

const {
  decideRecovery
} = require("./video-render-recovery-policy");

/*
 * VideaPilot - Controleur de reprise temporisee.
 *
 * L'horloge est injectee pour permettre les tests.
 * Aucune publication automatique.
 * Aucun acces direct a PostgreSQL.
 * Aucun rendu FFmpeg.
 *
 * Une attente ne prouve pas qu'une transaction
 * concurrente est terminee.
 */

function createDelayedRecoveryChecker(verifier, sleep) {
  if (!verifier || typeof verifier.verify !== "function") {
    throw new Error("INVALID_VERIFIER");
  }

  if (typeof sleep !== "function") {
    throw new Error("INVALID_SLEEP");
  }

  async function check(options = {}, settings = {}) {
    const {
      maxChecks = 3,
      delayMs = 1000
    } = settings;

    if (
      !Number.isSafeInteger(maxChecks) ||
      maxChecks < 1 ||
      maxChecks > 10
    ) {
      throw new Error("INVALID_MAX_CHECKS");
    }

    if (
      !Number.isSafeInteger(delayMs) ||
      delayMs < 0 ||
      delayMs > 60000
    ) {
      throw new Error("INVALID_DELAY");
    }

    const history = [];
    let waits = 0;

    function result(decision, attempts, limitReached) {
      return Object.freeze({
        action: decision.action,
        status: decision.status,
        attempts,
        waits,
        limitReached,
        allowAutomaticPublish: false,
        history: Object.freeze([...history])
      });
    }

    for (let attempt = 1; attempt <= maxChecks; attempt++) {
      let verification;

      try {
        verification = await verifier.verify(options);
      } catch (error) {
        verification = { status: "UNKNOWN" };
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
        return result(decision, attempt, false);
      }

      if (attempt === maxChecks) {
        return result(decision, attempt, true);
      }

      try {
        await sleep(delayMs);
        waits++;
      } catch (error) {
        const unknown = decideRecovery({
          status: "UNKNOWN"
        });

        history.push("UNKNOWN");
        return result(unknown, attempt, false);
      }
    }

    throw new Error("UNREACHABLE_RECOVERY_STATE");
  }

  return Object.freeze({ check });
}

module.exports = {
  createDelayedRecoveryChecker
};

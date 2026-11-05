"use strict";

/*
 * VideaPilot - Observateur de publication.
 *
 * Plusieurs lectures peuvent etre necessaires
 * apres une erreur de connexion.
 *
 * NOT_PUBLISHED n'est jamais interprete
 * comme un echec definitif.
 *
 * Aucune ecriture, aucune publication automatique.
 */

function createPublicationObserver(verifier, sleep) {
  if (!verifier || typeof verifier.verify !== "function") {
    throw new Error("INVALID_VERIFIER");
  }

  if (typeof sleep !== "function") {
    throw new Error("INVALID_SLEEP");
  }

  async function observe(options, settings = {}) {
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

    function result(status, attempts, stable) {
      return Object.freeze({
        status,
        attempts,
        waits,
        stable,
        allowAutomaticPublish: false,
        history: Object.freeze([...history])
      });
    }

    for (let attempt = 1; attempt <= maxChecks; attempt++) {
      let verification;

      try {
        verification = await verifier.verify(options);
      } catch (error) {
        history.push("UNKNOWN");
        return result("UNKNOWN", attempt, false);
      }

      const status = verification?.status;

      if (
        ![
          "CONFIRMED",
          "NOT_PUBLISHED",
          "STALE_GENERATION",
          "CONFLICTING_RESULT",
          "UNKNOWN"
        ].includes(status)
      ) {
        history.push("UNKNOWN");
        return result("UNKNOWN", attempt, false);
      }

      history.push(status);

      if (status === "CONFIRMED") {
        return result("CONFIRMED", attempt, true);
      }

      if (status === "STALE_GENERATION") {
        return result("STALE_GENERATION", attempt, true);
      }

      if (status === "CONFLICTING_RESULT") {
        return result("CONFLICTING_RESULT", attempt, true);
      }

      if (status === "UNKNOWN") {
        return result("UNKNOWN", attempt, false);
      }

      // NOT_PUBLISHED : observation provisoire.
      // Ne jamais recommencer l'ecriture.

      if (attempt === maxChecks) {
        return result(
          "WAIT_AND_RECHECK",
          attempt,
          false
        );
      }

      try {
        await sleep(delayMs);
        waits++;
      } catch (error) {
        history.push("UNKNOWN");
        return result("UNKNOWN", attempt, false);
      }
    }

    throw new Error("UNREACHABLE_STATE");
  }

  return Object.freeze({ observe });
}

module.exports = {
  createPublicationObserver
};

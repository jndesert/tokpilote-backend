"use strict";

const {
  decideRecovery
} = require("./video-render-recovery-policy");

/*
 * VideaPilot - Reprise avec annulation rapide.
 *
 * Une annulation peut liberer le controleur
 * sans attendre la fin d'une lecture bloquee.
 *
 * ATTENTION :
 * La lecture sous-jacente n'est pas annulee.
 * Aucune publication automatique.
 */

function createFastAbortRecoveryChecker(verifier, sleep) {
  if (!verifier || typeof verifier.verify !== "function") {
    throw new Error("INVALID_VERIFIER");
  }

  if (typeof sleep !== "function") {
    throw new Error("INVALID_SLEEP");
  }

  async function check(options = {}, settings = {}) {
    const {
      maxChecks = 3,
      delayMs = 1000,
      signal
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

    if (
      signal !== undefined &&
      (
        !signal ||
        typeof signal.aborted !== "boolean" ||
        typeof signal.addEventListener !== "function" ||
        typeof signal.removeEventListener !== "function"
      )
    ) {
      throw new Error("INVALID_ABORT_SIGNAL");
    }

    const history = [];
    let waits = 0;

    function result(action, status, attempts, limitReached) {
      return Object.freeze({
        action,
        status,
        attempts,
        waits,
        limitReached,
        allowAutomaticPublish: false,
        history: Object.freeze([...history])
      });
    }

    function cancelled(attempts) {
      history.push("CANCELLED");

      return result(
        "CANCELLED",
        "CANCELLED",
        attempts,
        false
      );
    }

    async function raceAbort(operation) {
      if (signal?.aborted) {
        return { cancelled: true };
      }

      if (!signal) {
        return {
          cancelled: false,
          value: await operation()
        };
      }

      let onAbort;

      const aborted = new Promise(resolve => {
        onAbort = () => resolve({
          cancelled: true
        });

        signal.addEventListener(
          "abort",
          onAbort,
          { once: true }
        );
      });

      try {
        if (signal.aborted) {
          return { cancelled: true };
        }

        const completed = Promise.resolve()
          .then(operation)
          .then(value => ({
            cancelled: false,
            value
          }));

        return await Promise.race([
          completed,
          aborted
        ]);
      } finally {
        signal.removeEventListener(
          "abort",
          onAbort
        );
      }
    }

    for (let attempt = 1; attempt <= maxChecks; attempt++) {
      if (signal?.aborted) {
        return cancelled(attempt - 1);
      }

      let verification;

      try {
        const outcome = await raceAbort(
          () => verifier.verify(options)
        );

        if (outcome.cancelled || signal?.aborted) {
          return cancelled(attempt);
        }

        verification = outcome.value;
      } catch (error) {
        if (signal?.aborted) {
          return cancelled(attempt);
        }

        verification = { status: "UNKNOWN" };
      }

      if (signal?.aborted) {
        return cancelled(attempt);
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
        return result(
          decision.action,
          decision.status,
          attempt,
          false
        );
      }

      if (attempt === maxChecks) {
        return result(
          decision.action,
          decision.status,
          attempt,
          true
        );
      }

      try {
        const waitOutcome = await raceAbort(
          () => sleep(delayMs, signal)
        );

        if (waitOutcome.cancelled || signal?.aborted) {
          return cancelled(attempt);
        }

        waits++;
      } catch (error) {
        if (signal?.aborted) {
          return cancelled(attempt);
        }

        history.push("UNKNOWN");

        return result(
          "INVESTIGATE",
          "UNKNOWN",
          attempt,
          false
        );
      }
    }

    throw new Error("UNREACHABLE_RECOVERY_STATE");
  }

  return Object.freeze({ check });
}

module.exports = {
  createFastAbortRecoveryChecker
};

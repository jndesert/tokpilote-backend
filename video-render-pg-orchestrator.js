"use strict";

/*
 * Orchestrateur experimental VidéaPilot.
 *
 * Le verrou et le watchdog doivent etre configures
 * de maniere coherente par un futur adaptateur.
 *
 * Ce module ne garantit pas a lui seul la possession
 * continue d'un verrou PostgreSQL.
 *
 * Ne pas utiliser en production.
 */

function createRenderPgOrchestrator(options = {}) {
  const { lock, watchdog, cancellation } = options;

  if (!lock || typeof lock.run !== "function") {
    throw new Error("INVALID_ORCHESTRATOR_LOCK");
  }

  if (
    !watchdog ||
    typeof watchdog.start !== "function" ||
    typeof watchdog.stop !== "function"
  ) {
    throw new Error("INVALID_ORCHESTRATOR_WATCHDOG");
  }

  if (
    !cancellation ||
    !cancellation.signal ||
    typeof cancellation.throwIfCancelled !== "function"
  ) {
    throw new Error("INVALID_ORCHESTRATOR_CANCELLATION");
  }

  let active = false;

  async function run(task) {
    if (typeof task !== "function") {
      throw new Error("INVALID_RENDER_TASK");
    }

    if (active) {
      throw new Error("ORCHESTRATOR_BUSY");
    }

    cancellation.throwIfCancelled();
    active = true;

    try {
      return await lock.run(async () => {
        cancellation.throwIfCancelled();

        const started = watchdog.start();

        if (started !== true) {
          throw new Error("WATCHDOG_START_FAILED");
        }

        try {
          const result = await task(cancellation.signal);

          cancellation.throwIfCancelled();

          return result;
        } finally {
          watchdog.stop();
        }
      }, cancellation);
    } finally {
      active = false;
    }
  }

  return Object.freeze({
    run,
    isActive: () => active
  });
}

module.exports = {
  createRenderPgOrchestrator
};

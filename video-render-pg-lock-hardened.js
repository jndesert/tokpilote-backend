"use strict";

/*
 * VidéaPilot - Verrou PostgreSQL experimental renforce.
 *
 * Ce module n'est pas connecte a la production.
 *
 * Une panne du watchdog rend la session suspecte.
 * Dans ce cas, on evite pg_advisory_unlock et on
 * demande au pool de detruire la connexion.
 *
 * IMPORTANT :
 * Ce module ne garantit pas la possession continue
 * du verrou si la session PostgreSQL disparait
 * silencieusement pendant un rendu.
 */

const RENDER_LOCK_KEY = 20261104;

function createPostgresRenderLock(pool) {
  if (!pool || typeof pool.connect !== "function") {
    throw new Error("INVALID_RENDER_LOCK_POOL");
  }

  async function run(task, cancellation = null) {
    if (typeof task !== "function") {
      throw new Error("INVALID_RENDER_TASK");
    }

    const client = await pool.connect();

    let acquired = false;
    let acquisitionAttempted = false;
    let connectionLost = false;
    let unsafeSession = false;
    let taskError = null;
    let cleanupError = null;
    let taskResult;

    function isWatchdogFailure() {
      return Boolean(
        cancellation &&
        cancellation.signal &&
        cancellation.signal.aborted &&
        cancellation.signal.reason &&
        cancellation.signal.reason.message ===
          "RENDER_LOCK_WATCHDOG_FAILED"
      );
    }

    function onConnectionError() {
      connectionLost = true;
      unsafeSession = true;

      if (
        cancellation &&
        typeof cancellation.cancel === "function"
      ) {
        cancellation.cancel("RENDER_LOCK_CONNECTION_LOST");
      }
    }

    if (typeof client.on === "function") {
      client.on("error", onConnectionError);
    }

    try {
      acquisitionAttempted = true;

      const result = await client.query(
        "SELECT pg_try_advisory_lock($1) AS acquired",
        [RENDER_LOCK_KEY]
      );

      if (result.rows[0]?.acquired !== true) {
        acquisitionAttempted = false;
        throw new Error("VIDEO_RENDER_BUSY");
      }

      acquired = true;

      if (connectionLost) {
        throw new Error("RENDER_LOCK_CONNECTION_LOST");
      }

      if (
        cancellation &&
        typeof cancellation.throwIfCancelled === "function"
      ) {
        cancellation.throwIfCancelled();
      }

      taskResult = await task();

      if (
        cancellation &&
        cancellation.signal &&
        cancellation.signal.aborted
      ) {
        throw cancellation.signal.reason ||
          new Error("RENDER_CANCELLED");
      }

      if (connectionLost) {
        throw new Error("RENDER_LOCK_CONNECTION_LOST");
      }

    } catch (error) {
      taskError = error;

      if (acquisitionAttempted && !acquired) {
        unsafeSession = true;
      }

    } finally {
      // Un timeout du watchdog rend la session suspecte,
      // meme si aucun evenement "error" n'a ete emis.
      if (isWatchdogFailure()) {
        unsafeSession = true;
      }

      // Ne pas envoyer de requete sur une session suspecte.
      if (acquired && !connectionLost && !unsafeSession) {
        try {
          const unlockResult = await client.query(
            "SELECT pg_advisory_unlock($1) AS released",
            [RENDER_LOCK_KEY]
          );

          if (unlockResult.rows[0]?.released !== true) {
            throw new Error("RENDER_LOCK_RELEASE_FAILED");
          }

        } catch (error) {
          cleanupError = error;
          unsafeSession = true;
        }
      }

      if (typeof client.removeListener === "function") {
        client.removeListener(
          "error",
          onConnectionError
        );
      }

      try {
        client.release(
          unsafeSession
            ? new Error("RENDER_LOCK_SESSION_UNSAFE")
            : undefined
        );
      } catch (error) {
        if (!cleanupError) {
          cleanupError = error;
        }
      }
    }

    if (taskError && cleanupError) {
      throw new AggregateError(
        [taskError, cleanupError],
        "RENDER_AND_LOCK_CLEANUP_FAILED"
      );
    }

    if (taskError) {
      throw taskError;
    }

    if (cleanupError) {
      throw cleanupError;
    }

    return taskResult;
  }

  return Object.freeze({ run });
}

module.exports = {
  RENDER_LOCK_KEY,
  createPostgresRenderLock
};

"use strict";

/*
 * Watchdog PostgreSQL experimental.
 *
 * SELECT 1 controle la reponse de la connexion,
 * mais ne prouve pas la possession du verrou.
 *
 * Un timeout JavaScript ne termine pas necessairement
 * la requete PostgreSQL sous-jacente.
 *
 * Ne pas integrer en production sans validation
 * supplementaire.
 */

function createPostgresRenderWatchdog(options = {}) {
  const {
    client,
    cancellation,
    intervalMs = 1000,
    queryTimeoutMs = 2000
  } = options;

  if (
    !client ||
    typeof client.query !== "function"
  ) {
    throw new Error("INVALID_WATCHDOG_CLIENT");
  }

  if (
    !cancellation ||
    typeof cancellation.cancel !== "function" ||
    !cancellation.signal ||
    typeof cancellation.signal.aborted !== "boolean"
  ) {
    throw new Error("INVALID_WATCHDOG_CANCELLATION");
  }

  if (
    !Number.isInteger(intervalMs) ||
    intervalMs < 100
  ) {
    throw new Error("INVALID_WATCHDOG_INTERVAL");
  }

  if (
    !Number.isInteger(queryTimeoutMs) ||
    queryTimeoutMs < 100
  ) {
    throw new Error("INVALID_WATCHDOG_QUERY_TIMEOUT");
  }

  let running = false;
  let checking = false;
  let timer = null;
  let checks = 0;
  let failures = 0;
  let timeouts = 0;

  function stop() {
    running = false;

    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function checkConnection() {
    if (!running || checking) {
      return;
    }

    checking = true;

    let timeoutHandle = null;

    try {
      const queryPromise = Promise.resolve().then(
        () => client.query("SELECT 1")
      );

      const timeoutPromise = new Promise(
        (_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(
              new Error("WATCHDOG_QUERY_TIMEOUT")
            );
          }, queryTimeoutMs);
        }
      );

      await Promise.race([
        queryPromise,
        timeoutPromise
      ]);

      checks++;

    } catch (error) {
      failures++;

      if (
        error &&
        error.message === "WATCHDOG_QUERY_TIMEOUT"
      ) {
        timeouts++;
      }

      cancellation.cancel(
        "RENDER_LOCK_WATCHDOG_FAILED"
      );

      stop();

    } finally {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }

      checking = false;
    }
  }

  function schedule() {
    if (!running) {
      return;
    }

    timer = setTimeout(async () => {
      await checkConnection();

      if (running) {
        schedule();
      }
    }, intervalMs);
  }

  function start() {
    if (running || cancellation.signal.aborted) {
      return false;
    }

    running = true;
    schedule();

    return true;
  }

  return Object.freeze({
    start,
    stop,
    checkNow: checkConnection,
    getStatus: () => Object.freeze({
      running,
      checking,
      checks,
      failures,
      timeouts
    })
  });
}

module.exports = {
  createPostgresRenderWatchdog
};

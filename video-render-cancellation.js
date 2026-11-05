"use strict";

function createRenderCancellation() {
  const controller = new AbortController();

  function cancel(reason = "RENDER_CANCELLED") {
    if (controller.signal.aborted) {
      return false;
    }

    const message =
      typeof reason === "string" && reason.length > 0
        ? reason
        : "RENDER_CANCELLED";

    controller.abort(new Error(message));

    return true;
  }

  function throwIfCancelled() {
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
  }

  return Object.freeze({
    signal: controller.signal,
    cancel,
    throwIfCancelled,
    isCancelled: () => controller.signal.aborted
  });
}

module.exports = {
  createRenderCancellation
};

"use strict";

function createRenderConcurrencyGuard() {
  let active = false;

  async function run(task) {
    if (typeof task !== "function") {
      throw new Error("INVALID_RENDER_TASK");
    }

    if (active) {
      throw new Error("VIDEO_RENDER_BUSY");
    }

    active = true;

    try {
      return await task();
    } finally {
      active = false;
    }
  }

  return {
    run,
    isBusy: () => active
  };
}

module.exports = {
  createRenderConcurrencyGuard
};

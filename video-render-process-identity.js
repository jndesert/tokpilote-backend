"use strict";

const os = require("node:os");
const { randomUUID } = require("node:crypto");

const instanceId = randomUUID();

const startedAtEstimateMs =
  Date.now() - process.uptime() * 1000;

function getCurrentProcessIdentity() {
  return Object.freeze({
    pid: process.pid,
    instanceId,
    platform: os.platform(),
    hostname: os.hostname(),
    startedAtEstimate: new Date(
      startedAtEstimateMs
    ).toISOString()
  });
}

function compareProcessIdentities(first, second) {
  if (
    !first ||
    !second ||
    typeof first.instanceId !== "string" ||
    typeof second.instanceId !== "string"
  ) {
    throw new Error("INVALID_PROCESS_IDENTITY");
  }

  return (
    first.pid === second.pid &&
    first.instanceId === second.instanceId &&
    first.platform === second.platform &&
    first.hostname === second.hostname
  );
}

module.exports = {
  getCurrentProcessIdentity,
  compareProcessIdentities
};

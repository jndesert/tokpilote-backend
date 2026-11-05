"use strict";

const {
  inspectAbandonedRenderDirectories
} = require("./video-render-temp-cleanup");

function inspectInactiveRenderDirectories(options = {}) {
  const { registry, ...inspectionOptions } = options;

  if (
    !registry ||
    typeof registry.isActive !== "function" ||
    typeof registry.listActive !== "function"
  ) {
    throw new Error("INVALID_RENDER_REGISTRY");
  }

  const inspection = inspectAbandonedRenderDirectories(
    inspectionOptions
  );

  const inactiveCandidates = [];
  const activeExcluded = [];

  for (const candidate of inspection.candidates) {
    if (registry.isActive(candidate.path)) {
      activeExcluded.push(candidate);
    } else {
      inactiveCandidates.push(candidate);
    }
  }

  return {
    inspectedRoot: inspection.inspectedRoot,
    minimumAgeHours: inspection.minimumAgeHours,
    inspectedCandidateCount: inspection.candidateCount,
    candidateCount: inactiveCandidates.length,
    activeExcludedCount: activeExcluded.length,
    candidates: inactiveCandidates,
    activeExcluded
  };
}

module.exports = {
  inspectInactiveRenderDirectories
};

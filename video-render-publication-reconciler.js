"use strict";

/*
 * VideaPilot - Reconciliation de publication.
 *
 * Combine un publisher write-once et un verifier
 * en lecture seule.
 *
 * Une verification apres refus ne declenche
 * jamais une nouvelle tentative de publication.
 *
 * Experimental : aucune connexion directe
 * a PostgreSQL.
 */

function createPublicationReconciler(publisher, verifier) {
  if (!publisher || typeof publisher.publish !== "function") {
    throw new Error("INVALID_PUBLISHER");
  }

  if (!verifier || typeof verifier.verify !== "function") {
    throw new Error("INVALID_VERIFIER");
  }

  function outcome(status, accepted, verified) {
    return Object.freeze({
      status,
      accepted,
      verified,
      allowAutomaticPublish: false
    });
  }

  async function publishAndReconcile(options) {
    let publication;

    try {
      publication = await publisher.publish(options);
    } catch (error) {
      // Une erreur d'ecriture peut etre ambigue.
      // Ne jamais reessayer automatiquement.
      return outcome("UNKNOWN", false, false);
    }

    if (!publication || typeof publication.accepted !== "boolean") {
      return outcome("UNKNOWN", false, false);
    }

    if (publication.accepted === true) {
      if (publication.status !== "PUBLISHED") {
        return outcome("UNKNOWN", false, false);
      }

      return outcome("PUBLISHED", true, false);
    }

    // Une ecriture refusee exige une lecture.
    let verification;

    try {
      verification = await verifier.verify(options);
    } catch (error) {
      return outcome("UNKNOWN", false, false);
    }

    if (
      !verification ||
      typeof verification.status !== "string"
    ) {
      return outcome("UNKNOWN", false, false);
    }

    switch (verification.status) {
      case "CONFIRMED":
        return outcome("ALREADY_PUBLISHED", false, true);

      case "CONFLICTING_RESULT":
        return outcome("CONFLICTING_RESULT", false, true);

      case "STALE_GENERATION":
        return outcome("STALE_GENERATION", false, true);

      case "NOT_PUBLISHED":
        return outcome("NOT_PUBLISHED", false, true);

      default:
        return outcome("UNKNOWN", false, true);
    }
  }

  return Object.freeze({ publishAndReconcile });
}

module.exports = {
  createPublicationReconciler
};

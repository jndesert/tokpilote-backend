"use strict";

/*
 * VideaPilot - Reconciliation apres erreur d'ecriture.
 *
 * Le resultat d'une ecriture peut etre inconnu
 * si la connexion est perdue.
 *
 * Apres une erreur :
 * - une seule verification en lecture seule ;
 * - aucune nouvelle tentative d'ecriture ;
 * - aucune publication automatique.
 *
 * Module experimental sans connexion directe
 * a PostgreSQL.
 */

function createUncertainPublicationReconciler(
  publisher,
  verifier
) {
  if (
    !publisher ||
    typeof publisher.publish !== "function"
  ) {
    throw new Error("INVALID_PUBLISHER");
  }

  if (
    !verifier ||
    typeof verifier.verify !== "function"
  ) {
    throw new Error("INVALID_VERIFIER");
  }

  function result(status, accepted, verified) {
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
      // La requete peut avoir ete appliquee
      // avant la perte de connexion.
      // Ne jamais relancer l'ecriture.

      let verification;

      try {
        verification = await verifier.verify(options);
      } catch (readError) {
        return result("UNKNOWN", false, false);
      }

      if (
        !verification ||
        typeof verification.status !== "string"
      ) {
        return result("UNKNOWN", false, false);
      }

      switch (verification.status) {
        case "CONFIRMED":
          return result(
            "ALREADY_PUBLISHED",
            false,
            true
          );

        case "CONFLICTING_RESULT":
          return result(
            "CONFLICTING_RESULT",
            false,
            true
          );

        case "STALE_GENERATION":
          return result(
            "STALE_GENERATION",
            false,
            true
          );

        case "NOT_PUBLISHED":
          return result(
            "NOT_PUBLISHED",
            false,
            true
          );

        default:
          return result("UNKNOWN", false, true);
      }
    }

    if (
      publication &&
      publication.accepted === true &&
      publication.status === "PUBLISHED"
    ) {
      return result("PUBLISHED", true, false);
    }

    // Le module est volontairement limite
    // au traitement des erreurs d'ecriture.
    // Les refus normaux sont conservateurs.
    return result("RECHECK_REQUIRED", false, false);
  }

  return Object.freeze({
    publishAndReconcile
  });
}

module.exports = {
  createUncertainPublicationReconciler
};


const assert = require("node:assert/strict");

// Simule le contrôle des réponses OpenAI.
function verifierGeneration(response) {
  const script = response.output_text || "";

  const generationIncomplete =
    response.status === "incomplete" ||
    response.incomplete_details?.reason === "max_output_tokens";

  if (generationIncomplete) {
    return {
      success: false,
      incomplete: true,
      script
    };
  }

  if (response.status !== "completed" || !script.trim()) {
    throw new Error("Réponse IA non terminée ou vide.");
  }

  return {
    success: true,
    script
  };
}

// TEST 1 : génération complète
const resultat1 = verifierGeneration({
  status: "completed",
  output_text: "Scène 1 : Léo découvre ses pouvoirs."
});

assert.equal(resultat1.success, true);
console.log("✅ TEST 1 : scénario complet accepté");

// TEST 2 : génération interrompue
const resultat2 = verifierGeneration({
  status: "incomplete",
  incomplete_details: {
    reason: "max_output_tokens"
  },
  output_text: "Scène 1 : Léo commence à..."
});

assert.equal(resultat2.success, false);
assert.equal(resultat2.incomplete, true);
console.log("✅ TEST 2 : scénario interrompu détecté");

// TEST 3 : réponse vide
assert.throws(() => verifierGeneration({
  status: "completed",
  output_text: ""
}));

console.log("✅ TEST 3 : réponse vide rejetée");
console.log("🎉 Tous les tests simulés ont réussi.");

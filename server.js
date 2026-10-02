require("dotenv").config();

const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Configuration TikTok
const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;

const REDIRECT_URI =
  "https://tokpilote-backend.onrender.com/auth/tiktok/callback";

// Stockage temporaire des "state" OAuth.
// Nous améliorerons ce stockage avant la mise en production.
const oauthStates = new Map();

// Accueil du backend
app.get("/", (req, res) => {
  res.status(200).json({
    app: "TokPilote Backend",
    status: "en ligne"
  });
});

// Contrôle Render
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok"
  });
});

// Démarrer la connexion TikTok
app.get("/auth/tiktok/login", (req, res) => {
  if (!TIKTOK_CLIENT_KEY) {
    return res.status(500).json({
      error: "TIKTOK_CLIENT_KEY n'est pas configurée sur le serveur."
    });
  }

  const state = crypto.randomBytes(32).toString("hex");

  oauthStates.set(state, Date.now());

  // Supprime le state après 10 minutes
  setTimeout(() => {
    oauthStates.delete(state);
  }, 10 * 60 * 1000);

  const params = new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY,
    scope: "user.info.basic",
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    state
  });

  const authorizationUrl =
    `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;

  return res.redirect(authorizationUrl);
});

// Retour OAuth envoyé par TikTok
app.get("/auth/tiktok/callback", (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.status(400).json({
      success: false,
      error,
      description: error_description || "Autorisation TikTok refusée."
    });
  }

  if (!state || !oauthStates.has(state)) {
    return res.status(400).json({
      success: false,
      error: "State OAuth invalide ou expiré."
    });
  }

  oauthStates.delete(state);

  if (!code) {
    return res.status(400).json({
      success: false,
      error: "Code d'autorisation TikTok manquant."
    });
  }

  // À l'étape suivante, ce code sera échangé
  // côté serveur contre un access token TikTok.
  return res.status(200).json({
    success: true,
    message: "Retour TikTok reçu correctement."
  });
});

app.listen(PORT, () => {
  console.log(`TokPilote Backend démarré sur le port ${PORT}`);
});

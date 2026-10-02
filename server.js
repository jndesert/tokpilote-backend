require("dotenv").config();

const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;

const REDIRECT_URI =
  "https://tokpilote-backend.onrender.com/auth/tiktok/callback";

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

// Démarre la connexion TikTok
app.get("/auth/tiktok", (req, res) => {
  if (!TIKTOK_CLIENT_KEY) {
    return res.status(500).json({
      error: "TIKTOK_CLIENT_KEY manquante"
    });
  }

  const params = new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY,
    response_type: "code",
    scope: "user.info.basic",
    redirect_uri: REDIRECT_URI
  });

  const authorizationUrl =
    `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;

  res.redirect(authorizationUrl);
});

// Retour de TikTok après autorisation
app.get("/auth/tiktok/callback", (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.status(400).json({
      success: false,
      error,
      description: error_description || null
    });
  }

  if (!code) {
    return res.status(400).json({
      success: false,
      error: "Code d'autorisation TikTok absent"
    });
  }

  res.status(200).json({
    success: true,
    message: "TikTok a bien redirigé l'utilisateur vers TokPilote.",
    next_step: "Échange du code contre un access token."
  });
});

app.listen(PORT, () => {
  console.log(`TokPilote Backend démarré sur le port ${PORT}`);
});

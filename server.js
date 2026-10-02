require("dotenv").config();

const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Page d'accueil du backend
app.get("/", (req, res) => {
  res.status(200).json({
    app: "TokPilote Backend",
    status: "online"
  });
});

// Route de contrôle pour Render
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok"
  });
});

app.listen(PORT, () => {
  console.log(`TokPilote Backend démarré sur le port ${PORT}`);
});

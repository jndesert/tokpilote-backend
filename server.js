
require("dotenv").config();

const express = require("express");
const crypto = require("node:crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;

const REDIRECT_URI =
  "https://videapilot-backend.onrender.com/auth/tiktok/callback";

const WEBSITE_URL =
  "https://jndesert.github.io/videapilot/";

app.disable("x-powered-by");
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    app: "VidéaPilot Backend",
    status: "en ligne"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

function readCookie(req, name) {
  const cookies = (req.headers.cookie || "").split(";");

  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;

    const key = cookie.slice(0, separator).trim();
    const value = cookie.slice(separator + 1).trim();

    if (key === name) return value;
  }

  return null;
}

const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: 10 * 60 * 1000
};

app.get("/auth/tiktok", (req, res) => {
  if (!CLIENT_KEY || !CLIENT_SECRET) {
    return res.status(500).send(
      "Configuration TikTok incomplète."
    );
  }

  const state = crypto.randomBytes(32).toString("hex");

  res.cookie("videapilot_oauth_state", state, cookieOptions);

  const params = new URLSearchParams({
    client_key: CLIENT_KEY,
    response_type: "code",
    scope: "user.info.basic",
    redirect_uri: REDIRECT_URI,
    state
  });

  res.redirect(
    "https://www.tiktok.com/v2/auth/authorize/?" +
    params.toString()
  );
});

app.get("/auth/tiktok/callback", async (req, res) => {
  const { code, state, error } = req.query;

  const expectedState = readCookie(
    req,
    "videapilot_oauth_state"
  );

  res.clearCookie("videapilot_oauth_state", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/"
  });

  if (
    typeof state !== "string" ||
    !expectedState ||
    state.length !== expectedState.length ||
    !crypto.timingSafeEqual(
      Buffer.from(state),
      Buffer.from(expectedState)
    )
  ) {
    return res.status(403).send(
      "Session de connexion invalide. Recommencez depuis VidéaPilot."
    );
  }

  if (error) {
    return res.status(400).send(
      "Connexion TikTok annulée ou refusée."
    );
  }

  if (typeof code !== "string" || !code) {
    return res.status(400).send(
      "Code d'autorisation TikTok absent."
    );
  }

  try {
    const params = new URLSearchParams({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI
    });

    const response = await fetch(
      "https://open.tiktokapis.com/v2/oauth/token/",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body: params.toString(),
        signal: AbortSignal.timeout(15000)
      }
    );

    const data = await response.json();

    if (!response.ok || !data.access_token) {
      console.error("Échec OAuth TikTok", {
        status: response.status,
        error: data.error || "unknown"
      });

      return res.status(502).send(
        "Connexion TikTok impossible. Veuillez réessayer."
      );
    }

    // Les jetons ne sont jamais envoyés au navigateur.
    // À terme, ils devront être conservés dans un
    // stockage serveur sécurisé, lié à une session.

    res.set("Cache-Control", "no-store");

    res.status(200).send(`
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport"
              content="width=device-width, initial-scale=1">
        <title>VidéaPilot — Connexion TikTok</title>
      </head>
      <body style="
        font-family:Arial,sans-serif;
        text-align:center;
        padding:60px 20px;
        background:#07152e;
        color:white;
      ">
        <h1>VidéaPilot</h1>
        <h2>Connexion TikTok autorisée</h2>
        <p>
          Le serveur a obtenu une autorisation TikTok.
        </p>
        <p>
          Cette démonstration ne conserve pas
          encore votre session de connexion.
        </p>
        <a href="${WEBSITE_URL}"
           style="color:#4ce4ed">
          Retourner à VidéaPilot
        </a>
      </body>
      </html>
    `);

  } catch (err) {
    console.error("Erreur de connexion TikTok", err.message);

    res.status(502).send(
      "Erreur temporaire de connexion TikTok."
    );
  }
});

app.listen(PORT, () => {
  console.log(
    `VidéaPilot Backend démarré sur le port ${PORT}`
  );
});

require("dotenv").config();

const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const crypto = require("node:crypto");
const path = require("node:path");

const app = express();
const PORT = process.env.PORT || 3000;

// Connexion à la base PostgreSQL de VidéaPilot
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
// Sessions sécurisées stockées dans PostgreSQL
app.set("trust proxy", 1);

app.use(
  session({
    store: new pgSession({
      pool: pool,
      tableName: "user_sessions",
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;

const REDIRECT_URI =
  "https://videapilot-api.onrender.com/auth/tiktok/callback";

const WEBSITE_URL = "https://videapilot.fr/";

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

// Tableau de bord accessible uniquement aux utilisateurs connectés
app.get("/dashboard", (req, res) => {
  if (!req.session?.tiktokUser?.openId) {
    return res.redirect("/auth/tiktok");
  }

  res.set("Cache-Control", "no-store");

  res.sendFile(
    path.join(__dirname, "dashboard.html")
  );
});

// Profil TikTok de l'utilisateur connecté
app.get("/api/me", (req, res) => {
  res.set("Cache-Control", "no-store");

  const user = req.session?.tiktokUser;

  if (!user?.openId) {
    return res.status(401).json({
      authenticated: false,
      message: "Utilisateur non connecté"
    });
  }

  res.json({
    authenticated: true,
    user: {
      displayName: user.displayName,
      avatarUrl: user.avatarUrl
    }
  });
});

// Déconnexion sécurisée de VidéaPilot
app.post("/auth/logout", (req, res) => {
  // Refuser les demandes provenant d'un autre site
  const origin = req.get("Origin");

  if (origin !== "https://videapilot-api.onrender.com") {
    return res.status(403).json({
      message: "Origine non autorisée."
    });
  }
  
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({
        message: "Déconnexion impossible."
      });
    }

    res.clearCookie("connect.sid", {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "lax"
    });

    res.set("Cache-Control", "no-store");
    res.json({ success: true });
  });
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

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

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

    // Le jeton reste sur le serveur et n'est pas conservé.
    let profile = null;

    try {
      const profileResponse = await fetch(
        "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url",
        {
          headers: {
            Authorization: `Bearer ${data.access_token}`
          },
          signal: AbortSignal.timeout(10000)
        }
      );

      const profileData = await profileResponse.json();

      if (
        profileResponse.ok &&
        profileData.data?.user &&
        (
          !profileData.error?.code ||
          profileData.error.code === "ok"
        )
      ) {
        profile = profileData.data.user;
      } else {
        console.warn("Profil TikTok indisponible", {
          status: profileResponse.status,
          error: profileData.error?.code || "unknown"
        });
      }
    } catch (profileError) {
      console.warn(
        "Erreur temporaire du profil TikTok",
        profileError.message
      );
    }

    const name = profile?.display_name
      ? escapeHtml(profile.display_name)
      : null;

    let avatarMarkup = "";

    if (typeof profile?.avatar_url === "string") {
      try {
        const url = new URL(profile.avatar_url);

        if (url.protocol === "https:") {
          avatarMarkup = `
            <img
              src="${escapeHtml(url.href)}"
              alt="Photo de profil TikTok"
              width="96"
              height="96"
              style="border-radius:50%;object-fit:cover"
            >
          `;
        }
      } catch {
        // URL invalide : aucune image affichée.
      }
    }

        // Enregistrer le profil TikTok dans la session PostgreSQL
    if (!profile?.open_id) {
      return res.status(502).send(
        "Impossible de récupérer l'identifiant TikTok. Veuillez réessayer."
      );
    }

    req.session.tiktokUser = {
      openId: profile.open_id,
      displayName: profile.display_name || "Utilisateur TikTok",
      avatarUrl: profile.avatar_url || null
    };

    await new Promise((resolve, reject) => {
      req.session.save((err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    res.set("Cache-Control", "no-store");

    res.status(200).send(`
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport"
              content="width=device-width, initial-scale=1">
        <meta name="referrer" content="no-referrer">
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

        ${
          profile
            ? `
              <section>
                ${avatarMarkup}
                <p>
                  ${
                    name
                      ? `Bienvenue, <strong>${name}</strong> !`
                      : "Profil TikTok récupéré."
                  }
                </p>
              </section>
            `
            : `
              <p>
                Connexion réussie. Les informations
                du profil ne sont pas disponibles
                pour le moment.
              </p>
            `
        }

        <p>
          Cette version ne conserve pas encore
          votre session de connexion.
        </p>

        <a href="${WEBSITE_URL}"
           style="color:#4ce4ed">
          Retourner à VidéaPilot
        </a>
      </body>
      </html>
    `);
  } catch (err) {
    console.error(
      "Erreur de connexion TikTok",
      err.message
    );

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

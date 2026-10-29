require("dotenv").config();

const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
// SDK OpenAI pour la génération de scripts vidéo
const OpenAI = require("openai");
const crypto = require("node:crypto");
const path = require("node:path");

const app = express();
// Connexion sécurisée à l'API OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});
const PORT = process.env.PORT || 3000;

// Connexion à la base PostgreSQL de VidéaPilot
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Création de la table des projets vidéo
async function initializeVideoProjects() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_projects (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      title VARCHAR(120) NOT NULL,
      topic TEXT NOT NULL,
      script TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log("Table des projets vidéo prête");
}

initializeVideoProjects().catch((error) => {
  console.error(
    "Erreur initialisation projets vidéo :",
    error.message
  );
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
// Enregistrer un projet vidéo dans PostgreSQL
// Supprimer un projet vidéo
app.delete("/api/videos/:id", async (req, res) => {
  res.set("Cache-Control", "no-store");

  // Vérifier l'origine de la requête
  const origin = req.get("Origin");

  if (origin !== "https://videapilot-api.onrender.com") {
    return res.status(403).json({
      message: "Origine non autorisée."
    });
  }

  // Vérifier la connexion TikTok
  const userId = req.session?.tiktokUser?.openId;

  if (!userId) {
    return res.status(401).json({
      message: "Connexion TikTok requise."
    });
  }

  const id = req.params.id;

  if (!/^[1-9]\d*$/.test(id)) {
    return res.status(400).json({
      message: "Identifiant de projet invalide."
    });
  }

  try {
    const result = await pool.query(
      `DELETE FROM video_projects
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Projet introuvable."
      });
    }

    return res.json({
      success: true,
      message: "Projet supprimé avec succès."
    });

  } catch (error) {
    console.error("Erreur suppression projet :", error.message);

    return res.status(500).json({
      message: "Impossible de supprimer le projet."
    });
  }
});
app.post("/api/videos", async (req, res) => {
  // Autoriser uniquement les requêtes provenant de VidéaPilot
  const origin = req.get("Origin");

  if (origin !== "https://videapilot-api.onrender.com") {
    return res.status(403).json({
      message: "Origine non autorisée."
    });
  }
  res.set("Cache-Control", "no-store");

  const userId = req.session?.tiktokUser?.openId;

  if (!userId) {
    return res.status(401).json({
      message: "Connexion TikTok requise."
    });
  }

  const { title, topic, script } = req.body || {};

  if (
    typeof title !== "string" ||
    typeof topic !== "string" ||
    (script !== undefined && typeof script !== "string") ||
    !title.trim() ||
    !topic.trim() ||
    title.trim().length > 120 ||
    topic.length > 5000 ||
    (script && script.length > 20000)
  ) {
    return res.status(400).json({
      message: "Informations du projet invalides."
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO video_projects
       (user_id, title, topic, script)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, created_at`,
      [
        userId,
        title.trim(),
        topic.trim(),
        script || ""
      ]
    );

    return res.status(201).json({
      success: true,
      project: result.rows[0]
    });
  } catch (error) {
    console.error(
      "Erreur enregistrement projet vidéo :",
      error.message
    );

    return res.status(500).json({
      message: "Impossible d'enregistrer le projet."
    });
  }
});

// Récupérer les projets vidéo de l'utilisateur connecté
// Modifier un projet vidéo existant
app.put("/api/videos/:id", async (req, res) => {
  res.set("Cache-Control", "no-store");

  const origin = req.get("Origin");
  if (origin !== "https://videapilot-api.onrender.com") {
    return res.status(403).json({
      message: "Origine non autorisée."
    });
  }

  const userId = req.session?.tiktokUser?.openId;

  if (!userId) {
    return res.status(401).json({
      message: "Connexion TikTok requise."
    });
  }

  const id = req.params.id;
  const { title, topic, script } = req.body || {};

  if (!/^[1-9]\d*$/.test(id)) {
    return res.status(400).json({
      message: "Identifiant de projet invalide."
    });
  }

  if (
    typeof title !== "string" ||
    typeof topic !== "string" ||
    (script !== undefined && typeof script !== "string") ||
    !title.trim() ||
    !topic.trim() ||
    title.trim().length > 120 ||
    topic.length > 5000 ||
    (script && script.length > 20000)
  ) {
    return res.status(400).json({
      message: "Informations du projet invalides."
    });
  }

  try {
    const result = await pool.query(
      `UPDATE video_projects
       SET title = $1, topic = $2, script = $3
       WHERE id = $4 AND user_id = $5
       RETURNING id, title, topic, script, created_at`,
      [title.trim(), topic.trim(), script || "", id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Projet introuvable."
      });
    }

    return res.json({
      success: true,
      project: result.rows[0]
    });
  } catch (error) {
    console.error("Erreur modification projet :", error.message);

    return res.status(500).json({
      message: "Impossible de modifier le projet."
    });
  }
});

// Générer un script vidéo avec l'intelligence artificielle
// Créer la table des quotas de génération IA
async function initializeAiUsage() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      user_id TEXT NOT NULL,
      window_start TIMESTAMPTZ NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id)
    )
  `);
}

// Initialiser la table des quotas IA au démarrage
initializeAiUsage()
  .then(() => {
    console.log("Table ai_usage prête.");
  })
  .catch((error) => {
    console.error(
      "Erreur initialisation table ai_usage :",
      error.message
    );
  });

// Réserver une génération IA dans PostgreSQL
async function reserveAiGeneration(userId) {
  const result = await pool.query(
    `
    INSERT INTO ai_usage (
      user_id,
      window_start,
      request_count
    )
    VALUES ($1, NOW(), 1)

    ON CONFLICT (user_id)
    DO UPDATE SET
      window_start = CASE
        WHEN ai_usage.window_start <= NOW() - INTERVAL '1 hour'
        THEN NOW()
        ELSE ai_usage.window_start
      END,

      request_count = CASE
        WHEN ai_usage.window_start <= NOW() - INTERVAL '1 hour'
        THEN 1
        ELSE ai_usage.request_count + 1
      END

    WHERE
      ai_usage.window_start <= NOW() - INTERVAL '1 hour'
      OR ai_usage.request_count < 5

    RETURNING request_count
    `,
    [userId]
  );

  return {
    allowed: result.rows.length > 0,
    count: result.rows[0]?.request_count ?? 5
  };
}

// Génération de scripts IA avec quota PostgreSQL
app.post("/api/ai/generate-script", async (req, res) => {
  res.set("Cache-Control", "no-store");

  // Vérifier l'origine de la requête
  if (req.get("Origin") !== "https://videapilot-api.onrender.com") {
    return res.status(403).json({
      message: "Origine non autorisée."
    });
  }

  // Vérifier la connexion TikTok
  if (!req.session?.tiktokUser?.openId) {
    return res.status(401).json({
      message: "Connexion TikTok requise."
    });
  }

  // Vérifier le sujet
  const { topic } = req.body || {};

  if (
    typeof topic !== "string" ||
    !topic.trim() ||
    topic.trim().length > 1000
  ) {
    return res.status(400).json({
      message: "Veuillez saisir un sujet valide (1000 caractères maximum)."
    });
  }

  // Vérifier et réserver le quota IA dans PostgreSQL
  const userId = req.session.tiktokUser.openId;

  try {
    const quota = await reserveAiGeneration(userId);

    if (!quota.allowed) {
      return res.status(429).json({
        message: "Limite atteinte : 5 générations IA par heure."
      });
    }

  } catch (error) {
    console.error(
      "Erreur vérification quota IA :",
      error.message
    );

    return res.status(503).json({
      message: "Service IA temporairement indisponible."
    });
  }
 
  // Appel à OpenAI
  try {
    const response = await openai.responses.create({
      model: "gpt-5-mini",
      instructions: `Tu es un scénariste professionnel spécialisé
dans les vidéos YouTube, TikTok et Instagram.

Crée un script original en français, adapté au sujet fourni.

Structure obligatoire :
1. Titre accrocheur
2. Introduction captivante
3. Scènes numérotées
4. Narration et dialogues
5. Suggestions visuelles
6. Conclusion

Produis un script clair, créatif et directement exploitable.`,
      input: topic.trim(),
      max_output_tokens: 1800
    });

    const script = response.output_text || "";

    const generationIncomplete =
      response.status === "incomplete" ||
      response.incomplete_details?.reason === "max_output_tokens";

    if (generationIncomplete) {
      console.warn("Génération IA interrompue :", {
        status: response.status,
        reason: response.incomplete_details?.reason
      });

      return res.status(422).json({
        success: false,
        incomplete: true,
        message: "Le scénario a été interrompu avant sa fin.",
        script
      });
    }

    if (response.status !== "completed" || !script.trim()) {
      throw new Error("Réponse IA non terminée ou vide.");
    }

    return res.json({
      success: true,
      script
    });

  } catch (error) {
    console.error("Erreur génération IA :", error.message);

    return res.status(502).json({
      message: "La génération du script a échoué. Réessayez plus tard."
    });
  }
});

/**
 * Compléter un scénario interrompu.
 * Un appel OpenAI est effectué uniquement sur demande.
 */
app.post("/api/ai/complete-script", async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (req.get("Origin") !== "https://videapilot-api.onrender.com") {
    return res.status(403).json({
      message: "Origine non autorisée."
    });
  }

  const userId = req.session?.tiktokUser?.openId;

  if (!userId) {
    return res.status(401).json({
      message: "Connexion TikTok requise."
    });
  }

  const { script } = req.body || {};

  if (
    typeof script !== "string" ||
    !script.trim() ||
    script.length > 15000
  ) {
    return res.status(400).json({
      message: "Scénario invalide (15000 caractères maximum)."
    });
  }

  try {
    const quota = await reserveAiGeneration(userId);

    if (!quota.allowed) {
      return res.status(429).json({
        message: "Limite atteinte : 5 générations IA par heure."
      });
    }
  } catch (error) {
    console.error("Erreur quota IA :", error.message);

    return res.status(503).json({
      message: "Service IA temporairement indisponible."
    });
  }

  try {
    const response = await openai.responses.create({
      model: "gpt-5-mini",
      instructions: `Tu es un scénariste professionnel.
Continue le scénario français fourni à partir de sa fin.
Ne recommence pas l'histoire.
Ne répète pas les scènes déjà écrites.
Termine le dialogue interrompu, puis conclus l'histoire.
Respecte les personnages, le ton et la numérotation.
Retourne uniquement le texte à ajouter.`,
      input: script.trim(),
      max_output_tokens: 1800
    });

    const continuation = response.output_text || "";

    if (
      response.status !== "completed" ||
      !continuation.trim()
    ) {
      return res.status(422).json({
        success: false,
        incomplete: true,
        message: "La continuation n'a pas été terminée.",
        continuation
      });
    }

    return res.json({
      success: true,
      continuation,
      script: script.trimEnd() + "\n\n" + continuation.trim()
    });
  } catch (error) {
    console.error("Erreur continuation IA :", error.message);

    return res.status(502).json({
      message: "Impossible de compléter le scénario."
    });
  }
});

// Préparer les scènes d'une vidéo à partir d'un scénario
app.post("/api/ai/prepare-scenes", async (req, res) => {
  res.set("Cache-Control", "no-store");

  // Vérifier l'origine
  if (req.get("Origin") !== "https://videapilot-api.onrender.com") {
    return res.status(403).json({
      message: "Origine non autorisée."
    });
  }

  // Vérifier la connexion TikTok
  if (!req.session?.tiktokUser?.openId) {
    return res.status(401).json({
      message: "Connexion TikTok requise."
    });
  }

  // Vérifier le scénario
  const { script } = req.body || {};

  if (
    typeof script !== "string" ||
    !script.trim() ||
    script.length > 20000
  ) {
    return res.status(400).json({
      message: "Scénario invalide (20000 caractères maximum)."
    });
  }

  // Identifier les scènes, avec ou sans Markdown ou numérotation préalable.
  const scenePattern = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\d+[).][ \t]*)?(?:\*{1,2})?(?:Scène|Scene)[ \t]+\d+[ \t]*[:.\-–—]/gim;

  // Privilégier la partie contenant les dialogues plutôt que le sommaire.
  const detailsMatch = /^\s*(?:#{1,6}\s*)?(?:\*{1,2})?4[.)]\s*(?:\*{1,2})?Narration et dialogues\b/im.exec(script);
  const source = detailsMatch ? script.slice(detailsMatch.index) : script;
  const matches = [...source.matchAll(scenePattern)];

  // En l'absence de scènes détaillées, revenir à la liste des scènes.
  const selectedSource = matches.length ? source : script;
  const selectedMatches = matches.length ? matches : [...script.matchAll(scenePattern)];

  const scenes = selectedMatches.slice(0, 30).map((match, index) => {
    const start = match.index;
    const next = selectedMatches[index + 1]?.index ?? selectedSource.length;
    // Ne pas inclure les sections suivantes dans la dernière scène.
    const tail = selectedSource.slice(start, next);
    const nextSection = /^\s*(?:#{1,6}\s*)?(?:\*{1,2})?[5-9][.)]\s+(?:Suggestions visuelles|Conclusion|Musique|Hashtags)\b/im.exec(tail);
    const content = nextSection ? tail.slice(0, nextSection.index).trim() : tail.trim();
    
    const heading = content.split("\n")[0] || "";

    const titleMatch = heading.match(
      /^(?:Scène|Scene)\s+\d+\s*[—–:.-]\s*(.*?)(?:\s*\((\d+):(\d+)\s*[–—-]\s*(\d+):(\d+)\))?\s*$/i
    );

    const title = titleMatch?.[1]?.trim() || heading;

    const startSeconds = titleMatch?.[2] !== undefined
      ? Number(titleMatch[2]) * 60 + Number(titleMatch[3])
      : null;

    const endSeconds = titleMatch?.[4] !== undefined
      ? Number(titleMatch[4]) * 60 + Number(titleMatch[5])
      : null;

    const durationSeconds =
      startSeconds !== null &&
      endSeconds !== null &&
      endSeconds > startSeconds
        ? endSeconds - startSeconds
        : null;
    
    const dialogues = [];

    const lines = content.split("\n");

    for (const line of lines) {
      const match = line.trim().match(
        /^([^:\n]+?)\s*:\s*["“](.*?)["”]\s*$/
      );

      if (!match) continue;

      const speakerInfo = match[1].trim();
      const text = match[2].trim();

      const speakerMatch = speakerInfo.match(
        /^(.+?)\s*\(([^)]+)\)$/
      );

      const speaker = speakerMatch
        ? speakerMatch[1].trim()
        : speakerInfo;

      const emotion = speakerMatch
        ? speakerMatch[2].trim()
        : null;

      if (speaker && text) {
        dialogues.push({
          speaker,
          emotion,
          text
        });
      }
    }

   const characters = [...new Set(
     dialogues.map(dialogue => dialogue.speaker)
   )];
    
   const voiceProfiles = characters.map(character => {
     const voiceId = character
       .normalize("NFD")
       .replace(/[\u0300-\u036f]/g, "")
       .toLowerCase()
       .replace(/[^a-z0-9]+/g, "_")
       .replace(/^_+|_+$/g, "");

     return {
       character,
       voiceId,
       emotions: [...new Set(
         dialogues
           .filter(dialogue => dialogue.speaker === character)
           .map(dialogue => dialogue.emotion)
           .filter(Boolean)
       )]
     };
   });

    return {
      number: index + 1,
      title,
      content,
      startSeconds,
      endSeconds,
      durationSeconds,
      dialogues,
      characters,
      voiceProfiles
    };

  }).filter(scene => scene.content);
  
  const voiceCatalog = [
    ...new Map(
      scenes
        .flatMap(scene => scene.voiceProfiles || [])
        .map(profile => [
          profile.voiceId,
          {
            character: profile.character,
            voiceId: profile.voiceId
          }
        ])
    ).values()
  ];

  if (scenes.length === 0) {
    return res.status(422).json({
      success: false,
      message: "Aucune scène reconnue. Utilisez des titres comme Scène 1 — ...",
      scenes: []
    });
  }

  // Diagnostic local : aucun appel à OpenAI.
  // expectedScenes est facultatif et permet de comparer avec l'objectif choisi.
  const { expectedScenes } = req.body || {};
  if (expectedScenes !== undefined &&
      (!Number.isInteger(expectedScenes) || expectedScenes < 1 || expectedScenes > 30)) {
    return res.status(400).json({
      success: false,
      message: "expectedScenes doit être un entier compris entre 1 et 30."
    });
  }

  const warnings = [];
  const detectedNumbers = selectedMatches.slice(0, 30).map(match => {
    const heading = match[0].match(/(?:Scène|Scene)[ \t]+(\d+)/i);
    return heading ? Number(heading[1]) : null;
  }).filter(Number.isInteger);
  const uniqueNumbers = [...new Set(detectedNumbers)].sort((a, b) => a - b);
  const missingNumbers = [];
  for (let n = 1; n <= Math.min(30, Math.max(0, ...uniqueNumbers)); n++) {
    if (!uniqueNumbers.includes(n)) missingNumbers.push(n);
  }
  if (missingNumbers.length) {
    warnings.push(`Numéros de scènes absents : ${missingNumbers.join(", ")}.`);
  }
  if (uniqueNumbers.length !== detectedNumbers.length) {
    warnings.push("Certains numéros de scènes sont répétés.");
  }
  if (expectedScenes !== undefined && scenes.length < expectedScenes) {
    warnings.push(`Seulement ${scenes.length} scène(s) sur ${expectedScenes} attendue(s).`);
  }

  const lastContent = scenes.at(-1)?.content.trim() || "";
  const lastLine = lastContent.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || "";
  if (/[:;,—–-]$/.test(lastLine) ||
      /^(?:Narrateur|Dialogue|Voisin|Léo|Clara|Maman|Coach)\s*$/i.test(lastLine) ||
      (lastLine.includes('"') && (lastLine.match(/"/g) || []).length % 2 !== 0)) {
    warnings.push("La dernière scène semble se terminer au milieu d'une phrase ou d'un dialogue.");
  }
  
  const hasConclusion =
    /^\s*(?:#{1,6}\s*)?(?:\*{1,2})?(?:\d+[.)]\s*)?Conclusion\b/im.test(script) ||
    /(?:Scène|Scene)\s*\d+\s*[—–:-]\s*[^\n]*(?:bilan|épilogue|epilogue|conclusion|dénouement|denouement|fin de l'histoire)/im.test(script);

  if (!hasConclusion) {
    warnings.push(
      "Aucune section de conclusion reconnue dans le scénario."
    );
  }

  const blockingReasons = [];

  if (missingNumbers.length > 0) {
    blockingReasons.push("Des numéros de scènes sont manquants.");
  }

  if (uniqueNumbers.length !== detectedNumbers.length) {
    blockingReasons.push("Des numéros de scènes sont répétés.");
  }

  if (expectedScenes !== undefined && scenes.length < expectedScenes) {
    blockingReasons.push("Le nombre de scènes attendu n'est pas atteint.");
  }

  if (warnings.some(w => w.includes("dernière scène"))) {
    blockingReasons.push("Le dernier dialogue semble interrompu.");
  }

  if (!hasConclusion) {
    blockingReasons.push(
      "La conclusion du scénario est absente."
    );
  }

  const readyForProduction = blockingReasons.length === 0;
  
  console.log("VIDEAPILOT_VOICE_CATALOG_CHECK", {
    sceneCount: scenes.length,
    voiceCatalogCount: voiceCatalog.length
  });

  
  return res.json({
    success: true,
    scenes,
    voiceCatalog,
    diagnostic: {
      sceneCount: scenes.length,
      expectedScenes: expectedScenes ?? null,
      missingNumbers,
      potentiallyIncomplete: warnings.length > 0,
      warnings,
      readyForProduction,
      blockingReasons
    }
  });
});

app.get("/api/videos", async (req, res) => {
  res.set("Cache-Control", "no-store");

  const userId = req.session?.tiktokUser?.openId;

  if (!userId) {
    return res.status(401).json({
      message: "Connexion TikTok requise."
    });
  }

  try {
    const result = await pool.query(
      `SELECT id, title, topic, script, created_at
       FROM video_projects
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC`,
      [userId]
    );

    return res.json({
      success: true,
      projects: result.rows
    });

  } catch (error) {
    console.error(
      "Erreur récupération projets vidéo :",
      error.message
    );

    return res.status(500).json({
      message: "Impossible de récupérer les projets vidéo."
    });
  }
});
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
          Votre session de connexion est enregistrée de manière sécurisée.
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `VidéaPilot Backend démarré sur le port ${PORT}`
  );
});




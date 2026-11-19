"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");
const { getVoiceConfig } = require("./voice-config");
const { preserveSceneIdentities } = require("./video-scene-identity");
const { synchronizeProjectScenes } = require("./video-scene-sync");

// Visible staging dashboard text supplied by the user.
const script = `**Titre : Léo, le petit super-héros**

**Scène 1 — Le grand rêve (0 à 4 secondes)**

Léo, un petit super-héros vêtu d'un costume bleu et d'une cape rouge, regarde le ciel avec inquiétude.

**Narration :** « Léo rêvait de voler, mais il avait peur de quitter le sol. »

**Scène 2 — Le premier envol (4 à 10 secondes)**

Léo prend courage, déploie sa cape et s'élève doucement dans le ciel. Son visage s'illumine de joie.

**Narration :** « Un jour, il osa enfin s'envoler. Et découvrit son courage ! »

**Scène 3 — Le nuage menaçant (10 à 18 secondes)**

Un grand nuage gris avance vite. Le vent se lève. Léo vacille dans les airs, inquiet.

Petite fille sur un balcon : « Léo ! Fais atten— » (sa voix est emportée par une bourrasque) « —tion ! Le vent devient fort ! Rentre vite ! »

Léo, les mains sur sa cape : « Je... je ne sais pas si je peux. »

Narration : « Pour la première fois, il sentit le vertige, mais aussi le désir d'aider. »

**Scène 4 — Le choix du cœur (18 à 26 secondes)**

Un cerf-volant échappe à son fil et file vers le nuage. Un chat sur un toit miaule, effrayé.

Léo ferme les yeux, respire profondément, puis crie : « Je peux le faire ! »

Il plonge, attrape le fil du cerf-volant et ramène l'enfant à la fenêtre. Ensuite il se pose doucement sur le toit et caresse le chat, qui se blottit contre lui.

Narration : « En aidant les autres, Léo trouva la force qui lui manquait. Le courage n'était plus seulement un rêve — c'était vivant en lui. »

**Scène 5 — Le retour (26 à 30 secondes)**

Le soleil perce le nuage. Léo redécouvre le sourire sur son visage. Les habitants applaudissent depuis les fenêtres.

Léo, souriant : « Je peux voler, oui... et je peux aussi aider. »

Narration : « Ce jour-là, Léo comprit que voler, ce n'était pas fuir le sol, mais s'élever pour ceux qu'on aime. Et chaque petit pas lui ouvrit un ciel plus grand. »`;

const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const start = source.indexOf('app.post("/api/ai/prepare-scenes"');
const end = source.indexOf('app.get("/api/videos"', start);
assert.ok(start >= 0 && end > start);
// Run the route in memory without opening connections or invoking media adapters.
function createHandler(pool) {
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    app: { post: (_path, callback) => { handler = callback; } },
    isAiScriptOriginAllowed: () => true,
    randomUUID,
    getVoiceConfig,
    prepareVideoMontage: () => [],
    prepareAudioJobs: () => [],
    AUDIO_ENGINE_CONFIG: {},
    AUDIO_SAFETY_CONFIG: {},
    TTS_CONFIG: {},
    assertAudioGenerationAllowed() {},
    prepareTtsRequest() {},
    preserveSceneIdentities,
    synchronizeProjectScenes,
    pool,
    console: { error() {} },
  });
  return handler;
}

async function prepare(script) {
  let result;
  await createHandler()({ session: { tiktokUser: { openId: "test" } }, body: { script } }, {
    set() {},
    json(value) { result = value; },
  });
  return JSON.parse(JSON.stringify(result));
}

test("scénario de Léo : cinq scènes et bornes déclarées jusqu'à 30 s", async () => {
  const { scenes, diagnostic } = await prepare(script);
  assert.deepEqual(scenes.map(s => [s.startSeconds, s.endSeconds]), [[0, 4], [4, 10], [10, 18], [18, 26], [26, 30]]);
  assert.deepEqual(scenes.map(s => s.durationSeconds), [4, 6, 8, 8, 4]);
  assert.deepEqual(scenes.map(s => s.title), ["Le grand rêve", "Le premier envol", "Le nuage menaçant", "Le choix du cœur", "Le retour"]);
  assert.ok(!diagnostic.blockingReasons.some(reason => reason.includes("conclusion")));

  const dialogues = scenes.flatMap(scene => scene.dialogues);
  assert.deepEqual(dialogues.map(d => d.text), [...script.matchAll(/«\s*([^»]+?)\s*»/g)].map(m => m[1]));
  assert.deepEqual(scenes.map(scene => scene.characters), [
    ["Narrateur"], ["Narrateur"], ["Petite fille sur un balcon", "Léo", "Narrateur"],
    ["Léo", "Narrateur"], ["Léo", "Narrateur"],
  ]);
  assert.deepEqual(scenes[2].voiceProfiles.map(p => p.voiceId), ["petite_fille_sur_un_balcon", "leo", "narrateur"]);
});

async function attemptSave(existingScenes, { owner = true } = {}) {
  const operations = [];
  const projectRows = owner ? [{ id: 42, mvp_local_images: "false" }] : [];
  const client = {
    async query(sql, parameters) {
      if (sql.includes("FOR UPDATE")) {
        assert.deepEqual(Array.from(parameters), ["42", "test"]);
        operations.push("lock");
        return { rows: projectRows };
      }
      if (sql.includes("FROM video_project_scenes")) {
        operations.push("read scenes");
        return { rows: existingScenes };
      }
      if (sql.includes("INSERT INTO video_project_scenes")) {
        operations.push("insert");
        throw Object.assign(new Error("SQL simulée"), { code: "42501" });
      }
      operations.push(sql);
    },
    release() { operations.push("release"); },
  };
  const pool = {
    async query(sql, parameters) {
      assert.match(sql, /p\.user_id = \$2/);
      assert.deepEqual(Array.from(parameters), ["42", "test"]);
      operations.push("lookup");
      return { rows: projectRows };
    },
    async connect() { operations.push("connect"); return client; },
  };
  let statusCode;
  let body;
  await createHandler(pool)({ session: { tiktokUser: { openId: "test" } }, body: { script, projectId: "42" } }, {
    set() {},
    status(value) { statusCode = value; return this; },
    json(value) { body = value; },
  });
  return { statusCode, body, operations };
}

test("un conflit de contenu retourne 409 et annule la transaction avant toute écriture", async () => {
  const result = await attemptSave([{ scene_number: 1, title: "Ancien titre", visual_prompt: "Ancien prompt" }]);
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error, "SCENE_CONTENT_CHANGED_REVIEW_REQUIRED");
  assert.match(result.body.message, /validées avant toute modification/);
  assert.deepEqual(result.operations, ["lookup", "connect", "BEGIN", "lock", "read scenes", "ROLLBACK", "release"]);
});

test("une erreur SQL retourne toujours 503 et annule la transaction", async () => {
  const result = await attemptSave([]);
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error, "SCENE_SAVE_UNAVAILABLE");
  assert.deepEqual(result.operations, ["lookup", "connect", "BEGIN", "lock", "read scenes", "read scenes", "insert", "ROLLBACK", "release"]);
});

test("un projet qui n'appartient pas à la session est refusé avant la transaction", async () => {
  const result = await attemptSave([], { owner: false });
  assert.equal(result.statusCode, 404);
  assert.equal(result.body.error, "PROJECT_NOT_FOUND");
  assert.deepEqual(result.operations, ["lookup"]);
});

test("formats historiques, exclusion du visuel et diagnostic d'interruption", async () => {
  const legacy = await prepare('Scène 1 : Épilogue (0:00–0:04)\nLéo (souriant) : "Test."\nDescription visuelle : « Décor. »');
  assert.equal(legacy.scenes[0].durationSeconds, 4);
  assert.deepEqual(legacy.scenes[0].dialogues, [{ speaker: "Léo", emotion: "souriant", text: "Test." }]);
  const interrupted = await prepare('Scène 1 — Le retour (0 à 4 secondes)\nScène 2 — Suite (4 à 8 secondes)\nLéo : "');
  assert.ok(interrupted.diagnostic.blockingReasons.some(reason => reason.includes("conclusion")));
  assert.ok(interrupted.diagnostic.blockingReasons.some(reason => reason.includes("interrompu")));
});

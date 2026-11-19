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
const { buildSceneReconciliation, matchesSceneFingerprint, sceneSnapshotSql, updateReconciledDurations } = require("./video-scene-reconciliation");
const { prepareVideoMontage } = require("./video-engine");
const { prepareAudioJobs } = require("./audio-engine");

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
function createHandler(pool, environment = "staging", originAllowed = true) {
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    app: { post: (_path, callback) => { handler = callback; } },
    isAiScriptOriginAllowed: () => originAllowed,
    randomUUID,
    getVoiceConfig,
    prepareVideoMontage,
    prepareAudioJobs,
    AUDIO_ENGINE_CONFIG: {},
    AUDIO_SAFETY_CONFIG: {},
    TTS_CONFIG: {},
    assertAudioGenerationAllowed() {},
    prepareTtsRequest() {},
    preserveSceneIdentities,
    synchronizeProjectScenes,
    buildSceneReconciliation,
    matchesSceneFingerprint,
    sceneSnapshotSql,
    updateReconciledDurations,
    process: { env: { VIDEAPILOT_ENVIRONMENT: environment, SESSION_SECRET: "local-test-only" } },
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

function reconciliationFixture() {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    scene_id: randomUUID(), scene_number: i + 1, title: "Ancien titre",
    visual_prompt: "Ancien prompt", duration_seconds: 1, image_asset_id: i === 0 ? randomUUID() : null,
  }));
  const operations = [];
  const state = { rows, operations, projectScript: script, owner: "test", failUpdate: false };
  const project = params => ({ rows: params[0] === "42" && params[1] === state.owner
    ? [{ id: 42, script: state.projectScript, mvp_local_images: "false" }] : [] });
  let workingRows;
  const client = {
    async query(sql, params) {
      if (sql === "BEGIN") {
        operations.push("BEGIN");
        workingRows = rows.map(row => ({ ...row }));
        return;
      }
      if (sql === "COMMIT") {
        operations.push("COMMIT");
        rows.splice(0, rows.length, ...workingRows);
        return;
      }
      if (sql === "ROLLBACK") { operations.push("ROLLBACK"); return; }
      if (sql.includes("FROM video_project_scenes")) {
        operations.push(sql.includes("FOR UPDATE") ? "lock scenes" : "read scenes");
        return { rows: workingRows };
      }
      if (sql.includes("FROM video_projects")) {
        assert.match(sql, /FOR UPDATE/);
        operations.push("lock project");
        return project(params);
      }
      const durationOnly = /SET duration_seconds = \$3/.test(sql);
      assert.match(sql, durationOnly
        ? /UPDATE video_project_scenes\s+SET duration_seconds = \$3\s+WHERE project_id = \$1 AND scene_id = \$2 AND scene_number = \$4/
        : /UPDATE video_project_scenes\s+SET title = \$3,\s+visual_prompt = \$4,\s+duration_seconds = \$5\s+WHERE project_id = \$1\s+AND scene_id = \$2/);
      operations.push("update");
      if (state.failUpdate && operations.filter(operation => operation === "update").length === 2) {
        throw new Error("Échec SQL simulé");
      }
      assert.equal(params[0], "42");
      const row = workingRows.find(row => row.scene_id === params[1]);
      assert.ok(row);
      if (durationOnly) {
        assert.equal(params[3], row.scene_number);
        row.duration_seconds = params[2];
      } else {
        [row.title, row.visual_prompt, row.duration_seconds] = params.slice(2);
      }
      return { rowCount: 1 };
    },
    release() { operations.push("release"); },
  };
  const pool = {
    async query(sql, params) {
      if (sql.includes("FROM video_project_scenes")) {
        assert.doesNotMatch(sql, /FOR UPDATE/);
        assert.deepEqual(Array.from(params), ["42", state.owner, state.projectScript]);
        operations.push("preview scenes");
        return { rows };
      }
      assert.match(sql, /p\.user_id = \$2/);
      operations.push("lookup");
      return project(params);
    },
    async connect() { operations.push("connect"); return client; },
  };
  state.request = async (mode, { fingerprint, owner = "test", submittedScript = script, environment, originAllowed } = {}) => {
    let status = 200;
    let payload;
    await createHandler(pool, environment, originAllowed)({
      session: owner ? { tiktokUser: { openId: owner } } : undefined,
      body: { projectId: "42", script: submittedScript, reconciliation: mode, fingerprint },
    }, {
      set() {},
      status(value) { status = value; return this; },
      json(value) { payload = JSON.parse(JSON.stringify(value)); },
    });
    return { status, ...payload };
  };
  return state;
}

test("aperçu déterministe en lecture seule puis confirmation avec UUID, médias et plans cohérents", async () => {
  const state = reconciliationFixture();
  const original = state.rows.map(row => ({ ...row }));
  const preview = await state.request("preview");
  assert.equal(preview.status, 200);
  assert.deepEqual(state.operations, ["lookup", "preview scenes"]);
  assert.equal((await state.request("preview")).fingerprint, preview.fingerprint);
  assert.deepEqual(state.rows, original);
  assert.equal(preview.differences[0].before.durationSeconds, 1);
  assert.equal(preview.differences[0].after.durationSeconds, 4);
  assert.equal(preview.differences[0].hasImage, true);
  assert.equal(preview.differences[0].imageMayNotMatch, true);
  assert.ok(preview.estimatedAudioOverruns.length > 0);

  const confirmed = await state.request("confirm", { fingerprint: preview.fingerprint });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(state.operations.slice(-11), ["BEGIN", "lock project", "lock scenes", "read scenes",
    "update", "update", "update", "update", "update", "COMMIT", "release"]);
  assert.deepEqual(state.rows.map(row => row.duration_seconds), [4, 6, 8, 8, 4]);
  assert.deepEqual(state.rows.map(row => [row.scene_id, row.scene_number, row.image_asset_id]),
    original.map(row => [row.scene_id, row.scene_number, row.image_asset_id]));
  assert.deepEqual(confirmed.scenes.map(scene => scene.sceneId), original.map(row => row.scene_id));
  assert.deepEqual(confirmed.videoMontagePlan.timeline.map(scene => scene.sceneId), original.map(row => row.scene_id));
  assert.equal(confirmed.videoMontagePlan.totalDurationSeconds, 30);
  assert.equal(confirmed.audioReuseAllowed, false);
  assert.equal(confirmed.audioGenerationPlan.length, 10);
  assert.ok(confirmed.audioGenerationPlan.every(job => /^reconciled_/.test(job.outputFileName)));
  assert.deepEqual(confirmed.estimatedAudioOverruns, preview.estimatedAudioOverruns);
});

test("empreinte incorrecte, image modifiée ou numéros différents : 409 sans mise à jour ni COMMIT", async () => {
  for (const change of [
    () => "0".repeat(64),
    (state, token) => { state.rows[0].image_asset_id = randomUUID(); return token; },
    (state, token) => { state.rows[4].scene_number = 6; return token; },
    (state, token) => { state.projectScript += "\n"; return token; },
  ]) {
    const state = reconciliationFixture();
    const preview = await state.request("preview");
    const result = await state.request("confirm", { fingerprint: change(state, preview.fingerprint) });
    assert.equal(result.status, 409);
    assert.equal(result.error, "SCENE_RECONCILIATION_STALE");
    assert.deepEqual(state.operations.slice(-2), ["ROLLBACK", "release"]);
    assert.ok(!state.operations.includes("update") && !state.operations.includes("COMMIT"));
  }
});

test("prévisualisation et confirmation restent réservées au propriétaire et à staging", async () => {
  const state = reconciliationFixture();
  for (const mode of ["preview", "confirm"]) {
    const fingerprint = "0".repeat(64);
    assert.equal((await state.request(mode, { fingerprint, originAllowed: false })).status, 403);
    assert.equal((await state.request(mode, { fingerprint, owner: null })).status, 401);
  }
  assert.deepEqual(state.operations, []);
  assert.equal((await state.request("preview", { owner: "autre" })).status, 404);
  assert.equal((await state.request("confirm", { owner: "autre", fingerprint: "0".repeat(64) })).status, 404);
  assert.equal((await state.request("preview", { environment: "production" })).status, 403);
  assert.equal((await state.request("confirm")).status, 400);
  state.rows.pop();
  assert.equal((await state.request("preview")).error, "SCENE_RECONCILIATION_NUMBER_MISMATCH");
  assert.ok(!state.operations.includes("connect"));
});

test("erreur après une première mise à jour : rollback intégral de la confirmation", async () => {
  const state = reconciliationFixture();
  const preview = await state.request("preview");
  const before = state.rows.map(row => ({ ...row }));
  state.failUpdate = true;
  const result = await state.request("confirm", { fingerprint: preview.fingerprint });
  assert.equal(result.status, 503);
  assert.deepEqual(state.operations.slice(-4), ["update", "update", "ROLLBACK", "release"]);
  assert.ok(!state.operations.includes("COMMIT"));
  assert.deepEqual(state.rows, before);
});

test("durées audio : aperçu sans écriture et confirmation limitée aux durées", async () => {
  const state = reconciliationFixture();
  const ordinary = await state.request("preview");
  await state.request("confirm", { fingerprint: ordinary.fingerprint });
  const original = structuredClone(state.rows);
  state.operations.length = 0;
  const preview = await state.request("duration-preview");
  assert.equal(preview.status, 200);
  assert.deepEqual(state.operations, ["lookup", "preview scenes"]);
  assert.deepEqual(state.rows, original);
  assert.deepEqual(preview.differences.map(scene => scene.before.durationSeconds), [4, 6, 8, 8, 4]);
  assert.deepEqual(preview.differences.map(scene => scene.after.durationSeconds), [7, 6, 19, 15, 20]);
  assert.deepEqual(preview.missingVoices, [{ voiceId: "petite_fille_sur_un_balcon", character: "Petite fille sur un balcon" }]);
  assert.equal((await state.request("duration-confirm")).status, 400);
  const confirmed = await state.request("duration-confirm", { fingerprint: preview.fingerprint });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.durationsAreEstimated, true);
  assert.deepEqual(confirmed.videoMontagePlan.timeline.map(scene => [scene.startSeconds, scene.endSeconds]),
    [[0, 7], [7, 13], [13, 32], [32, 47], [47, 67]]);
  assert.equal(confirmed.videoMontagePlan.videoGenerated, false);
  assert.equal(confirmed.videoMontagePlan.audioGenerated, false);
  assert.ok(confirmed.audioJobs.every(job => !job.generated));
  assert.deepEqual(state.rows, original.map((row, index) => ({
    ...row, duration_seconds: [7, 6, 19, 15, 20][index],
  })));
  assert.equal(state.operations.filter(operation => operation === "update").length, 4);
  assert.equal((await state.request(undefined)).videoMontagePlan.totalDurationSeconds, 67);
});

test("confirmation des durées : empreinte cloisonnée, refus d'accès et concurrence", async () => {
  const state = reconciliationFixture();
  for (const mode of ["duration-preview", "duration-confirm"]) {
    const fingerprint = "0".repeat(64);
    assert.equal((await state.request(mode, { fingerprint, owner: null })).status, 401);
    assert.equal((await state.request(mode, { fingerprint, originAllowed: false })).status, 403);
    assert.equal((await state.request(mode, { fingerprint, owner: "autre" })).status, 404);
  }
  const old = await state.request("preview");
  assert.equal((await state.request("duration-confirm", { fingerprint: old.fingerprint })).status, 409);
  const preview = await state.request("duration-preview");
  state.rows[0].duration_seconds = 3;
  assert.equal((await state.request("duration-confirm", { fingerprint: preview.fingerprint })).status, 409);
  assert.deepEqual(state.operations.slice(-2), ["ROLLBACK", "release"]);
  assert.ok(!state.operations.includes("update") && !state.operations.includes("COMMIT"));
});

test("une erreur pendant la confirmation des durées annule toutes les écritures", async () => {
  const state = reconciliationFixture();
  const original = structuredClone(state.rows);
  const preview = await state.request("duration-preview");
  state.failUpdate = true;
  assert.equal((await state.request("duration-confirm", { fingerprint: preview.fingerprint })).status, 503);
  assert.deepEqual(state.operations.slice(-4), ["update", "update", "ROLLBACK", "release"]);
  assert.ok(!state.operations.includes("COMMIT"));
  assert.deepEqual(state.rows, original);
});

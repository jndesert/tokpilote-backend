"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const dashboard = fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf8");
const production = "https://videapilot-api.onrender.com";
const staging = "https://videapilot-staging.onrender.com";
const stagingHost = new URL(staging).host;
const originGuard = server.match(/^function isAiScriptOriginAllowed\(req\) \{[\s\S]*?^\}/m)?.[0];
// Run both real route prefixes through TikTok authorization only.
const routes = [...server.matchAll(/^app\.post\("\/api\/ai\/(?:complete-script|prepare-scenes)",[\s\S]*?    return res\.status\(401\)\.json\([\s\S]*?^  \}/gm)];
assert.ok(originGuard);
assert.equal(routes.length, 2);

async function statusFor({
  environment = "staging",
  configuredOrigin = staging,
  origin = staging,
  host = stagingHost,
  secure = true,
} = {}) {
  const handlers = new Map();
  vm.runInNewContext([originGuard, ...routes.map(([route]) => route + "\n  unexpectedBusinessCall();\n});")].join("\n"), {
    URL,
    app: { post: (path, callback) => handlers.set(path, callback) },
    process: { env: { VIDEAPILOT_ENVIRONMENT: environment, VIDEO_RENDER_ALLOWED_ORIGIN: configuredOrigin } },
    unexpectedBusinessCall: () => assert.fail("Traitement métier inattendu"),
  });
  const headers = { Origin: origin, Host: host, "X-Forwarded-Host": stagingHost };
  const response = {
    set() {},
    status(code) { this.code = code; return this; },
    json() { return this; },
  };
  // An accepted origin reaches the existing session check and stops there.
  await handlers.get("/api/ai/complete-script")({ secure, get: name => headers[name] ?? undefined }, response);
  const completeScriptStatus = response.code;
  delete response.code;
  await handlers.get("/api/ai/prepare-scenes")({ secure, get: name => headers[name] ?? undefined }, response);
  assert.equal(response.code, completeScriptStatus, "prepare-scenes doit appliquer le même contrôle");
  return completeScriptStatus;
}

test("production conserve son origine habituelle", async () => {
  assert.equal(await statusFor({ environment: "production", origin: production, host: new URL(production).host }), 401);
});

test("staging HTTPS correctement configuré atteint le contrôle de session", async () => {
  assert.equal(await statusFor(), 401);
});

test("staging est refusé hors environnement staging", async () => {
  assert.equal(await statusFor({ environment: "production" }), 403);
});

test("staging refuse les origines inconnues, absentes ou malformées", async () => {
  for (const origin of [production, "https://other.invalid", null, "", "not an origin"]) {
    assert.equal(await statusFor({ origin }), 403);
  }
});

test("staging refuse une configuration absente ou autre qu'une origine HTTPS exacte", async () => {
  for (const configuredOrigin of [
    null, "", "not a URL", staging + "/", staging + "/dashboard", staging + "?x=1",
    staging + "#fragment", "https://user@" + stagingHost, "http://" + stagingHost,
  ]) {
    assert.equal(await statusFor({ configuredOrigin, origin: configuredOrigin }), 403);
  }
});

test("staging refuse un mauvais Host même avec X-Forwarded-Host valide, ou une requête HTTP", async () => {
  assert.equal(await statusFor({ host: "other.invalid" }), 403);
  assert.equal(await statusFor({ secure: false }), 403);
});

test("un clic confirmé envoie un seul POST et conserve l'enregistrement d'un projet existant", async () => {
  const listeners = [...dashboard.matchAll(/^document\.getElementById\("complete-script"\)\.addEventListener\("click",[\s\S]*?^\}\);/gm)];
  assert.equal(listeners.length, 1);
  let handler;
  let requests = 0;
  let submitted = 0;
  const button = { addEventListener: (_event, callback) => { handler = callback; } };
  const script = { value: "Scénario test", dispatchEvent() {} };
  const result = {};
  const form = { dataset: { editId: "1" }, requestSubmit() { submitted++; } };
  const elements = {
    "complete-script": button, "video-script": script, "test-scenes-result": result, "video-form": form,
  };
  vm.runInNewContext(listeners[0][0], {
    document: { getElementById: id => elements[id] },
    window: { confirm: () => true },
    Event: class {},
    fetch: async (url, options) => {
      assert.equal(url, "/api/ai/complete-script");
      assert.equal(options.method, "POST");
      requests++;
      return { ok: true, json: async () => ({ success: true, script: "Scénario complété" }) };
    },
  });
  await handler();
  assert.equal(requests, 1);
  assert.equal(submitted, 1);
  assert.equal(script.value, "Scénario complété");
  assert.equal(button.disabled, false);
});

test("syntaxe des scripts intégrés au tableau de bord", () => {
  for (const [, script] of dashboard.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    new vm.Script(script);
  }
});

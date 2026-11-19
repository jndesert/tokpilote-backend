"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { Client } = require("pg");
const { postgresConnectionOptions } = require("./postgres-tls");

const staging = {
  DATABASE_URL: "postgresql://test:d%40ta@dpg-abc123-a/videapilot_staging",
  VIDEAPILOT_STAGING_INTERNAL_DB_TLS: "true",
  VIDEAPILOT_ENVIRONMENT: "staging",
  NODE_ENV: "production",
};

// Construct a real pg client to exercise URI parsing without opening a socket.
function clientOptions(overrides) {
  return new Client(postgresConnectionOptions({ ...staging, ...overrides })).connectionParameters;
}

test("staging interne autorisé : TLS actif avec certificat autosigné", () => {
  const parameters = clientOptions();
  assert.deepEqual(parameters.ssl, { rejectUnauthorized: false });
  assert.equal(parameters.host, "dpg-abc123-a");
  assert.equal(parameters.database, "videapilot_staging");
  assert.equal(parameters.password, "d@ta");
});

for (const [description, overrides] of [
  ["option absente", { VIDEAPILOT_STAGING_INTERNAL_DB_TLS: undefined }],
  ["option non exacte", { VIDEAPILOT_STAGING_INTERNAL_DB_TLS: "TRUE" }],
  ["production", { VIDEAPILOT_ENVIRONMENT: "production" }],
  ["environnement dédié absent", { VIDEAPILOT_ENVIRONMENT: undefined }],
  ["mauvaise base", { DATABASE_URL: staging.DATABASE_URL.replace("/videapilot_staging", "/videapilot") }],
  ["mauvais hôte", { DATABASE_URL: staging.DATABASE_URL.replace("-a/", "-a.example.invalid/") }],
  ["mauvais port", { DATABASE_URL: staging.DATABASE_URL.replace("-a/", "-a:6432/") }],
]) {
  test(description + " : TLS strict", () => {
    assert.deepEqual(clientOptions(overrides).ssl, { rejectUnauthorized: true });
  });
}

test("URL invalide : erreur contrôlée sans valeur de connexion", () => {
  assert.throws(() => clientOptions({ DATABASE_URL: "postgresql://test:%ZZ@[" }), {
    message: "INVALID_DATABASE_URL",
  });
});

test("les paramètres SSL de l’URL ne remplacent pas la politique des pools", () => {
  const DATABASE_URL = staging.DATABASE_URL + "?sslmode=disable&ssl=no-verify&sslrootcert=absent&uselibpqcompat=true&application_name=staging_test";
  for (const [environment, rejectUnauthorized] of [["staging", false], ["production", true]]) {
    const parameters = clientOptions({ DATABASE_URL, VIDEAPILOT_ENVIRONMENT: environment });
    assert.deepEqual(parameters.ssl, { rejectUnauthorized });
    assert.equal(parameters.application_name, "staging_test");
  }
});

test("un paramètre de routage ne peut pas substituer un autre hôte", () => {
  assert.throws(() => clientOptions({ DATABASE_URL: staging.DATABASE_URL + "?host=external.invalid" }), {
    message: "INVALID_DATABASE_URL_ROUTING",
  });
});

test("le lanceur et le serveur appliquent le même constructeur d’options", () => {
  for (const file of ["render-mvp-start.js", "server.js"]) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.match(source, /const \{ postgresConnectionOptions \} = require\("\.\/postgres-tls"\);/);
    const pool = source.match(/new Pool\(\{([^}]+)\}\)/)?.[1];
    assert.ok(pool, file);
    assert.match(pool, /\.\.\.postgresConnectionOptions\(\)/);
    assert.doesNotMatch(pool, /\b(?:ssl|connectionString):/);
  }
});

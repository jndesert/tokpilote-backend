"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createAudioReplicaFsAdapter } = require("./audio-replica-fs-adapter");

async function fixture(t, options = {}) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, "replica-adapter-test-"));
  t.after(async () => {
    assert.equal(path.dirname(root), temp);
    assert.match(path.basename(root), /^replica-adapter-test-/);
    assert.equal(await fs.realpath(root), root);
    await fs.rm(root, { recursive: true });
  });
  const sourceRoot = path.join(root, "sources");
  const temporaryRoot = path.join(root, "travail");
  await fs.mkdir(sourceRoot, { mode: 0o700 });
  await fs.mkdir(temporaryRoot, { mode: 0o700 });
  const source = path.join(sourceRoot, "octets.bin");
  const bytes = Buffer.from("fixture locale sans données média");
  await fs.writeFile(source, bytes, { flag: "wx" });
  const adapter = await createAudioReplicaFsAdapter({
    sourceRoot, temporaryRoot,
    // The Windows test models a trusted ACL verdict. It does not inspect actual ACLs.
    verifyWindowsPrivateDirectory: directory =>
      directory === temporaryRoot || path.dirname(directory) === temporaryRoot,
    ...options,
  });
  return { root, sourceRoot, temporaryRoot, source, bytes, adapter };
}

test("lit les octets d’un fichier régulier et vérifie l’empreinte de sa copie", async t => {
  const data = await fixture(t);
  const original = await data.adapter.inspect(data.source);
  assert.equal(original.kind, "file");
  assert.deepEqual(original.bytes, data.bytes);
  assert.equal(original.sha256, createHash("sha256").update(data.bytes).digest("hex"));
  assert.equal(original.protected, false);
  const workspace = await data.adapter.createWorkspace(data.temporaryRoot);
  const target = path.join(workspace.root, "copie.bin");
  const copied = await data.adapter.copyProtected(data.source, target, original);
  assert.equal(copied.protected, true);
  assert.notEqual(copied.identity, original.identity);
  assert.equal(copied.sha256, original.sha256);
  assert.deepEqual((await data.adapter.inspect(target)).bytes, data.bytes);
  await workspace.cleanup();
  await fs.access(workspace.root).then(() => assert.fail("Zone encore présente"), error => assert.equal(error.code, "ENOENT"));
  assert.deepEqual(await fs.readFile(data.source), data.bytes);
});

test("fichier absent et fichier non régulier", async t => {
  const data = await fixture(t);
  assert.equal(await data.adapter.inspect(path.join(data.sourceRoot, "absent.bin")), undefined);
  const workspace = await data.adapter.createWorkspace();
  await assert.rejects(data.adapter.copyProtected(path.join(data.sourceRoot, "absent.bin"), path.join(workspace.root, "copie.bin")), {
    code: "ENOENT",
  });
  const directory = path.join(data.sourceRoot, "dossier");
  await fs.mkdir(directory);
  await assert.rejects(data.adapter.inspect(directory), { code: "INVALID_AUDIO_FILE" });
  await workspace.cleanup();
});

test("refuse une jonction ou un lien symbolique dans le chemin source", async t => {
  const data = await fixture(t);
  const target = path.join(data.root, "autre");
  await fs.mkdir(target);
  const link = path.join(data.sourceRoot, "lien");
  await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(data.adapter.inspect(path.join(link, "fichier.bin")), { code: "SYMBOLIC_LINK_REFUSED" });
});

test("refuse les chemins frères et les traversées même quand elles reviennent dans la racine", async t => {
  const data = await fixture(t);
  await assert.rejects(data.adapter.inspect(path.join(data.root, "sources-annexes", "x.bin")), {
    code: "PATH_OUTSIDE_AUTHORIZED_ROOT",
  });
  const traversal = data.sourceRoot + path.sep + ".." + path.sep + "sources" + path.sep + "octets.bin";
  await assert.rejects(data.adapter.inspect(traversal), { code: "UNSAFE_LOCAL_PATH" });
  await assert.rejects(data.adapter.createWorkspace(data.sourceRoot), { code: "UNAUTHORIZED_TEMP_ROOT" });
  await assert.rejects(data.adapter.copyProtected(data.source, path.join(data.temporaryRoot, "x.bin")), {
    code: "PATH_OUTSIDE_AUTHORIZED_ROOT",
  });
});

test("une source remplacée depuis l’inspection est refusée même à octets identiques", async t => {
  const data = await fixture(t);
  const original = await data.adapter.inspect(data.source);
  await fs.rename(data.source, path.join(data.sourceRoot, "ancien.bin"));
  await fs.writeFile(data.source, data.bytes, { flag: "wx" });
  const workspace = await data.adapter.createWorkspace();
  await assert.rejects(data.adapter.copyProtected(data.source, path.join(workspace.root, "copie.bin"), original), {
    code: "AUDIO_SOURCE_CHANGED",
  });
  assert.deepEqual(await fs.readdir(workspace.root), []);
  await workspace.cleanup();
  assert.deepEqual(await fs.readFile(data.source), data.bytes);
});

test("refuse l’écrasement et nettoie ses copies après erreur", async t => {
  const data = await fixture(t);
  const workspace = await data.adapter.createWorkspace();
  const target = path.join(workspace.root, "distinct.bin");
  const original = await data.adapter.copyProtected(data.source, target);
  await assert.rejects(data.adapter.copyProtected(data.source, target), { code: "EEXIST" });
  assert.equal((await data.adapter.inspect(target)).identity, original.identity);
  await workspace.cleanup();
  await workspace.cleanup();
  assert.deepEqual(await fs.readdir(data.temporaryRoot), []);
  assert.deepEqual(await fs.readFile(data.source), data.bytes);
});

test("espaces distincts et nettoyage limité aux entrées possédées", async t => {
  const data = await fixture(t);
  const first = await data.adapter.createWorkspace();
  const second = await data.adapter.createWorkspace();
  assert.notEqual(first.root, second.root);
  assert.equal((await data.adapter.inspect(first.root)).private, true);
  if (process.platform !== "win32") assert.equal((await fs.stat(first.root)).mode & 0o777, 0o700);
  const secondCopy = path.join(second.root, "copie.bin");
  await data.adapter.copyProtected(data.source, secondCopy);
  const foreign = path.join(first.root, "étranger.bin");
  await fs.writeFile(foreign, "autre", { flag: "wx" });
  await assert.rejects(first.cleanup(), { code: "ENOTEMPTY" });
  assert.equal(await fs.readFile(foreign, "utf8"), "autre");
  assert.equal((await data.adapter.inspect(secondCopy)).protected, true);
  await fs.unlink(foreign);
  await first.cleanup();
  await second.cleanup();
});

test("sous Windows, la zone privée exige un verdict ACL explicite", { skip: process.platform !== "win32" }, async t => {
  const data = await fixture(t, { verifyWindowsPrivateDirectory: undefined });
  await assert.rejects(data.adapter.createWorkspace(), { code: "WINDOWS_PRIVATE_ACL_UNVERIFIED" });
  assert.deepEqual(await fs.readdir(data.temporaryRoot), []);
});

test("une copie remplacée est refusée et le nettoyage ne supprime pas son remplacement", async t => {
  const data = await fixture(t);
  const workspace = await data.adapter.createWorkspace();
  const target = path.join(workspace.root, "copie.bin");
  await data.adapter.copyProtected(data.source, target);
  await fs.rename(target, path.join(workspace.root, "copie-originale.bin"));
  await fs.writeFile(target, "remplacement", { flag: "wx" });
  await assert.rejects(data.adapter.inspect(target), { code: "AUDIO_COPY_REPLACED" });
  await assert.rejects(workspace.cleanup(), { code: "TEMP_FILE_REPLACED" });
  assert.equal(await fs.readFile(target, "utf8"), "remplacement");
  assert.deepEqual(await fs.readFile(data.source), data.bytes);
});

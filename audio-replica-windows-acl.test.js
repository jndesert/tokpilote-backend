"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");
const { createAudioReplicaFsAdapter } = require("./audio-replica-fs-adapter");
const { createWindowsPrivateDirectoryVerifier, isPrivateWindowsDacl } = require("./audio-replica-windows-acl");

const run = promisify(execFile);
const windows = process.platform === "win32";
const everyone = "S-1-1-0";
const sampleOwner = "S-1-5-21-1-2-3-1001";

test("politique simulée : SID, refus, groupes et ACL non interprétables", () => {
  const acl = (...aces) => ({ owner: sampleOwner, hasDacl: true, aces });
  const ace = (sid, mask, type = "AccessAllowed") => ({ sid, mask, type });
  assert.equal(isPrivateWindowsDacl(acl(ace(everyone, 1), ace(sampleOwner, 0x40000000)), sampleOwner), true);
  for (const mask of [2, 64, 0x40000, 0x10000000, 0x40000000]) {
    assert.equal(isPrivateWindowsDacl(acl(ace(everyone, mask), ace(everyone, mask, "AccessDenied")), sampleOwner), false);
  }
  assert.equal(isPrivateWindowsDacl(acl(ace(everyone, 1, "AccessAllowedCallback")), sampleOwner), false);
  assert.equal(isPrivateWindowsDacl({ ...acl(), hasDacl: false }, sampleOwner), false);
  assert.equal(isPrivateWindowsDacl({ ...acl(), owner: everyone }, sampleOwner), false);
});

const setTestAcl = `
$ErrorActionPreference = 'Stop'
$target = $env:VIDEAPILOT_ACL_TEST_PATH
$mode = $env:VIDEAPILOT_ACL_TEST_MODE
$acl = [Security.AccessControl.DirectorySecurity]::new()
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($current.Value, 'S-1-5-18', 'S-1-5-32-544')) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'
  )
  $acl.AddAccessRule($rule)
}
if ($mode -eq 'unreadable') {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.SecurityIdentifier]::new('S-1-3-4'), 'ReadPermissions', 'None', 'None', 'Deny'
  )
  $acl.AddAccessRule($rule)
} elseif ($mode -ne 'private') {
  $inheritance = if ($mode -eq 'inherited') { 'ContainerInherit,ObjectInherit' } else { 'None' }
  $propagation = if ($mode -eq 'inherited') { 'InheritOnly' } else { 'None' }
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'WriteData', $inheritance, $propagation, 'Allow'
  )
  $acl.AddAccessRule($rule)
}
[IO.Directory]::SetAccessControl($target, $acl)
`;

async function setAcl(directory, mode = "private") {
  const executable = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  await run(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(setTestAcl, "utf16le").toString("base64")], {
    env: { ...process.env, VIDEAPILOT_ACL_TEST_PATH: directory, VIDEAPILOT_ACL_TEST_MODE: mode },
    windowsHide: true, timeout: 10000,
  });
}

async function fixture(t) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, "replica-acl-test-"));
  t.after(async () => {
    assert.equal(path.dirname(root), temp);
    assert.match(path.basename(root), /^replica-acl-test-/);
    assert.equal(await fs.realpath(root), root);
    await fs.rm(root, { recursive: true });
  });
  await setAcl(root);
  return { root, verify: createWindowsPrivateDirectoryVerifier({ trustedRoot: root }) };
}

test("Windows réel : répertoire privé, héritage normal et adaptateur de fichiers", { skip: !windows }, async t => {
  const { root, verify } = await fixture(t);
  const sourceRoot = path.join(root, "sources");
  const temporaryRoot = path.join(root, "travail");
  await fs.mkdir(sourceRoot);
  await fs.mkdir(temporaryRoot);
  assert.equal(await verify(temporaryRoot), true);
  const adapter = await createAudioReplicaFsAdapter({ sourceRoot, temporaryRoot, verifyWindowsPrivateDirectory: verify });
  const workspace = await adapter.createWorkspace();
  assert.equal((await adapter.inspect(workspace.root)).private, true);
  await workspace.cleanup();
});

test("Windows réel : une DACL illisible échoue en refus fermé", { skip: !windows }, async t => {
  const { root, verify } = await fixture(t);
  const target = path.join(root, "acl-illisible");
  await fs.mkdir(target);
  await setAcl(target, "unreadable");
  assert.equal((await fs.lstat(target)).isDirectory(), true);
  assert.equal(await verify(target), false);
});

test("Windows réel : droit d’écriture public direct et hérité refusé", { skip: !windows }, async t => {
  const { root, verify } = await fixture(t);
  for (const mode of ["direct", "inherited"]) {
    const parent = path.join(root, mode);
    await fs.mkdir(parent);
    await setAcl(parent, mode);
    const child = path.join(parent, "child");
    await fs.mkdir(child);
    // The direct ACE stays with the parent; the inheritable ACE reaches the child.
    assert.equal(await verify(child), false);
    const verifyChildAcl = createWindowsPrivateDirectoryVerifier({ trustedRoot: child });
    assert.equal(await verifyChildAcl(child), mode === "direct");
  }
});

test("Windows réel : jonction et répertoire absent refusés", { skip: !windows }, async t => {
  const { root, verify } = await fixture(t);
  const target = path.join(root, "target");
  const link = path.join(root, "junction");
  await fs.mkdir(target);
  await fs.symlink(target, link, "junction");
  assert.equal(await verify(link), false);
  assert.equal(await verify(path.join(root, "absent")), false);
});

test("refus par défaut sans périmètre et si l’outil natif est indisponible", async t => {
  assert.equal(await createWindowsPrivateDirectoryVerifier()("C:\\tests"), false);
  if (!windows) return;
  const { root, verify } = await fixture(t);
  const previous = process.env.SystemRoot;
  try {
    process.env.SystemRoot = path.join(root, "systeme-absent");
    assert.equal(await verify(root), false);
  } finally {
    process.env.SystemRoot = previous;
  }
});

test("Windows réel : remplacement d’un répertoire entre les deux relevés d’identité", { skip: !windows }, async t => {
  const { root, verify } = await fixture(t);
  const target = path.join(root, "target");
  await fs.mkdir(target);
  const originalLstat = fs.lstat;
  let reads = 0;
  t.mock.method(fs, "lstat", async (candidate, options) => {
    if (candidate === target && ++reads === 2) {
      await fs.rename(target, path.join(root, "ancien"));
      await fs.mkdir(target);
    }
    return originalLstat(candidate, options);
  });
  assert.equal(await verify(target), false);
  assert.equal(reads, 2);
});

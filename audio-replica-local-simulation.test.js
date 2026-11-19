"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");
const { preflightAudioReplicas } = require("./audio-replica-preflight");
const { buildAudioReplicaMixPlan } = require("./audio-replica-mix-plan");
const { buildAudioReplicaFfmpegSpec } = require("./audio-replica-ffmpeg-spec");
const { createAudioReplicaFsAdapter } = require("./audio-replica-fs-adapter");
const { createWindowsPrivateDirectoryVerifier } = require("./audio-replica-windows-acl");
const { simulateLocalAudioReplicas } = require("./audio-replica-local-simulation");

const windows = process.platform === "win32";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const delays = [500, 7250, 13000, 16000, 20000, 24000, 33000, 38000, 48000, 57000];
const setTestAcl = `
$ErrorActionPreference = 'Stop'
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($sid in @($user, 'S-1-5-18', 'S-1-5-32-544')) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'
  )
  $acl.AddAccessRule($rule)
}
if ($env:VIDEAPILOT_SIMULATION_TEST_PUBLIC -eq 'true') {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'WriteData', 'None', 'None', 'Allow'
  ))
}
[IO.Directory]::SetAccessControl($env:VIDEAPILOT_SIMULATION_TEST_DIRECTORY, $acl)
`;

async function applyWindowsFixtureAcl(directory, publicWrite = false) {
  const executable = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  await promisify(execFile)(executable, [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(setTestAcl, "utf16le").toString("base64"),
  ], {
    env: { ...process.env, VIDEAPILOT_SIMULATION_TEST_DIRECTORY: directory,
      VIDEAPILOT_SIMULATION_TEST_PUBLIC: String(publicWrite) },
    windowsHide: true, timeout: 10000,
  });
}

function bind(input) {
  input.report = preflightAudioReplicas(input);
  input.mixPlan = buildAudioReplicaMixPlan(input);
  input.specification = buildAudioReplicaFfmpegSpec(input);
  assert.equal(input.specification.status, "OK");
}

async function fixture(t, count = 1) {
  const temp = await fs.realpath(os.tmpdir());
  const trustedRoot = await fs.mkdtemp(path.join(temp, "replica-simulation-test-"));
  t.after(async () => {
    assert.equal(path.dirname(trustedRoot), temp);
    assert.match(path.basename(trustedRoot), /^replica-simulation-test-/);
    assert.equal(await fs.realpath(trustedRoot), trustedRoot);
    await fs.rm(trustedRoot, { recursive: true });
  });
  if (windows) await applyWindowsFixtureAcl(trustedRoot);
  const sourceRoot = path.join(trustedRoot, "sources");
  const temporaryRoot = path.join(trustedRoot, "travail");
  await fs.mkdir(sourceRoot, { mode: 0o700 });
  await fs.mkdir(temporaryRoot, { mode: 0o700 });
  const inspector = await createAudioReplicaFsAdapter({ sourceRoot, temporaryRoot });
  const scenes = [[0, 7], [7, 13], [13, 32], [32, 47], [47, 67]]
    .map(([startSeconds, endSeconds], index) => ({ sceneNumber: index + 1, startSeconds, endSeconds }));
  const sceneNumbers = [1, 2, 3, 3, 3, 3, 4, 4, 5, 5];
  const voices = {
    narrateur: ["Narrateur", "onyx"], leo: ["Léo", "echo"],
    petite_fille_sur_un_balcon: ["Petite fille sur un balcon", "shimmer"],
  };
  const voiceIds = ["narrateur", "narrateur", "petite_fille_sur_un_balcon", "petite_fille_sur_un_balcon",
    "leo", "narrateur", "leo", "narrateur", "leo", "narrateur"];
  const audioGenerationPlan = delays.slice(0, count).map((delay, index) => ({
    segmentId: `segment_${index + 1}`, sceneNumber: sceneNumbers[index],
    startSeconds: delay / 1000, endSeconds: delay / 1000 + 2,
    character: voices[voiceIds[index]][0], voiceId: voiceIds[index], text: "Fixture de simulation",
  }));
  const files = [];
  for (const { segmentId, character, voiceId } of audioGenerationPlan) {
    const filePath = path.join(sourceRoot, `${segmentId}.mp3`);
    // Plain JSON bytes with the suffix expected by the specification; never encoded audio.
    const bytes = Buffer.from(JSON.stringify({ segmentId, durationSeconds: 1.5 }));
    await fs.writeFile(filePath, bytes, { flag: "wx" });
    const observed = await inspector.inspect(filePath);
    assert.equal(observed.sha256, hash(bytes));
    files.push({ segmentId, character, voiceId, voice: voices[voiceId][1], filePath,
      durationSeconds: 1.5, identity: observed.identity, sha256: observed.sha256 });
  }
  const input = { mode: "simulation", sourceRoot, temporaryRoot, scenes, audioGenerationPlan,
    expectedDurationSeconds: 67, files, outputPath: path.join(temporaryRoot, "proposition.wav") };
  bind(input);
  const probes = [];
  const launches = [];
  const dependencies = {
    trustedRoot,
    async measureDurationSeconds(filePath) {
      assert.equal(path.dirname(path.dirname(filePath)), temporaryRoot);
      probes.push(filePath);
      return JSON.parse(await fs.readFile(filePath, "utf8")).durationSeconds;
    },
    async launchSimulation(spec) {
      launches.push(spec);
      return { exitCode: 0 };
    },
  };
  return { input, dependencies, launches, probes };
}

test("intégration réelle des fichiers : dix copies, positions absolues et lanceur simulé", async t => {
  const { input, dependencies, launches, probes } = await fixture(t, 10);
  const preview = dependencies.launchSimulation;
  const sourcePaths = input.files.map(file => file.filePath);
  dependencies.launchSimulation = async spec => {
    assert.equal(spec.mode, "simulation");
    assert.equal(spec.shell, false);
    assert.ok(spec.args.includes("-n"));
    const copyPaths = spec.args.flatMap((arg, index) => arg === "-i" ? [spec.args[index + 1]] : []);
    assert.deepEqual(copyPaths, probes);
    assert.equal(copyPaths.length, 10);
    const workspace = path.dirname(spec.args.at(-1));
    assert.equal(path.dirname(workspace), input.temporaryRoot);
    assert.ok(copyPaths.every(filePath => path.dirname(filePath) === workspace && !sourcePaths.includes(filePath)));
    for (const [index, filePath] of copyPaths.entries()) {
      assert.equal(hash(await fs.readFile(filePath)), input.files[index].sha256);
      const stat = await fs.lstat(filePath);
      assert.ok(stat.isFile() && !stat.isSymbolicLink());
      if (!windows) assert.equal(stat.mode & 0o777, 0o400);
    }
    await assert.rejects(fs.access(spec.args.at(-1)), { code: "ENOENT" });
    return preview(spec);
  };
  const result = await simulateLocalAudioReplicas(input, dependencies);
  assert.equal(result.status, "SIMULÉ", JSON.stringify(result.errors));
  assert.equal(launches.length, 1);
  assert.deepEqual(result.launch.delaysMs, delays);
  assert.equal(result.launch.totalDurationSeconds, 67);
  assert.ok(result.launch.args.some(arg => arg.includes("atrim=duration=67,apad=whole_dur=67")));
  assert.equal(result.executed, false);
  assert.equal(result.outputVerified, false);
  assert.equal(result.cleanup, "TERMINÉ");
  assert.deepEqual(await fs.readdir(input.temporaryRoot), []);
  for (const source of input.files) assert.equal(hash(await fs.readFile(source.filePath)), source.sha256);
});

for (const [label, code, mutate] of [
  ["fichier remplacé", "AUDIO_IDENTITY_CHANGED", async ({ input }) => {
    const filePath = input.files[0].filePath;
    const bytes = await fs.readFile(filePath);
    await fs.rename(filePath, path.join(input.sourceRoot, "ancien.bin"));
    await fs.writeFile(filePath, bytes, { flag: "wx" });
  }],
  ["empreinte différente", "AUDIO_FINGERPRINT_MISMATCH", ({ input }) => {
    input.files[0].sha256 = "0".repeat(64);
    bind(input);
  }],
  ["rapport périmé", "STALE_OR_INCONSISTENT_SPECIFICATION", ({ input }) => {
    input.audioGenerationPlan[0].text = "Texte changé";
  }],
  ["durée modifiée", "COPY_DURATION_CHANGED", ({ dependencies }) => {
    dependencies.measureDurationSeconds = () => 1.4;
  }],
]) {
  test(`intégration : refus pour ${label}`, async t => {
    const data = await fixture(t);
    await mutate(data);
    const result = await simulateLocalAudioReplicas(data.input, data.dependencies);
    assert.equal(result.status, "BLOQUÉ");
    assert.equal(result.errors[0].code, code);
    assert.equal(result.launch.attempted, false);
    assert.equal(result.outputVerified, false);
    assert.deepEqual(await fs.readdir(data.input.temporaryRoot), []);
  });
}

test("Windows réel : une autorisation publique d’écriture bloque la composition", { skip: !windows }, async t => {
  const { input, dependencies, launches } = await fixture(t);
  const verify = createWindowsPrivateDirectoryVerifier({ trustedRoot: dependencies.trustedRoot });
  assert.equal(await verify(input.temporaryRoot), true);
  await applyWindowsFixtureAcl(input.temporaryRoot, true);
  assert.equal(await verify(input.temporaryRoot), false);
  const result = await simulateLocalAudioReplicas(input, dependencies);
  assert.equal(result.errors[0].code, "WORKSPACE_CREATION_FAILED");
  assert.equal(launches.length, 0);
  assert.deepEqual(await fs.readdir(input.temporaryRoot), []);
});

for (const [name, code, launchSimulation] of [
  ["code de sortie", "SIMULATED_NONZERO_EXIT", () => ({ exitCode: 5 })],
  ["échec de lancement", "SIMULATED_LAUNCH_FAILED", () => { throw new Error("simulé"); }],
]) {
  test(`intégration : nettoyage après ${name}`, async t => {
    const { input, dependencies } = await fixture(t);
    const result = await simulateLocalAudioReplicas(input, { ...dependencies, launchSimulation });
    assert.equal(result.status, "BLOQUÉ");
    assert.equal(result.errors[0].code, code);
    assert.equal(result.launch.attempted, true);
    assert.equal(result.cleanup, "TERMINÉ");
    assert.equal(result.outputVerified, false);
    assert.deepEqual(await fs.readdir(input.temporaryRoot), []);
    assert.equal(hash(await fs.readFile(input.files[0].filePath)), input.files[0].sha256);
  });
}

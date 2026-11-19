"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");
const { createAudioReplicaFsAdapter } = require("./audio-replica-fs-adapter");
const { createAudioMeasurementSourceReport, measureProtectedAudioReplicas } = require("./audio-replica-measurement-bridge");

const windows = process.platform === "win32";
const authorizedProbe = process.env.VIDEAPILOT_TEST_FFPROBE;
const delays = [500, 7250, 13000, 16000, 20000, 24000, 33000, 38000, 48000, 57000];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

async function setPrivateAcl(directory) {
  const script = `
$ErrorActionPreference = 'Stop'
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($sid in @($user, 'S-1-5-18', 'S-1-5-32-544')) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'
  ))
}
[IO.Directory]::SetAccessControl($env:VIDEAPILOT_BRIDGE_TEST_ROOT, $acl)
`;
  await promisify(execFile)(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { env: { ...process.env, VIDEAPILOT_BRIDGE_TEST_ROOT: directory }, windowsHide: true, timeout: 10000 });
}

function pcmWave(index) {
  // Exactly 1,000 PCM samples at 8 kHz. An index in the first sample makes each fixture distinct.
  const bytes = Buffer.alloc(2044);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(2000, 40);
  bytes.writeInt16LE(index, 44);
  return bytes;
}

async function fixture(t, { mode = "simulation", count = 1 } = {}) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, "replica-measurement-test-"));
  t.after(async () => {
    assert.equal(path.dirname(root), temp);
    assert.match(path.basename(root), /^replica-measurement-test-/);
    assert.equal(await fs.realpath(root), root);
    await fs.rm(root, { recursive: true });
  });
  if (windows) await setPrivateAcl(root);
  const sourceRoot = path.join(root, "sources");
  const temporaryRoot = path.join(root, "travail");
  await fs.mkdir(sourceRoot, { mode: 0o700 });
  await fs.mkdir(temporaryRoot, { mode: 0o700 });
  const inspector = await createAudioReplicaFsAdapter({ sourceRoot, temporaryRoot });
  const scenes = [[0, 7], [7, 13], [13, 32], [32, 47], [47, 67]]
    .map(([startSeconds, endSeconds], index) => ({ sceneNumber: index + 1, startSeconds, endSeconds }));
  const numbers = [1, 2, 3, 3, 3, 3, 4, 4, 5, 5];
  const audioGenerationPlan = delays.slice(0, count).map((delay, index) => ({
    segmentId: `segment_${index + 1}`, sceneNumber: numbers[index], text: "Fixture",
    startSeconds: delay / 1000, endSeconds: delay / 1000 + 0.5, character: "Léo", voiceId: "leo",
  }));
  const files = [];
  for (const [index, segment] of audioGenerationPlan.entries()) {
    const filePath = path.join(sourceRoot, `${segment.segmentId}.wav`);
    await fs.writeFile(filePath, pcmWave(index), { flag: "wx" });
    const { identity, sha256 } = await inspector.inspect(filePath);
    files.push({ segmentId: segment.segmentId, filePath, identity, sha256, character: "Léo", voiceId: "leo", voice: "echo",
      durationSeconds: 99 });
  }
  const input = { mode, sourceRoot, temporaryRoot, trustedRoot: root, scenes, audioGenerationPlan, files, expectedDurationSeconds: 67,
    ffprobePath: mode === "real" ? authorizedProbe : path.join(root, windows ? "ffprobe.exe" : "ffprobe") };
  input.sourceReport = createAudioMeasurementSourceReport(input);
  const launches = [];
  const dependencies = { launchSimulation: async spec => { launches.push(spec); return { exitCode: 0 }; } };
  if (mode === "simulation") dependencies.simulateProbe = fakeProbe();
  return { input, dependencies, launches };
}

function fakeProbe(duration = "0.125000") {
  return async () => ({ stdout: JSON.stringify({
    streams: [{ codec_type: "audio", codec_name: "pcm_s16le", duration }],
  }) });
}

test("FFprobe réel : dix durées mesurées sur copies et dix positions absolues transmises au faux lanceur",
  { skip: !authorizedProbe && "Configurer VIDEAPILOT_TEST_FFPROBE" }, async t => {
    const { input, dependencies, launches } = await fixture(t, { mode: "real", count: 10 });
    const launch = dependencies.launchSimulation;
    dependencies.launchSimulation = async spec => {
      assert.equal(spec.launchMode, "simulation");
      assert.equal(spec.shell, false);
      const paths = spec.args.flatMap((arg, index) => arg === "-i" ? [spec.args[index + 1]] : []);
      assert.equal(paths.length, 10);
      const workspace = path.dirname(spec.outputPath);
      assert.equal(path.dirname(workspace), input.temporaryRoot);
      for (const [index, filePath] of paths.entries()) {
        assert.equal(path.dirname(filePath), workspace);
        assert.notEqual(filePath, input.files[index].filePath);
        assert.equal(hash(await fs.readFile(filePath)), input.files[index].sha256);
      }
      await assert.rejects(fs.access(spec.outputPath), { code: "ENOENT" });
      return launch(spec);
    };
    const result = await measureProtectedAudioReplicas(input, dependencies);
    assert.equal(result.status, "SIMULÉ", JSON.stringify(result.errors));
    assert.equal(result.measurements.length, 10);
    assert.ok(result.measurements.every(({ mode, codec, streamDurationSeconds, containerDurationSeconds }) =>
      mode === "real" && codec === "pcm_s16le" && streamDurationSeconds === 0.125 && containerDurationSeconds === 0.125));
    t.diagnostic(`FFprobe ${result.measurements[0].ffprobeVersion}, dix flux PCM réellement mesurés à 0,125 s`);
    assert.deepEqual(result.report.segments.map(segment => segment.durationSeconds), Array(10).fill(0.125));
    assert.deepEqual(result.specification.inputs.map(entry => entry.delayMs), delays);
    assert.equal(result.specification.totalDurationSeconds, 67);
    assert.equal(result.executed, false);
    assert.equal(result.outputVerified, false);
    assert.equal(launches.length, 1);
    assert.equal(result.cleanup, "TERMINÉ");
    assert.deepEqual(await fs.readdir(input.temporaryRoot), []);
  });

for (const [label, code, mutate] of [
  ["mesure manquante", "INVALID_PROBE_DURATION", ({ dependencies }) => { dependencies.simulateProbe = fakeProbe(null); }],
  ["durée invalide", "INVALID_PROBE_DURATION", ({ dependencies }) => { dependencies.simulateProbe = fakeProbe("-1"); }],
  ["empreinte différente", "AUDIO_SOURCE_CHANGED", ({ input }) => {
    input.files[0].sha256 = "0".repeat(64);
    input.sourceReport = createAudioMeasurementSourceReport(input);
  }],
  ["rapport périmé", "STALE_MEASUREMENT_SOURCE_REPORT", ({ input }) => { input.audioGenerationPlan[0].text = "changé"; }],
  ["dépassement de fenêtre", "MEASURED_PREFLIGHT_BLOCKED", ({ dependencies }) => { dependencies.simulateProbe = fakeProbe("8"); }],
  ["échec FFprobe simulé", "FFPROBE_FAILED", ({ dependencies }) => {
    dependencies.simulateProbe = async () => { throw new Error("panne fictive"); };
  }],
]) {
  test(`sonde simulée : ${label} bloque et nettoie`, async t => {
    const data = await fixture(t);
    mutate(data);
    const result = await measureProtectedAudioReplicas(data.input, data.dependencies);
    assert.equal(result.status, "BLOQUÉ");
    assert.equal(result.errors[0].code, code);
    if (code === "MEASURED_PREFLIGHT_BLOCKED") {
      assert.ok(result.errors[0].details.some(error => error.code === "AUDIO_OUTSIDE_SCENE"));
    }
    assert.equal(result.outputVerified, false);
    assert.equal(data.launches.length, 0);
    assert.deepEqual(await fs.readdir(data.input.temporaryRoot), []);
    assert.equal(hash(await fs.readFile(data.input.files[0].filePath)), hash(pcmWave(0)));
  });
}

test("sonde simulée : une copie remplacée après sa mesure bloque le lancement", async t => {
  const { input, dependencies, launches } = await fixture(t, { count: 2 });
  let firstCopy;
  dependencies.simulateProbe = async (_executable, args) => {
    const filePath = args.at(-1);
    if (firstCopy) {
      await fs.rename(firstCopy, firstCopy + ".ancien");
      await fs.writeFile(firstCopy, pcmWave(0), { flag: "wx" });
    } else {
      firstCopy = filePath;
    }
    return fakeProbe()();
  };
  const result = await measureProtectedAudioReplicas(input, dependencies);
  assert.equal(result.errors[0].code, "AUDIO_COPY_REPLACED");
  assert.equal(result.status, "BLOQUÉ");
  assert.equal(launches.length, 0);
  // Cleanup refuses to delete a replacement it does not own. The fixture hook then removes its complete test root.
  assert.equal(result.cleanup, "ÉCHEC");
  assert.equal(await fs.readFile(firstCopy).then(hash), hash(pcmWave(0)));
});

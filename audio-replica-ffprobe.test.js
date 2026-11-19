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
const { createWindowsPrivateDirectoryVerifier } = require("./audio-replica-windows-acl");
const { createAudioReplicaDurationProbe, parseAudioProbe } = require("./audio-replica-ffprobe");

const windows = process.platform === "win32";
const binaryName = windows ? "ffprobe.exe" : "ffprobe";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const protectedRoot = path.join(__dirname, "copies-virtuelles");
  const ffprobePath = path.join(__dirname, "binaire-virtuel", binaryName);
  const filePath = path.join(protectedRoot, "replica.mp3");
  const bytes = Buffer.from("octets fictifs");
  const request = { filePath, identity: "fichier_1", sha256: digest(bytes) };
  const info = { kind: "file", protected: true, isSymbolicLink: false, realPath: filePath, identity: request.identity, bytes };
  const output = { streams: [{ codec_type: "audio", codec_name: "mp3", duration: "1.000000" }], format: { duration: "1.040000" } };
  return { request, info, output, options: { ffprobePath, protectedRoot, mode: "simulation",
    inspect: async () => info, simulateProbe: async () => ({ stdout: JSON.stringify(output) }) } };
}

test("simulation : flux et conteneur distincts, arguments fixes et mode explicite", async () => {
  const data = fixture();
  const probe = createAudioReplicaDurationProbe({ ...data.options, simulateProbe: async (executable, args, options) => {
    assert.equal(executable, data.options.ffprobePath);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 5000);
    assert.equal(options.maxBuffer, 65536);
    assert.deepEqual(args.slice(0, 6), ["-v", "error", "-protocol_whitelist", "file", "-f", "mp3"]);
    assert.deepEqual(args.slice(-4), ["-of", "json", "-i", data.request.filePath]);
    return { stdout: JSON.stringify(data.output) };
  } });
  assert.deepEqual(await probe(data.request), {
    mode: "simulation", codec: "mp3", streamDurationSeconds: 1, containerDurationSeconds: 1.04,
    toleranceSeconds: 0.08, ffprobeVersion: null,
  });
});

test("parsing simulé : JSON, flux invalides et dépassements rejetés", () => {
  assert.throws(() => parseAudioProbe("{"), { code: "INVALID_PROBE_JSON" });
  for (const streams of [[], [{ codec_type: "video" }], [fixture().output.streams[0], { codec_type: "video" }]]) {
    assert.throws(() => parseAudioProbe(JSON.stringify({ streams })), { code: "EXPECTED_SINGLE_AUDIO_STREAM" });
  }
  for (const duration of [undefined, "N/A", "Infinity", "-1", "0", "1.2abc", null]) {
    const { output } = fixture();
    output.streams[0].duration = duration;
    assert.throws(() => parseAudioProbe(JSON.stringify(output)), { code: "INVALID_PROBE_DURATION" });
  }
  const { output } = fixture();
  output.format.duration = "1.2";
  assert.throws(() => parseAudioProbe(JSON.stringify(output)), { code: "INCONSISTENT_PROBE_DURATIONS" });
  delete output.format.duration;
  assert.equal(parseAudioProbe(JSON.stringify(output)).containerDurationSeconds, null);
});

test("simulation : fichier absent, chemin extérieur et empreinte incorrecte", async () => {
  const data = fixture();
  const neverRun = async () => assert.fail("Lancement inattendu");
  const options = { ...data.options, simulateProbe: neverRun };
  await assert.rejects(createAudioReplicaDurationProbe({ ...options, inspect: async () => undefined })(data.request),
    { code: "PROBE_FILE_MISSING" });
  await assert.rejects(createAudioReplicaDurationProbe(options)({ ...data.request, filePath: path.join(__dirname, "autre.mp3") }),
    { code: "INVALID_PROBE_INPUT" });
  await assert.rejects(createAudioReplicaDurationProbe(options)({ ...data.request, sha256: "0".repeat(64) }),
    { code: "PROBE_FINGERPRINT_MISMATCH" });
  assert.throws(() => createAudioReplicaDurationProbe({ ...options, ffprobePath: binaryName }),
    { code: "INVALID_PROBE_CONFIGURATION" });
  assert.throws(() => createAudioReplicaDurationProbe({ ...options, mode: "real" }),
    { code: "INVALID_PROBE_CONFIGURATION" });
});

test("simulation : timeout et sortie excessive", async () => {
  const { request, options } = fixture();
  const timeout = createAudioReplicaDurationProbe({ ...options, simulateProbe: async () => {
    throw Object.assign(new Error("timeout fictif"), { code: "ETIMEDOUT" });
  } });
  await assert.rejects(timeout(request), { code: "FFPROBE_TIMEOUT" });
  const excess = createAudioReplicaDurationProbe({ ...options, simulateProbe: async () => ({ stdout: " ".repeat(65537) }) });
  await assert.rejects(excess(request), { code: "FFPROBE_OUTPUT_TOO_LARGE" });
});

test("simulation : identité et octets revérifiés après la sonde", async () => {
  for (const [code, change] of [
    ["PROBE_FILE_REPLACED", info => { info.identity = "autre"; }],
    ["PROBE_FINGERPRINT_MISMATCH", info => { info.bytes = Buffer.from("changé"); }],
  ]) {
    const data = fixture();
    const probe = createAudioReplicaDurationProbe({ ...data.options, simulateProbe: async () => {
      change(data.info);
      return { stdout: JSON.stringify(data.output) };
    } });
    await assert.rejects(probe(data.request), { code });
  }
});

async function setPrivateFixtureAcl(directory) {
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
[IO.Directory]::SetAccessControl($env:VIDEAPILOT_FFPROBE_TEST_ROOT, $acl)
`;
  await promisify(execFile)(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { env: { ...process.env, VIDEAPILOT_FFPROBE_TEST_ROOT: directory }, windowsHide: true, timeout: 10000 });
}

function tinyPcmWave() {
  // RIFF/WAVE fixture written by hand: 1,000 mono PCM samples at 8 kHz.
  const bytes = Buffer.alloc(44 + 2000);
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
  return bytes;
}

const authorizedProbe = process.env.VIDEAPILOT_TEST_FFPROBE;
test("FFprobe réel : durée de la copie PCM protégée, version et refus d’un WAV corrompu",
  { skip: authorizedProbe ? false : "Indiquer un exécutable autorisé dans VIDEAPILOT_TEST_FFPROBE" }, async t => {
    const temp = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(temp, "replica-ffprobe-test-"));
    t.after(async () => {
      assert.equal(path.dirname(root), temp);
      assert.match(path.basename(root), /^replica-ffprobe-test-/);
      assert.equal(await fs.realpath(root), root);
      await fs.rm(root, { recursive: true });
    });
    if (windows) await setPrivateFixtureAcl(root);
    const sourceRoot = path.join(root, "sources");
    const temporaryRoot = path.join(root, "travail");
    await fs.mkdir(sourceRoot, { mode: 0o700 });
    await fs.mkdir(temporaryRoot, { mode: 0o700 });
    const adapter = await createAudioReplicaFsAdapter({
      sourceRoot, temporaryRoot,
      verifyWindowsPrivateDirectory: windows ? createWindowsPrivateDirectoryVerifier({ trustedRoot: root }) : undefined,
    });
    const workspace = await adapter.createWorkspace();
    try {
      const probe = createAudioReplicaDurationProbe({
        ffprobePath: authorizedProbe, protectedRoot: workspace.root, inspect: adapter.inspect,
      });
      async function copyFixture(name, bytes) {
        const source = path.join(sourceRoot, name);
        const filePath = path.join(workspace.root, name);
        await fs.writeFile(source, bytes, { flag: "wx" });
        const copy = await adapter.copyProtected(source, filePath);
        return { filePath, identity: copy.identity, sha256: copy.sha256 };
      }
      const measured = await probe(await copyFixture("pcm.wav", tinyPcmWave()));
      assert.equal(measured.mode, "real");
      assert.equal(measured.codec, "pcm_s16le");
      assert.equal(measured.streamDurationSeconds, 0.125);
      assert.equal(measured.containerDurationSeconds, 0.125);
      assert.ok(measured.ffprobeVersion);
      t.diagnostic(`FFprobe ${measured.ffprobeVersion} : flux PCM et conteneur mesurés à 0,125 s`);
      await assert.rejects(probe(await copyFixture("corrompu.wav", Buffer.from("octets invalides"))),
        { code: "FFPROBE_FAILED" });
    } finally {
      await workspace.cleanup();
    }
    assert.deepEqual(await fs.readdir(temporaryRoot), []);
  });

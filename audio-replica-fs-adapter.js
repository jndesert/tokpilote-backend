"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const windows = process.platform === "win32";
const noFollow = constants.O_NOFOLLOW ?? 0;
const nonBlock = constants.O_NONBLOCK ?? 0;
const inode = stats => `${stats.dev}:${stats.ino}`;
const identity = stats => [inode(stats), stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function absolute(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) ||
      /^[\\/]{2}/.test(filePath) || /[\x00-\x1f\x7f]/.test(filePath) ||
      filePath.split(windows ? /[\\/]/ : "/").includes("..") ||
      (windows && (!/^[a-z]:[\\/]/i.test(filePath) || /[:*?"<>|]/.test(filePath.slice(2))))) {
    fail("UNSAFE_LOCAL_PATH");
  }
  if (windows && filePath.slice(2).split(/[\\/]/).some(component =>
    /[ .]$/.test(component) ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(component))) {
    fail("UNSAFE_LOCAL_PATH");
  }
  return path.resolve(filePath);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

async function noLinks(root, candidate) {
  let current = root;
  for (const component of path.relative(root, candidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if ((await fs.lstat(current)).isSymbolicLink()) fail("SYMBOLIC_LINK_REFUSED");
  }
  if (await fs.realpath(candidate) !== candidate) fail("NONCANONICAL_PATH");
}

async function directoryStats(directory) {
  const stats = await fs.lstat(directory, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink() || !stats.ino || await fs.realpath(directory) !== directory) {
    fail("UNSAFE_DIRECTORY");
  }
  return stats;
}

// Roots must be under trusted parents. Node does not offer dirfd-relative open on
// all supported platforms. O_NOFOLLOW, when available, covers the final component.
// On Windows, mode bits do not prove ACL privacy: a trusted ACL verifier is required.
async function createAudioReplicaFsAdapter({
  sourceRoot, temporaryRoot, verifyWindowsPrivateDirectory, maxBytes = 20 * 1024 * 1024,
} = {}) {
  sourceRoot = absolute(sourceRoot);
  temporaryRoot = absolute(temporaryRoot);
  if (path.relative(sourceRoot, temporaryRoot) === "" || inside(sourceRoot, temporaryRoot) ||
      inside(temporaryRoot, sourceRoot) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 100 * 1024 * 1024) {
    fail("INVALID_AUDIO_ROOTS_OR_LIMIT");
  }
  const sourceRootId = inode(await directoryStats(sourceRoot));
  const tempRootId = inode(await directoryStats(temporaryRoot));
  const workspaces = new Map();

  async function assertDirectory(directory, expectedId, privateDirectory = false) {
    const stats = await directoryStats(directory);
    if (inode(stats) !== expectedId) fail("DIRECTORY_REPLACED");
    if (privateDirectory) {
      const privateAccess = windows
        ? typeof verifyWindowsPrivateDirectory === "function" && await verifyWindowsPrivateDirectory(directory) === true
        : (stats.mode & 0o077n) === 0n && stats.uid === BigInt(process.getuid());
      if (!privateAccess) fail(windows ? "WINDOWS_PRIVATE_ACL_UNVERIFIED" : "TEMP_DIRECTORY_NOT_PRIVATE");
    }
    return stats;
  }

  async function readRegular(root, candidate, rootId, privateDirectory = false) {
    await assertDirectory(root, rootId, privateDirectory);
    await noLinks(root, candidate);
    const initial = await fs.lstat(candidate, { bigint: true });
    if (!initial.isFile() || !initial.ino || initial.size <= 0n || initial.size > BigInt(maxBytes)) {
      fail("INVALID_AUDIO_FILE");
    }
    const descriptor = await fs.open(candidate, constants.O_RDONLY | noFollow | nonBlock);
    try {
      const before = await descriptor.stat({ bigint: true });
      if (!before.isFile() || identity(before) !== identity(initial)) fail("AUDIO_FILE_REPLACED");
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await descriptor.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) fail("AUDIO_FILE_REPLACED");
        offset += bytesRead;
      }
      await assertDirectory(root, rootId, privateDirectory);
      await noLinks(root, candidate);
      const after = await descriptor.stat({ bigint: true });
      const current = await fs.lstat(candidate, { bigint: true });
      if (!current.isFile() || identity(after) !== identity(before) || identity(current) !== identity(before)) {
        fail("AUDIO_FILE_REPLACED");
      }
      return { kind: "file", realPath: candidate, isSymbolicLink: false, identity: identity(after), bytes,
        sha256: digest(bytes) };
    } finally {
      await descriptor.close();
    }
  }

  async function inspect(filePath) {
    const candidate = absolute(filePath);
    const workspace = workspaces.get(candidate);
    if (workspace) {
      await assertDirectory(candidate, workspace.id, true);
      return { kind: "directory", realPath: candidate, isSymbolicLink: false, identity: workspace.id, private: true };
    }
    const parent = path.dirname(candidate);
    const temporary = workspaces.get(parent);
    if (!temporary && !inside(sourceRoot, candidate)) fail("PATH_OUTSIDE_AUTHORIZED_ROOT");
    try {
      const result = await readRegular(temporary ? parent : sourceRoot, candidate,
        temporary?.id ?? sourceRootId, Boolean(temporary));
      const created = temporary?.copies.get(candidate);
      if (created?.identity && created.identity !== result.identity) fail("AUDIO_COPY_REPLACED");
      return { ...result, protected: Boolean(created?.identity) };
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async function createWorkspace(requestedRoot = temporaryRoot) {
    if (absolute(requestedRoot) !== temporaryRoot) fail("UNAUTHORIZED_TEMP_ROOT");
    await assertDirectory(temporaryRoot, tempRootId, true);
    const root = await fs.mkdtemp(path.join(temporaryRoot, "audio-replicas-"));
    const stats = await directoryStats(root);
    const workspace = { id: inode(stats), copies: new Map() };
    const cleanup = async () => {
      if (!workspaces.has(root)) return;
      await assertDirectory(temporaryRoot, tempRootId, true);
      await assertDirectory(root, workspace.id, true);
      for (const [filePath, created] of workspace.copies) {
        await assertDirectory(root, workspace.id, true);
        const current = await fs.lstat(filePath, { bigint: true }).catch(error => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!current) continue;
        if (!current.isFile() || inode(current) !== created.inode ||
            (created.identity && identity(current) !== created.identity)) fail("TEMP_FILE_REPLACED");
        await fs.unlink(filePath);
      }
      await assertDirectory(root, workspace.id, true);
      await fs.rmdir(root);
      workspaces.delete(root);
    };
    try {
      if (!windows) await fs.chmod(root, 0o700);
      await assertDirectory(root, workspace.id, true);
      workspaces.set(root, workspace);
      return { root, cleanup };
    } catch (error) {
      // An unverified directory may only be removed while empty and still ours.
      await assertDirectory(temporaryRoot, tempRootId, true);
      await assertDirectory(root, workspace.id);
      await fs.rmdir(root);
      throw error;
    }
  }

  async function copyProtected(sourcePath, destinationPath, expected = {}) {
    const source = absolute(sourcePath);
    const destination = absolute(destinationPath);
    const root = path.dirname(destination);
    const workspace = workspaces.get(root);
    if (!inside(sourceRoot, source) || !workspace) fail("PATH_OUTSIDE_AUTHORIZED_ROOT");
    const original = await readRegular(sourceRoot, source, sourceRootId);
    if ((expected.identity !== undefined && expected.identity !== original.identity) ||
        (expected.sha256 !== undefined && expected.sha256 !== original.sha256)) fail("AUDIO_SOURCE_CHANGED");

    await assertDirectory(root, workspace.id, true);
    const descriptor = await fs.open(destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    let created;
    try {
      const stats = await descriptor.stat({ bigint: true });
      if (!stats.isFile() || !stats.ino) fail("INVALID_AUDIO_COPY");
      created = { inode: inode(stats) };
      workspace.copies.set(destination, created);
      if (!windows) await descriptor.chmod(0o400);
      await descriptor.writeFile(original.bytes);
      const written = await descriptor.stat({ bigint: true });
      created.identity = identity(written);
    } finally {
      await descriptor.close();
    }
    const copy = await inspect(destination);
    if (!copy || copy.sha256 !== original.sha256 || copy.identity === original.identity) fail("AUDIO_COPY_MISMATCH");
    const current = await readRegular(sourceRoot, source, sourceRootId);
    if (current.identity !== original.identity || current.sha256 !== original.sha256) fail("AUDIO_SOURCE_CHANGED");
    const { bytes, ...metadata } = copy;
    return metadata;
  }

  return { inspect, createWorkspace, copyProtected };
}

module.exports = { createAudioReplicaFsAdapter };

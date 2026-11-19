"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const run = promisify(execFile);
const sidPattern = /^S-\d+(?:-\d+)+$/;
// File writes, child deletion, standard mutation rights and generic write/all.
const dangerous = 0x500d0156;
const readScript = `
$ErrorActionPreference = 'Stop'
$items = ConvertFrom-Json -InputObject $env:VIDEAPILOT_ACL_READ_PATHS
$descriptors = @(
  foreach ($item in $items) {
    $entry = Get-Item -LiteralPath $item -Force
    if (-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'Invalid directory'
    }
    $sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
    $acl = [IO.Directory]::GetAccessControl($item, $sections)
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    $aces = @(
      foreach ($ace in $raw.DiscretionaryAcl) {
        if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback) { throw 'Unsupported ACE' }
        [pscustomobject]@{ type = [string]$ace.AceType; sid = $ace.SecurityIdentifier.Value; mask = $ace.AccessMask }
      }
    )
    [pscustomobject]@{
      owner = $raw.Owner.Value
      hasDacl = ($null -ne $raw.DiscretionaryAcl) -and
        [bool]($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent)
      aces = $aces
    }
  }
)
[pscustomobject]@{
  user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  descriptors = $descriptors
} | ConvertTo-Json -Compress -Depth 5
`;

function isPrivateWindowsDacl(descriptor, user) {
  if (typeof user !== "string" || !sidPattern.test(user)) return false;
  const trusted = new Set([user, "S-1-5-18", "S-1-5-32-544"]);
  if (descriptor?.hasDacl !== true || !trusted.has(descriptor.owner) || !Array.isArray(descriptor.aces)) return false;
  // A denial does not prove that all users or groups covered by an allow
  // are denied. Reject the ambiguous grant, even if a deny ACE is present.
  return descriptor.aces.every(ace =>
    typeof ace?.sid === "string" && sidPattern.test(ace.sid) &&
    Number.isInteger(ace.mask) && ace.mask >= -0x80000000 && ace.mask <= 0x7fffffff &&
    (ace.type === "AccessDenied" ||
      (ace.type === "AccessAllowed" && (trusted.has(ace.sid) || (ace.mask & dangerous) === 0))));
}

function canonicalInput(directory) {
  if (typeof directory !== "string" || !/^[a-z]:[\\/]/i.test(directory) ||
      /[:*?"<>|\x00-\x1f]/.test(directory.slice(2)) ||
      directory.slice(2).split(/[\\/]/).some(part => part === ".." || /[ .]$/.test(part))) return null;
  return path.win32.resolve(directory);
}

async function readIdentity(directory) {
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !stat.ino ||
      (await fs.realpath(directory)).toLowerCase() !== directory.toLowerCase()) {
    throw new Error("UNSAFE_ACL_DIRECTORY");
  }
  return [stat.dev, stat.ino, stat.ctimeNs].join(":");
}

// The anchor's ancestors are an explicit deployment trust boundary.
function createWindowsPrivateDirectoryVerifier({ trustedRoot } = {}) {
  const anchor = canonicalInput(trustedRoot);
  return async directory => {
    if (process.platform !== "win32" || !anchor) return false;
    const target = canonicalInput(directory);
    if (!target) return false;
    const relative = path.relative(anchor, target);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return false;
    const systemRoot = canonicalInput(process.env.SystemRoot);
    if (!systemRoot) return false;

    const directories = [anchor];
    for (const component of relative.split(path.sep).filter(Boolean)) {
      directories.push(path.join(directories.at(-1), component));
    }
    try {
      const before = await Promise.all(directories.map(readIdentity));
      const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const { stdout } = await run(executable, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(readScript, "utf16le").toString("base64"),
      ], {
        env: { ...process.env, VIDEAPILOT_ACL_READ_PATHS: JSON.stringify(directories) },
        windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024,
      });
      const { user, descriptors } = JSON.parse(stdout);
      if (!Array.isArray(descriptors) || descriptors.length !== directories.length ||
          !descriptors.every(descriptor => isPrivateWindowsDacl(descriptor, user))) return false;
      const after = await Promise.all(directories.map(readIdentity));
      return before.every((value, index) => value === after[index]);
    } catch {
      return false;
    }
  };
}

module.exports = { createWindowsPrivateDirectoryVerifier, isPrivateWindowsDacl };

"use strict";

const http = require("node:http");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const TIMEOUT_MS = 10000;
const MAX_BUFFER = 1024 * 1024;

let diagnosticResult = {
  status: "pending",
  ffmpeg: null,
  ffprobe: null,
  libx264: null
};

async function checkExecutable(name) {
  try {
    await execFileAsync(name, ["-version"], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true
    });

    return true;
  } catch {
    return false;
  }
}

async function runDiagnostic() {
  console.log("=== VIDEAPILOT RENDER FFMPEG DIAGNOSTIC ===");

  const ffmpeg = await checkExecutable("ffmpeg");
  const ffprobe = await checkExecutable("ffprobe");

  let libx264 = false;

  if (ffmpeg) {
    try {
      const { stdout } = await execFileAsync(
        "ffmpeg",
        ["-hide_banner", "-encoders"],
        {
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          windowsHide: true
        }
      );

      libx264 = /^\s*V\S*\s+libx264\s/m.test(stdout);
    } catch {
      libx264 = false;
    }
  }

  diagnosticResult = {
    status: "complete",
    ffmpeg,
    ffprobe,
    libx264
  };

  console.log(
    "FFMPEG :",
    ffmpeg ? "DISPONIBLE" : "INDISPONIBLE"
  );

  console.log(
    "FFPROBE :",
    ffprobe ? "DISPONIBLE" : "INDISPONIBLE"
  );

  console.log(
    "RESULTAT :",
    ffmpeg && ffprobe ? "OK" : "ECHEC"
  );
}

const server = http.createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    });

    response.end(JSON.stringify({
      status: "running"
    }));

    return;
  }

  if (request.url === "/diagnostic") {
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    });

    response.end(JSON.stringify(diagnosticResult));

    return;
  }

  response.writeHead(404, {
    "Content-Type": "application/json"
  });

  response.end(JSON.stringify({
    error: "Not found"
  }));
});

server.listen(PORT, HOST, () => {
  console.log(
    "DIAGNOSTIC_HTTP_LISTENING :",
    PORT
  );

  runDiagnostic().catch((error) => {
    diagnosticResult = {
      status: "error",
      ffmpeg: null,
      ffprobe: null,
      libx264: null
    };

    console.error(
      "DIAGNOSTIC_ERROR :",
      error.message
    );
  });
});
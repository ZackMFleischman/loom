// Shared validator harness — the copy-pasted scaffolding that every
// scripts/validate-*.mjs reimplemented inline, extracted into one module
// (sibling to _browser.mjs). See feature-requests/validator-test-consolidation.md.
//
// Exports:
//   - makeResults()  → { check, results, finish }   (check/results/exit)
//   - waitForServer, toolJson, callOk, waitFor, waitForFps, sleep
//   - avgColor, dist                                  (pixel helpers)
//   - bootStack({ name, port, wsPort, url, consoleUrl, stateMode, viewport,
//                 fakeMedia, mcp })                    (one boot block + teardown)
//
// The isolation contract (own ports, ?embed=0 consoles, state=off unless
// persistence is under test, scene-pin + state backup/restore, catalog regen)
// lives HERE so it can never drift across forks again. bootStack does NOT decide
// state backup/temp-file cleanup beyond the scene pin — a suite that writes state
// passes stateMode:"on" and is responsible for its own content/state snapshot in
// the surrounding script (kept per-suite so persistence assertions stay legible),
// EXCEPT bootStack offers backupState()/restoreState() helpers it can opt into.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { chromium } from "playwright";
import { forceWebGL2, glArgs, resQuery } from "./_browser.mjs";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const ARTIFACTS = join(ROOT, "artifacts");
export const SCENE = join(ROOT, "content", "scenes", "live.scene.ts");
export const STATE_DIR = join(ROOT, "content", "state");
const PULSE_PIN = `export { default } from "./pulse.scene";\n`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The check/results/exit triad. `check(name, ok, detail)` accumulates into the
 * returned `results` array and prints PASS/FAIL; `finish()` prints the summary
 * and exits 1 if any check failed. `tag` prefixes every check name + log line so
 * a grouped (shared-boot) run still names each check's origin suite ([m3] …).
 */
export function makeResults(tag = "") {
  const results = [];
  const prefix = tag ? `[${tag}] ` : "";
  function check(name, ok, detail = "") {
    results.push({ name: `${prefix}${name}`, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${prefix}${name}${detail ? ` — ${detail}` : ""}`);
  }
  function finish() {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length === 0 ? 0 : 1);
  }
  return { results, check, finish };
}

export async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`dev server did not come up at ${url}`);
}

/** Decode an MCP text tool result's JSON payload. */
export function toolJson(res) {
  const text = res.content?.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text);
}

/** Call a tool, throwing on isError (use for tools that must succeed). */
export async function callOk(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name} failed: ${res.content?.[0]?.text}`);
  return res;
}

/** Poll fn until it returns a truthy value (never read once — UI/render races). */
export async function waitFor(fn, timeoutMs = 10_000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Wait for the Output window's #fps meter to report a live framerate. */
export const waitForFps = (page) =>
  page.waitForFunction(
    () => /\d+ fps/.test(document.querySelector("#fps")?.textContent ?? ""),
    null,
    { timeout: 20_000 },
  );

/** Decode an MCP screenshot tool result (base64 image block) and average its RGB. */
export function avgColor(res) {
  const img = res.content?.find((c) => c.type === "image");
  if (!img?.data) throw new Error("screenshot result carried no image data");
  const png = PNG.sync.read(Buffer.from(img.data, "base64"));
  let r = 0,
    g = 0,
    b = 0;
  const n = png.width * png.height;
  for (let i = 0; i < n; i++) {
    r += png.data[i * 4];
    g += png.data[i * 4 + 1];
    b += png.data[i * 4 + 2];
  }
  return { r: r / n, g: g / n, b: b / n };
}

export const dist = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

/** Snapshot every .json under content/state/ for later restore. Returns a Map. */
export function backupState() {
  const stateBackup = new Map();
  if (existsSync(STATE_DIR)) {
    for (const rel of readdirSync(STATE_DIR, { recursive: true })) {
      const file = join(STATE_DIR, String(rel));
      if (file.endsWith(".json")) stateBackup.set(String(rel), readFileSync(file, "utf8"));
    }
  }
  return stateBackup;
}

/** Wipe content/state/ then restore the snapshot taken by backupState(). */
export function restoreState(stateBackup) {
  rmSync(STATE_DIR, { recursive: true, force: true });
  for (const [rel, content] of stateBackup) {
    const file = join(STATE_DIR, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/**
 * Boot the full LOOM stack once: pin live.scene.ts → spawn Vite (--strictPort,
 * racing early exit) → connect the MCP client over stdio → launch headless
 * Chromium with the WebGL2-forcing flags → open the Output page and wait for FPS
 * → wait for the engine↔sidecar handshake. Returns the live pieces plus a single
 * teardown() that closes everything and restores the pinned scene.
 *
 * @param {object} o
 * @param {string} o.name        client name (for logs)
 * @param {number} o.port        Vite port (must be unique per concurrent boot)
 * @param {number} o.wsPort      sidecar WS port (must be unique per concurrent boot)
 * @param {string} [o.url]       full Output URL (defaults to a state=off test-audio URL)
 * @param {string} [o.stateMode] "off" (default) or "on" — only affects the default URL
 * @param {object} [o.viewport]  { width, height } (default 1280×800)
 * @param {boolean} [o.fakeMedia] add fake camera/mic flags (default false)
 * @param {boolean} [o.mcp]      connect the MCP client (default true; m0/m1 pass false)
 * @param {boolean} [o.gotoOutput] open + await the Output page (default true)
 * @param {boolean} [o.waitHandshake] wait for get_session to connect (default = mcp)
 */
export async function bootStack(o) {
  const {
    name,
    port,
    wsPort,
    stateMode = "off",
    viewport = { width: 1280, height: 800 },
    fakeMedia = false,
    mcp = true,
    gotoOutput = true,
  } = o;
  const waitHandshake = o.waitHandshake ?? mcp;
  const stateFrag = stateMode === "on" ? "" : "&state=off";
  const url = o.url ?? `http://localhost:${port}/?audio=test&bpm=120&ws=${wsPort}${stateFrag}${resQuery}`;

  mkdirSync(ARTIFACTS, { recursive: true });
  const originalScene = readFileSync(SCENE, "utf8");
  writeFileSync(SCENE, PULSE_PIN);

  const t0 = Date.now();
  const vite = spawn("pnpm", ["exec", "vite", "--port", String(port), "--strictPort"], {
    cwd: join(ROOT, "packages", "engine-app"),
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  vite.stdout.on("data", (d) => process.stdout.write(`[vite] ${d}`));
  vite.stderr.on("data", (d) => process.stderr.write(`[vite] ${d}`));
  let viteExit = null;
  vite.on("exit", (code) => {
    viteExit = code ?? -1;
  });

  let browser;
  let context;
  let client;
  let output;

  // teardown closes everything and ALWAYS restores the pinned scene. Suites add
  // their own state/temp-file cleanup around this (kept per-suite for legibility).
  const teardown = async () => {
    if (client) await client.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (process.platform === "win32") {
      try {
        execSync(`taskkill /pid ${vite.pid} /T /F`, { stdio: "ignore" });
      } catch {}
    } else {
      vite.kill("SIGTERM");
    }
    writeFileSync(SCENE, originalScene);
  };

  try {
    await Promise.race([
      waitForServer(`http://localhost:${port}/`),
      (async () => {
        while (viteExit === null) await sleep(200);
        throw new Error(`vite exited early (code ${viteExit}) — is port ${port} already in use?`);
      })(),
    ]);

    if (mcp) {
      client = new Client({ name, version: "0.0.0" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "packages/sidecar/src/index.ts"],
        cwd: ROOT,
        env: { ...process.env, LOOM_WS_PORT: String(wsPort) },
        stderr: "pipe",
      });
      await client.connect(transport);
      transport.stderr?.on("data", (d) => process.stderr.write(`[sidecar] ${d}`));
    }

    browser = await chromium.launch({
      headless: true,
      args: [
        ...glArgs,
        "--autoplay-policy=no-user-gesture-required",
        ...(fakeMedia
          ? ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]
          : []),
      ],
    });
    context = await browser.newContext({ viewport });
    await forceWebGL2(context);

    if (gotoOutput) {
      output = await context.newPage();
      await output.goto(url);
      await waitForFps(output);
    }

    if (waitHandshake && client) {
      await waitFor(
        async () => {
          const res = await client.callTool({ name: "get_session", arguments: {} });
          return res.isError ? null : toolJson(res);
        },
        15_000,
        "engine to connect to sidecar",
      );
    }

    const bootMs = Date.now() - t0;
    console.log(`[timing] ${name} boot=${(bootMs / 1000).toFixed(1)}s`);

    return { vite, client, browser, context, output, url, teardown, bootMs };
  } catch (err) {
    await teardown();
    throw err;
  }
}

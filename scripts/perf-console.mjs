// Busy-Console perf harness (console-performance-stability Phase 0).
//
// Boots the engine Output + the React Console (driven by Playwright like a
// human), spawns N instances across heavy scenes, then MEASURES the Console's
// own paint rate (#uifps), scene-picker open latency, the engine-reported
// thumbnail pass time, and a coarse JS heap readout — the before/after evidence
// for the re-render-storm fix (FR-1) and the thumbnail back-pressure (FR-2).
//
// This is a measurement tool, not a pass/fail validator: it prints a JSON block
// you paste into the PR. Run it on `main` (or before a fix) and again after.
//
//   node scripts/perf-console.mjs            # default 10 instances
//   PERF_INSTANCES=12 node scripts/perf-console.mjs
//
// Headless Chromium has no WebGPU adapter, so this exercises the WebGL2 fallback
// (same as the validators). The relative #uifps before/after delta is the
// headline; absolute numbers are machine-dependent.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { glArgs, forceWebGL2, resQuery } from "./_browser.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ARTIFACTS = join(ROOT, "artifacts");
const SCENE = join(ROOT, "content", "scenes", "live.scene.ts");
const PORT = 5400;
const WS_PORT = 7355;
const OUTPUT_URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}&state=off${resQuery}`;
const CONSOLE_URL = `http://localhost:${PORT}/console.html?embed=0`;

const N = Number.parseInt(process.env.PERF_INSTANCES ?? "10", 10);
// A mix of fragment-heavy fractals, a feedback scene, and a 3D world — the
// scenes whose per-instance frameMs is highest, to stress the thumbnail pass.
const HEAVY = ["mandelbloom", "julia", "lava", "neon-bloom", "plasma-wall", "noise-warp", "warp-room", "star-anise"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`dev server did not come up at ${url}`);
}

function toolJson(res) {
  return JSON.parse(res.content?.find((c) => c.type === "text")?.text ?? "{}");
}

/** Sample #uifps repeatedly over `seconds`, returning {min,mean,samples}. */
async function sampleUiFps(page, seconds) {
  const samples = [];
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const v = await page.$eval("#uifps", (el) => Number.parseFloat(el.textContent ?? "0")).catch(() => 0);
    if (v > 0) samples.push(v);
    await sleep(250);
  }
  if (samples.length === 0) return { min: 0, mean: 0, samples: 0 };
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { min: Math.min(...samples), mean: Math.round(mean * 10) / 10, samples: samples.length };
}

/** Open the scene picker, measure click→options-visible latency, close it. p95 over `runs`. */
async function pickerLatency(page, runs) {
  const lat = [];
  for (let i = 0; i < runs; i++) {
    const t0 = Date.now();
    await page.click("#newinstance").catch(() => {});
    await page.waitForSelector(".scenerow", { timeout: 5000 }).catch(() => {});
    lat.push(Date.now() - t0);
    // Close the picker (Escape / click elsewhere) before the next run.
    await page.keyboard.press("Escape").catch(() => {});
    await page.mouse.click(5, 5).catch(() => {});
    await sleep(300);
  }
  lat.sort((a, b) => a - b);
  const p = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] ?? 0;
  return { p50: p(0.5), p95: p(0.95), max: lat[lat.length - 1] ?? 0, runs: lat.length };
}

mkdirSync(ARTIFACTS, { recursive: true });
const originalScene = readFileSync(SCENE, "utf8");
writeFileSync(SCENE, `export { default } from "./pulse.scene";\n`);

const vite = spawn("pnpm", ["exec", "vite", "--port", String(PORT), "--strictPort"], {
  cwd: join(ROOT, "packages", "engine-app"),
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
vite.stderr.on("data", (d) => process.stderr.write(`[vite] ${d}`));
let viteExit = null;
vite.on("exit", (code) => {
  viteExit = code ?? -1;
});

let browser;
let client;
try {
  await Promise.race([
    waitForServer(`http://localhost:${PORT}/`),
    (async () => {
      while (viteExit === null) await sleep(200);
      throw new Error(`vite exited early (code ${viteExit}) — port ${PORT} in use?`);
    })(),
  ]);

  client = new Client({ name: "perf-console", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "packages/sidecar/src/index.ts"],
    cwd: ROOT,
    env: { ...process.env, LOOM_WS_PORT: String(WS_PORT) },
    stderr: "pipe",
  });
  await client.connect(transport);
  transport.stderr?.on("data", (d) => process.stderr.write(`[sidecar] ${d}`));

  browser = await chromium.launch({
    headless: true,
    args: [...glArgs, "--autoplay-policy=no-user-gesture-required"],
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await forceWebGL2(context);
  const output = await context.newPage();
  await output.goto(OUTPUT_URL);
  await output.waitForFunction(() => /\d+ fps/.test(document.querySelector("#fps")?.textContent ?? ""), null, {
    timeout: 20_000,
  });

  // Wait for the engine to register with the sidecar.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    if (!res.isError) break;
    await sleep(250);
  }

  const consolePage = await context.newPage();
  await consolePage.goto(CONSOLE_URL);
  await consolePage.waitForSelector('.tile[data-id="boot"]', { timeout: 10_000 });

  // Spawn N busy instances across heavy scenes.
  const spawned = [];
  for (let i = 0; i < N; i++) {
    const scene = HEAVY[i % HEAVY.length];
    const res = await client.callTool({ name: "create_instance", arguments: { scene } });
    if (!res.isError) spawned.push(toolJson(res).instance);
    await sleep(150);
  }
  // Let the grid mount all tiles and thumbnails start flowing.
  await consolePage.waitForFunction((n) => document.querySelectorAll(".tile").length >= n, N, {
    timeout: 20_000,
  });
  await sleep(4000);

  const tileCount = await consolePage.$$eval(".tile", (els) => els.length);

  // --- MEASURE ---
  // 0. Re-render storm, measured DIRECTLY (FR-1): reset the per-component render
  // counters, let the 10 Hz state + 6.6 Hz thumbs stream run untouched for a
  // fixed window, then read how many times each component re-rendered. This is
  // the headline metric — independent of fps noise (headless WebGL2 renders the
  // heavy scenes cheap, so #uifps barely moves, but the render COUNT is the storm).
  const RENDER_WINDOW_S = 6;
  await consolePage.evaluate(() => {
    window.__perfRenders = {};
  });
  await sleep(RENDER_WINDOW_S * 1000);
  const renders = await consolePage.evaluate(() => window.__perfRenders ?? {});
  const renderReport = {
    windowSec: RENDER_WINDOW_S,
    tileRenders: renders.Tile ?? 0,
    tileRendersPerSec: Math.round(((renders.Tile ?? 0) / RENDER_WINDOW_S) * 10) / 10,
    headerRenders: renders.Header ?? 0,
    paramPanelRenders: renders.ParamPanel ?? 0,
    tileGridRenders: renders.TileGrid ?? 0,
    consoleAppRenders: renders.ConsoleApp ?? 0,
  };

  // 1. Console paint rate while the storm runs (10 Hz state + 6.6 Hz thumbs).
  const uifps = await sampleUiFps(consolePage, 8);
  // 2. Scene-picker open latency under that load.
  const picker = await pickerLatency(consolePage, 8);
  // 3. Engine-side perf + thumb pass timing (from get_session).
  const session = toolJson(await client.callTool({ name: "get_session", arguments: {} }));
  const perf = session.perf ?? {};
  const thumbMs = await output.evaluate(() => window.__loom?.thumbMs ?? null);
  // 4. Coarse heap (Chromium performance.memory, MB).
  const heapMB = await consolePage.evaluate(() => {
    const m = performance.memory;
    return m ? Math.round(m.usedJSHeapSize / 1e5) / 10 : null;
  });
  const worstFrameMs = perf.worstFrameMsRecent ?? null;
  const costliest = (perf.instances ?? []).slice().sort((a, b) => (b.frameMs ?? 0) - (a.frameMs ?? 0))[0];

  const report = {
    instances: tileCount,
    engineFps: Math.round(perf.fps ?? 0),
    clockSource: perf.clockSource ?? "?",
    reRenders: renderReport,
    uiFps: uifps,
    pickerLatencyMs: picker,
    thumbPassMs: thumbMs,
    worstFrameMs,
    costliestInstance: costliest ? { id: costliest.id, frameMs: costliest.frameMs } : null,
    heapMB,
  };
  await consolePage.screenshot({ path: join(ARTIFACTS, "perf-console.png") });
  // Open the PerfOverlay (the 'd' hotkey) and capture it for the PR.
  await consolePage.click("#perfbtn").catch(() => {});
  await consolePage.waitForSelector("#perfoverlay", { timeout: 5000 }).catch(() => {});
  await sleep(1200); // let a heap sample + a thumb pass land in the readout
  await consolePage.screenshot({ path: join(ARTIFACTS, "perf-overlay.png") });
  console.log("\n===== PERF-CONSOLE REPORT =====");
  console.log(JSON.stringify(report, null, 2));
  console.log("===============================\n");
  writeFileSync(join(ARTIFACTS, "perf-console.json"), JSON.stringify(report, null, 2));
} finally {
  writeFileSync(SCENE, originalScene);
  try {
    await client?.close();
  } catch {}
  try {
    await browser?.close();
  } catch {}
  vite.kill();
  // give the dev server a moment to release the port
  await sleep(500);
}

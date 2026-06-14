// Fixtures acceptance check: deterministic input traces. record_fixture
// captures the live rack to content/state/fixtures/<name>.json; a recorded
// trace replays bit-identically (two players over the same trace agree —
// asserted here as two INSTANCES rendering identical pixels); and
// screenshot({frames:[…]}) is deterministic against a fixture: the same
// fixture + frame list returns byte-identical images on every call.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { glArgs, forceWebGL2, resQuery } from "./_browser.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ARTIFACTS = join(ROOT, "artifacts");
const SCENE = join(ROOT, "content", "scenes", "live.scene.ts");
const STATE_DIR = join(ROOT, "content", "state");
const PORT = 5208;
const WS_PORT = 7353;
const OUTPUT_URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}&state=off${resQuery}`;
const FIXTURE = "valtrace";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function waitForServer(url, timeoutMs = 30_000) {
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

function toolJson(res) {
  const text = res.content?.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text);
}

function toolImages(res) {
  return (res.content ?? []).filter((c) => c.type === "image").map((c) => c.data);
}

async function callOk(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name} failed: ${res.content?.[0]?.text}`);
  return res;
}

async function waitFor(fn, timeoutMs = 15_000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const waitForFps = (page) =>
  page.waitForFunction(
    () => /\d+ fps/.test(document.querySelector("#fps")?.textContent ?? ""),
    null,
    { timeout: 20_000 },
  );

// ---- pin the scene, snapshot tuned state (the trace file is written under it) ----
const PULSE_PIN = `export { default } from "./pulse.scene";\n`;
const originalScene = readFileSync(SCENE, "utf8");
writeFileSync(SCENE, PULSE_PIN);

const stateBackup = new Map();
if (existsSync(STATE_DIR)) {
  for (const rel of readdirSync(STATE_DIR, { recursive: true })) {
    const file = join(STATE_DIR, String(rel));
    if (file.endsWith(".json")) stateBackup.set(String(rel), readFileSync(file, "utf8"));
  }
}
mkdirSync(ARTIFACTS, { recursive: true });

const vite = spawn("pnpm", ["exec", "vite", "--port", String(PORT), "--strictPort"], {
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
let client;
try {
  await Promise.race([
    waitForServer(`http://localhost:${PORT}/`),
    (async () => {
      while (viteExit === null) await sleep(200);
      throw new Error(`vite exited early (code ${viteExit}) — is port ${PORT} already in use?`);
    })(),
  ]);

  client = new Client({ name: "validate-fixtures", version: "0.0.0" });
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await forceWebGL2(context);
  const output = await context.newPage();
  await output.goto(OUTPUT_URL);
  await waitForFps(output);
  await waitFor(async () => {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    return res.isError ? null : toolJson(res);
  }, 15_000, "engine to connect to sidecar");

  // 1. Record a trace off the synthetic test audio.
  const rec = toolJson(await callOk(client, "record_fixture", { name: FIXTURE, frames: 90 }));
  check(
    "record_fixture captures the rack (90 frames, named channels, bpm)",
    rec.saved === FIXTURE && rec.frames === 90 && rec.channels.includes("kick") && rec.bpm === 120,
    JSON.stringify({ frames: rec.frames, channels: rec.channels, bpm: rec.bpm }),
  );
  const file = join(STATE_DIR, "fixtures", `${FIXTURE}.json`);
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  check(
    "the trace is plain JSON on disk with one row per frame",
    onDisk.frames.length === 90 && onDisk.frames.every((r) => r.length === onDisk.channels.length),
  );
  check(
    "the recorded test signal actually moved (kick column not flat zero)",
    onDisk.frames.some((r) => r[onDisk.channels.indexOf("kick")] > 0.05),
  );

  // 2. A fixture instance replays the trace instead of the live rack.
  const a = toolJson(await callOk(client, "create_instance", { scene: "pulse", inputs: `fixture:${FIXTURE}` }));
  check("create_instance accepts inputs:fixture:<name>", a.instance.length > 0);
  const info = toolJson(await callOk(client, "get_session", {})).instances.find((i) => i.id === a.instance);
  check("get_session reports the fixture binding", info?.fixture === FIXTURE);

  // 3. screenshot({frames}) is deterministic: same call twice → identical bytes.
  const shotA1 = await callOk(client, "screenshot", { instance: a.instance, frames: [10, 45] });
  const shotA2 = await callOk(client, "screenshot", { instance: a.instance, frames: [10, 45] });
  const [a1f10, a1f45] = toolImages(shotA1);
  const [a2f10, a2f45] = toolImages(shotA2);
  check("same fixture + frame list → byte-identical images (call twice)", a1f10 === a2f10 && a1f45 === a2f45);
  check("different frames show different pixels (sanity)", a1f10 !== a1f45);
  writeFileSync(join(ARTIFACTS, "fixtures-f10.png"), Buffer.from(a1f10, "base64"));
  writeFileSync(join(ARTIFACTS, "fixtures-f45.png"), Buffer.from(a1f45, "base64"));

  // 4. Bit-identical replay across INSTANCES: a second instance over the same
  // trace renders the very same pixels at the same frames.
  const b = toolJson(await callOk(client, "create_instance", { scene: "pulse", inputs: `fixture:${FIXTURE}` }));
  const shotB = await callOk(client, "screenshot", { instance: b.instance, frames: [10, 45] });
  const [b1f10, b1f45] = toolImages(shotB);
  check("a second instance over the same trace replays bit-identically", b1f10 === a1f10 && b1f45 === a1f45);

  // 5. The deterministic pass never disturbs the live loop or the instance.
  const after = toolJson(await callOk(client, "get_session", {})).instances.find((i) => i.id === a.instance);
  check("offline passes leave the instance untouched (builds, status)", after?.builds === 1 && after?.status === "ok");

  // 6. frames on a non-fixture instance errors helpfully.
  const bad = await client.callTool({
    name: "screenshot",
    arguments: { instance: "boot", frames: [5] },
  });
  check(
    "screenshot{frames} on a live-rack instance is refused",
    bad.isError === true && /fixture/.test(bad.content?.[0]?.text ?? ""),
  );

  // 7. Unknown fixtures error at create time.
  const nope = await client.callTool({
    name: "create_instance",
    arguments: { scene: "pulse", inputs: "fixture:doesnotexist" },
  });
  check("unknown fixture names error at create_instance", nope.isError === true);
} catch (err) {
  check("validation run completed", false, String(err));
} finally {
  if (client) await client.close().catch(() => {});
  if (browser) await browser.close();
  if (process.platform === "win32") {
    try { execSync(`taskkill /pid ${vite.pid} /T /F`, { stdio: "ignore" }); } catch {}
  } else {
    vite.kill("SIGTERM");
  }
  writeFileSync(SCENE, originalScene);
  rmSync(join(STATE_DIR, "fixtures"), { recursive: true, force: true });
  for (const [rel, content] of stateBackup) {
    const file = join(STATE_DIR, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

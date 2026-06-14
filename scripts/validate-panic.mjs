// PANIC-modes acceptance check (better panic button): the two-mode emergency
// hatch. A human (driven by Playwright) arms HOLD vs SAFE SCENE and hits PANIC;
// an MCP client observes everything but can never trigger, re-arm, or destroy
// the panic path. Covers: scene-panic cuts to the safe scene within a frame and
// leaves the LIVE pointer unmoved; RESUME hard-cuts back; the engine keeps
// ticking under scene-panic (it's alive, not a freeze); hold→scene escalation;
// and a broken panic.scene.ts degrades PANIC to hold (never worse than today).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { glArgs, forceWebGL2, resQuery } from "./_browser.mjs";
import { PNG } from "pngjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ARTIFACTS = join(ROOT, "artifacts");
const LIVE = join(ROOT, "content", "scenes", "live.scene.ts");
const PANIC = join(ROOT, "content", "scenes", "panic.scene.ts");
const PORT = 5200;
const WS_PORT = 7343;
const OUTPUT_URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}&state=off${resQuery}`;
const CONSOLE_URL = `http://localhost:${PORT}/console.html`;

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
async function callOk(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name} failed: ${res.content?.[0]?.text}`);
  return res;
}
const loomState = (page) => page.evaluate(() => ({ ...window.__loom, instances: window.__loom.instances }));

async function waitFor(fn, timeoutMs = 10_000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Click a Console control until the engine reflects it. MUI re-renders on
 * every 10 Hz state broadcast, so a single Playwright click can land on a
 * node React is about to replace and silently vanish. Re-click ~1 s apart
 * until the predicate holds; every target here is a no-op once the state
 * already matches, and we stop clicking the moment it does.
 */
async function clickUntil(page, selector, pred, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.click(selector).catch(() => {});
    for (let i = 0; i < 8; i++) {
      if (await pred()) return;
      await sleep(120);
    }
  }
  throw new Error(`timed out clicking ${selector} for ${label}`);
}

/** Average RGB of a center crop of a page screenshot. */
async function centerStats(page, savePath) {
  const buf = await page.screenshot(savePath ? { path: savePath } : {});
  const png = PNG.sync.read(buf);
  const cw = 200, chh = 200;
  const x0 = (png.width - cw) >> 1, y0 = (png.height - chh) >> 1;
  let r = 0, g = 0, b = 0;
  for (let y = y0; y < y0 + chh; y++) {
    for (let x = x0; x < x0 + cw; x++) {
      const i = (y * png.width + x) * 4;
      r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2];
    }
  }
  const n = cw * chh;
  return { r: r / n, g: g / n, b: b / n, lum: (r + g + b) / (3 * n) };
}
const rgbDelta = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);

async function waitForFps(page) {
  await page.waitForFunction(
    () => /\d+ fps/.test(document.querySelector("#fps")?.textContent ?? ""),
    null,
    { timeout: 20_000 },
  );
}

mkdirSync(ARTIFACTS, { recursive: true });
const originalLive = readFileSync(LIVE, "utf8");
const originalPanic = readFileSync(PANIC, "utf8");
// Pin a light, deterministic live scene (heavy feedback scenes starve software
// GL); panic stays pointed at the shipped safe scene.
writeFileSync(LIVE, `export { default } from "./pulse.scene";\n`);

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

  client = new Client({ name: "validate-panic", version: "0.0.0" });
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
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  await forceWebGL2(context);
  const output = await context.newPage();
  await output.goto(OUTPUT_URL);
  await waitForFps(output);
  const consolePage = await context.newPage();
  await consolePage.goto(CONSOLE_URL);

  // 1. Session reports the panic surface, warm and healthy (FR-3/FR-10).
  const s0 = await waitFor(async () => {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    return res.isError ? null : toolJson(res);
  }, 15_000, "engine to connect to sidecar");
  check(
    "get_session reports panic state (armed hold, calm, scene ok)",
    s0.panicMode === "hold" && s0.panicActive === null && s0.panicScene.status === "ok",
    `mode=${s0.panicMode} active=${s0.panicActive} scene=${JSON.stringify(s0.panicScene)}`,
  );
  check(
    "warm panic instance is pinned and present (FR-3/FR-11)",
    s0.instances.some((i) => i.id === "panic" && i.pinned === "panic" && i.scene === "safe"),
    s0.instances.map((i) => `${i.id}:${i.pinned ?? "-"}`).join(", "),
  );
  check("default safe scene ships and is named", s0.panicScene.name === "safe", s0.panicScene.name);

  // 2. The Console pins the panic tile with its badge (FR-11).
  await consolePage.waitForSelector('.tile[data-id="panic"] .safe-badge', { timeout: 10_000 });
  check("console shows the default SAFE tile with ⛑ badge", true);

  // 3. The agent can observe but never touch the panic path (FR-10).
  const toolNames = (await client.listTools()).tools.map((t) => t.name);
  check(
    "MCP exposes no panic/arm tools (human-only)",
    !toolNames.includes("panic") && !toolNames.includes("resume") && !toolNames.includes("arm_panic_mode"),
    toolNames.join(", "),
  );
  const destroyPanic = await client.callTool({ name: "destroy_instance", arguments: { instance: "panic" } });
  check(
    "destroying the pinned panic instance is refused",
    destroyPanic.isError === true && /panic/i.test(destroyPanic.content[0].text),
    destroyPanic.content?.[0]?.text,
  );

  // Baseline pixels before any panic.
  const livePixels = await centerStats(output, join(ARTIFACTS, "panic-0-live.png"));

  // 4. SCENE panic: hard-cut to the safe scene, LIVE pointer unmoved, engine
  //    keeps ticking (it's alive, not a freeze) — FR-1/FR-2/FR-4/FR-5.
  await clickUntil(consolePage, "#panicmode-scene", async () => (await loomState(output)).panicMode === "scene", "arm scene");
  await clickUntil(consolePage, "#panic", async () => (await loomState(output)).panicActive === "scene", "scene-panic");
  await sleep(250);
  const st1 = await loomState(output);
  check("scene-panic leaves the LIVE pointer unmoved (FR-4)", st1.live === "boot", `live=${st1.live}`);
  const safeA = await centerStats(output, join(ARTIFACTS, "panic-1-safescene.png"));
  check(
    "scene-panic cuts to safe-scene pixels (FR-1/FR-2)",
    rgbDelta(safeA, livePixels) > 8 && safeA.lum > 1,
    `delta=${rgbDelta(safeA, livePixels).toFixed(1)} lum=${safeA.lum.toFixed(1)}`,
  );
  const frameA = st1.frame;
  await sleep(500);
  const safeB = await centerStats(output);
  const frameB = (await loomState(output)).frame;
  check("engine keeps ticking under scene-panic (FR-5)", frameB > frameA + 10, `frames ${frameA}→${frameB}`);
  check("safe scene renders live, not a freeze-frame", safeB.lum > 1, `lum ${safeB.lum.toFixed(1)}`);

  // 5. RESUME hard-cuts back to the prior live pixels (FR-4).
  await clickUntil(consolePage, "#panic", async () => !(await loomState(output)).panicActive, "resume"); // reads RESUME while panicked
  await sleep(300);
  // The pinned live scene (pulse) flashes with the test audio, so comparing
  // against the pre-panic snapshot is kick-phase luck. The observable FR-4
  // cares about: we LEFT the safe pixels and the live pointer never moved.
  const resumed = await centerStats(output, join(ARTIFACTS, "panic-2-resumed.png"));
  const stResumed = await loomState(output);
  check(
    "RESUME restores the prior live output (FR-4)",
    rgbDelta(resumed, safeA) > 8 && stResumed.live === "boot" && stResumed.panicActive === null,
    `delta to safe=${rgbDelta(resumed, safeA).toFixed(1)} live=${stResumed.live}`,
  );

  // 5b. The SAFE target is any instance, chosen from the Console: spawn a
  //     candidate, designate it, and the ⛑ SAFE marker + routing move to it.
  const safeCand = toolJson(await callOk(client, "create_instance", { scene: "gradient" }));
  const candId = safeCand.instance;
  await consolePage.waitForSelector(`.tile[data-id="${candId}"]`, { timeout: 10_000 });
  await consolePage.selectOption("#panicscene", candId);
  const repointed = await waitFor(async () => {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    if (res.isError) return null;
    const s = toolJson(res);
    const pinned = s.instances.find((i) => i.pinned === "panic");
    return pinned?.id === candId ? s : null;
  }, 10_000, "SAFE designation to move");
  const pinnedNow = repointed.instances.filter((i) => i.pinned === "panic");
  check(
    "picker designates any instance as the SAFE target (moves, exactly one)",
    pinnedNow.length === 1 && pinnedNow[0].id === candId && repointed.panicScene.status === "ok",
    pinnedNow.map((i) => i.id).join(", "),
  );
  // Scene-panic now cuts to the newly designated instance.
  await consolePage.click("#panicmode-scene");
  await consolePage.click("#panic");
  await waitFor(async () => ((await loomState(output)).panicActive === "scene" ? true : null), 5_000, "scene-panic to candidate");
  await sleep(250);
  const gradPixels = await centerStats(output, join(ARTIFACTS, "panic-3-designated.png"));
  check(
    "scene-panic cuts to the designated instance",
    rgbDelta(gradPixels, livePixels) > 8 && gradPixels.lum > 1,
    `delta=${rgbDelta(gradPixels, livePixels).toFixed(1)} lum=${gradPixels.lum.toFixed(1)}`,
  );
  // The designated SAFE target is protected from destroy.
  const destroySafe = await client.callTool({ name: "destroy_instance", arguments: { instance: candId } });
  check("the designated SAFE target is destroy-protected", destroySafe.isError === true && /SAFE/i.test(destroySafe.content[0].text));
  await consolePage.click("#panic"); // RESUME
  await waitFor(async () => (!(await loomState(output)).panicActive ? true : null), 5_000, "resume after re-point");
  // Restore the boot-default SAFE instance for the remaining checks.
  await consolePage.selectOption("#panicscene", "panic");
  await waitFor(async () => {
    const pinned = (await loomState(output)).instances.find((i) => i.pinned === "panic");
    return pinned?.id === "panic" ? true : null;
  }, 10_000, "restore default SAFE");

  // 6. Escalation: HOLD froze garbage → flip arm to SAFE SCENE → cut to safety
  //    (FR-6). Arm hold, panic (frame freezes), then flip the arm live.
  await clickUntil(consolePage, "#panicmode-hold", async () => (await loomState(output)).panicMode === "hold", "arm hold");
  await clickUntil(consolePage, "#panic", async () => (await loomState(output)).panicActive === "hold", "hold-panic");
  // The engine CLOCK keeps ticking under hold by design (worker clock, Console
  // previews) — what freezes is the presented output. Pulse flashes constantly,
  // so static pixels over 600 ms prove the hold.
  const heldA = await centerStats(output);
  await sleep(600);
  const heldB = await centerStats(output);
  check(
    "hold-panic freezes the output pixels",
    rgbDelta(heldA, heldB) < 3,
    `pixel delta over 600ms=${rgbDelta(heldA, heldB).toFixed(1)}`,
  );
  // flip arm while panicked → escalate
  await clickUntil(consolePage, "#panicmode-scene", async () => (await loomState(output)).panicActive === "scene", "escalate to scene");
  const escFrame = (await loomState(output)).frame;
  await sleep(400);
  check("escalation hold→scene resumes ticking (FR-6)", (await loomState(output)).frame > escFrame + 10);
  await clickUntil(consolePage, "#panic", async () => !(await loomState(output)).panicActive, "resume after escalation"); // RESUME
  check("RESUME after escalation releases the hatch", true);

  // 7. Broken panic.scene.ts → PANIC degrades to hold; never worse than today
  //    (FR-7). A build-throwing pointer fails the boot build, so no warm
  //    instance exists and scene-panic falls back to hold.
  writeFileSync(
    PANIC,
    `import { defineScene } from "@loom/runtime";\n` +
      `export default defineScene({\n` +
      `  name: "safe",\n` +
      `  description: "intentionally broken panic scene (validation)",\n` +
      `  build() {\n    throw new Error("panic build boom");\n  },\n` +
      `});\n`,
  );
  await output.goto(OUTPUT_URL); // fresh boot picks up the broken pointer
  await waitForFps(output);
  const broken = await waitFor(async () => {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    if (res.isError) return null;
    const s = toolJson(res);
    return s.panicScene.status === "error" ? s : null;
  }, 15_000, "engine to reboot with a broken panic scene");
  check(
    "broken panic scene reports build-fallback (FR-7)",
    broken.panicScene.status === "error" && /boom/i.test(broken.panicScene.error ?? ""),
    broken.panicScene.error,
  );
  check("no warm panic instance exists when the build fails", !broken.instances.some((i) => i.pinned === "panic"));
  // Arm scene and PANIC: Stage falls back to hold.
  await clickUntil(consolePage, "#panicmode-scene", async () => (await loomState(output)).panicMode === "scene", "arm scene (broken)");
  await clickUntil(consolePage, "#panic", async () => (await loomState(output)).panicActive != null, "panic under broken safe scene");
  const fellBack = (await loomState(output)).panicActive;
  check("PANIC with a broken safe scene degrades to hold (FR-7)", fellBack === "hold", `active=${fellBack}`);
  await consolePage.click("#panic"); // resume
} catch (err) {
  check("validation run completed", false, String(err));
} finally {
  writeFileSync(LIVE, originalLive);
  writeFileSync(PANIC, originalPanic);
  if (client) await client.close().catch(() => {});
  if (browser) await browser.close();
  if (process.platform === "win32") {
    try { execSync(`taskkill /pid ${vite.pid} /T /F`, { stdio: "ignore" }); } catch {}
  } else {
    vite.kill("SIGTERM");
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

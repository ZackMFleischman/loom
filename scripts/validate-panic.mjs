// PANIC-modes acceptance check (panic-safe-scene-redesign): the opt-in emergency
// hatch. There is NO boot-default safe scene — PANIC boots armed HOLD and
// scene-panic is unavailable until the human designates a SAFE target. A human
// (driven by Playwright) drives the PANIC split button (`#panic` primary +
// `#panicmenu` ▾ → `#panic-arm-hold` / `#panic-arm-scene` / `[data-panictarget]`);
// an MCP client observes everything but can never trigger, re-arm, designate, or
// destroy the panic path. Covers: no SAFE target at boot (status "none"); the
// scene arm is disabled until a target is designated; designating any instance
// lights up scene-panic with no rebuild; scene-panic cuts to the designated
// instance within a frame and leaves the LIVE pointer unmoved; RESUME hard-cuts
// back; the engine keeps ticking under scene-panic; hold→scene escalation; the
// designated target is destroy-protected; and a designated target whose scene
// throws on rebuild degrades PANIC to hold (never worse than today).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { glArgs, forceWebGL2, resQuery } from "./_browser.mjs";
import { PNG } from "pngjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ARTIFACTS = join(ROOT, "artifacts");
const LIVE = join(ROOT, "content", "scenes", "live.scene.ts");
// A throwaway scene we designate as the SAFE target, then break on rebuild to
// exercise the broken-target → hold fallback (FR-7). Restored in `finally`.
const SAFE = join(ROOT, "content", "scenes", "panic-canary.scene.ts");
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

/**
 * Open the PANIC ▾ menu and click a menu item until the engine reflects it.
 * The menu closes on each item click, so we re-open it every attempt. A menu
 * item only exists in the DOM while the menu is open, so this both opens and
 * acts. No-op once the predicate already holds.
 */
async function menuClickUntil(page, itemSelector, pred, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.click("#panicmenu").catch(() => {});
    await page.waitForSelector(itemSelector, { state: "visible", timeout: 1500 }).catch(() => {});
    await page.click(itemSelector).catch(() => {});
    for (let i = 0; i < 8; i++) {
      if (await pred()) {
        // Close the menu if it's still open (Escape is a no-op when closed).
        await page.keyboard.press("Escape").catch(() => {});
        return;
      }
      await sleep(120);
    }
  }
  throw new Error(`timed out clicking ${itemSelector} for ${label}`);
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
// Pin a light, deterministic live scene (heavy feedback scenes starve software GL).
writeFileSync(LIVE, `export { default } from "./pulse.scene";\n`);
// A known-good SAFE-target candidate (a calm gradient). Written fresh so the run
// is hermetic; deleted in `finally`.
const SAFE_OK = `import { defineScene, texNode } from "@loom/runtime";
import { mix, uv, vec2, vec3, vec4 } from "three/tsl";

export default defineScene({
  name: "panic-canary",
  description: "validator-only calm gradient designated as a SAFE target.",
  tags: ["panic", "test"],
  build() {
    const d = uv().sub(vec2(0.5)).length().mul(1.6).clamp(0, 1);
    const grad = mix(vec3(0.16, 0.22, 0.42), vec3(0.02, 0.03, 0.07), d);
    return texNode(vec4(grad.mul(0.7), 1));
  },
});
`;
writeFileSync(SAFE, SAFE_OK);

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

  // 1. No boot-default safe scene (FR-1/FR-3): armed hold, calm, scene-panic
  //    reports "none" (not chosen — distinct from "error"), nothing pinned.
  const s0 = await waitFor(async () => {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    return res.isError ? null : toolJson(res);
  }, 15_000, "engine to connect to sidecar");
  check(
    "get_session reports panic state (armed hold, calm, scene-panic 'none')",
    s0.panicMode === "hold" && s0.panicActive === null && s0.panicScene.status === "none",
    `mode=${s0.panicMode} active=${s0.panicActive} scene=${JSON.stringify(s0.panicScene)}`,
  );
  check(
    "no SAFE target is designated at boot (FR-1)",
    !s0.instances.some((i) => i.pinned === "panic") && s0.panicScene.name === "",
    s0.instances.map((i) => `${i.id}:${i.pinned ?? "-"}`).join(", "),
  );

  // 2. No ⛑ SAFE tile until the human opts in (FR-1/FR-4).
  await consolePage.waitForSelector('.tile[data-id="boot"]', { timeout: 10_000 });
  const badgeAtBoot = await consolePage.$(".tile .safe-badge");
  check("console shows NO ⛑ SAFE tile at boot (scene-panic is opt-in)", badgeAtBoot === null);

  // 3. (The agent-can-observe-but-never-touch-panic tool-surface assertion —
  // no panic/resume/arm/designate MCP tools — moved to the shared boot-smoke
  // suite validate-core.mjs, FR-5. The panic suite keeps every behavioral check
  // of the panic path below; only the redundant tool-list moved.)

  // 4. The scene arm is DISABLED until a SAFE target is designated (FR-4/Q4).
  await consolePage.click("#panicmenu");
  await consolePage.waitForSelector("#panic-arm-scene", { state: "visible", timeout: 5_000 });
  const sceneArmDisabledAtBoot = await consolePage.$eval(
    "#panic-arm-scene",
    (el) => el.getAttribute("aria-disabled") === "true" || el.classList.contains("Mui-disabled"),
  );
  check("the SAFE SCENE arm is disabled with no target designated (FR-4)", sceneArmDisabledAtBoot === true);
  await consolePage.keyboard.press("Escape");

  // Baseline pixels before any panic.
  const livePixels = await centerStats(output, join(ARTIFACTS, "panic-0-live.png"));

  // 5. Designate a SAFE target: spawn a candidate (agent may build sandboxes),
  //    then the human picks it from the ▾ menu. The ⛑ marker + routing move to
  //    it with no rebuild; choosing the target also arms scene (one gesture).
  const cand = toolJson(await callOk(client, "create_instance", { scene: "panic-canary" }));
  const candId = cand.instance;
  await consolePage.waitForSelector(`.tile[data-id="${candId}"]`, { timeout: 10_000 });
  const buildsBefore = (await loomState(output)).instances.find((i) => i.id === candId)?.builds ?? -1;
  await menuClickUntil(
    consolePage,
    `[data-panictarget="${candId}"]`,
    async () => {
      const st = await loomState(output);
      return st.instances.find((i) => i.pinned === "panic")?.id === candId && st.panicMode === "scene";
    },
    "designate candidate + arm scene",
  );
  const desig = await waitFor(async () => {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    if (res.isError) return null;
    const s = toolJson(res);
    const pinned = s.instances.filter((i) => i.pinned === "panic");
    return pinned.length === 1 && pinned[0].id === candId ? s : null;
  }, 10_000, "SAFE designation to land");
  const candAfter = desig.instances.find((i) => i.id === candId);
  check(
    "menu picker designates any instance as the SAFE target (moves, exactly one, no rebuild)",
    candAfter?.builds === buildsBefore && desig.panicScene.status === "ok" && desig.panicScene.name === "panic-canary",
    `builds ${buildsBefore}→${candAfter?.builds} status=${desig.panicScene.status}`,
  );
  // The Console now shows the ⛑ SAFE badge on the designated tile.
  await consolePage.waitForSelector(`.tile[data-id="${candId}"] .safe-badge`, { timeout: 10_000 });
  check("console shows the ⛑ SAFE badge on the designated tile", true);

  // 6. SCENE panic: hard-cut to the designated instance, LIVE pointer unmoved,
  //    engine keeps ticking (it's alive, not a freeze) — FR-4/FR-6.
  await clickUntil(consolePage, "#panic", async () => (await loomState(output)).panicActive === "scene", "scene-panic");
  await sleep(250);
  const st1 = await loomState(output);
  check("scene-panic leaves the LIVE pointer unmoved (FR-4)", st1.live === "boot", `live=${st1.live}`);
  const safeA = await centerStats(output, join(ARTIFACTS, "panic-1-safescene.png"));
  check(
    "scene-panic cuts to the designated instance's pixels (FR-4)",
    rgbDelta(safeA, livePixels) > 8 && safeA.lum > 1,
    `delta=${rgbDelta(safeA, livePixels).toFixed(1)} lum=${safeA.lum.toFixed(1)}`,
  );
  const frameA = st1.frame;
  await sleep(500);
  const safeB = await centerStats(output);
  const frameB = (await loomState(output)).frame;
  check("engine keeps ticking under scene-panic (FR-6)", frameB > frameA + 10, `frames ${frameA}→${frameB}`);
  check("safe scene renders live, not a freeze-frame", safeB.lum > 1, `lum ${safeB.lum.toFixed(1)}`);

  // 7. The designated SAFE target is destroy-protected (FR-6).
  const destroySafe = await client.callTool({ name: "destroy_instance", arguments: { instance: candId } });
  check(
    "the designated SAFE target is destroy-protected",
    destroySafe.isError === true && /SAFE/i.test(destroySafe.content[0].text),
    destroySafe.content?.[0]?.text,
  );

  // 8. RESUME hard-cuts back to the prior live output (FR-4).
  await clickUntil(consolePage, "#panic", async () => !(await loomState(output)).panicActive, "resume");
  await sleep(300);
  const resumed = await centerStats(output, join(ARTIFACTS, "panic-2-resumed.png"));
  const stResumed = await loomState(output);
  check(
    "RESUME restores the prior live output (FR-4)",
    rgbDelta(resumed, safeA) > 8 && stResumed.live === "boot" && stResumed.panicActive === null,
    `delta to safe=${rgbDelta(resumed, safeA).toFixed(1)} live=${stResumed.live}`,
  );

  // 9. Escalation: HOLD froze garbage → flip arm to SAFE SCENE → cut to safety
  //    (FR-6). Arm hold, panic (frame freezes), then flip the arm live.
  await menuClickUntil(consolePage, "#panic-arm-hold", async () => (await loomState(output)).panicMode === "hold", "arm hold");
  await clickUntil(consolePage, "#panic", async () => (await loomState(output)).panicActive === "hold", "hold-panic");
  // Pulse flashes constantly, so static pixels over 600 ms prove the hold.
  const heldA = await centerStats(output);
  await sleep(600);
  const heldB = await centerStats(output);
  check(
    "hold-panic freezes the output pixels",
    rgbDelta(heldA, heldB) < 3,
    `pixel delta over 600ms=${rgbDelta(heldA, heldB).toFixed(1)}`,
  );
  // flip arm while panicked → escalate (the target is still designated).
  await menuClickUntil(consolePage, "#panic-arm-scene", async () => (await loomState(output)).panicActive === "scene", "escalate to scene");
  const escFrame = (await loomState(output)).frame;
  await sleep(400);
  check("escalation hold→scene resumes ticking (FR-6)", (await loomState(output)).frame > escFrame + 10);
  await clickUntil(consolePage, "#panic", async () => !(await loomState(output)).panicActive, "resume after escalation");
  check("RESUME after escalation releases the hatch", true);

  // 10. Broken designated target → PANIC degrades to hold; never worse than today
  //     (FR-7). Edit the SAFE scene to throw at RENDER time: the scene-barrel HMR
  //     rebuilds the designated instance (build succeeds), then its first frame
  //     throws and the instance freezes (NFR-2). A frozen designated target makes
  //     scene-panic unavailable (instanceId null) → PANIC falls back to hold.
  writeFileSync(
    SAFE,
    `import { defineScene, Signal, texNode } from "@loom/runtime";\n` +
      `import { vec4 } from "three/tsl";\n` +
      `export default defineScene({\n` +
      `  name: "panic-canary",\n` +
      `  description: "SAFE target that throws at render (validation)",\n` +
      `  build(ctx) {\n` +
      `    // builds fine, but the per-frame updater throws → NFR-2 freeze\n` +
      `    ctx.uniformOf(new Signal(() => { throw new Error("panic render boom"); }));\n` +
      `    return texNode(vec4(0, 0, 0, 1));\n` +
      `  },\n` +
      `});\n`,
  );
  // The scene-barrel HMR rebuilds the designated instance; its first frame
  // throws → it freezes, so panicScene health flips to "error".
  const broken = await waitFor(async () => {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    if (res.isError) return null;
    const s = toolJson(res);
    return s.panicScene.status === "error" ? s : null;
  }, 20_000, "designated SAFE target to freeze on render");
  check(
    "broken designated target reports error health (FR-7)",
    broken.panicScene.status === "error" && /boom/i.test(broken.panicScene.error ?? ""),
    broken.panicScene.error,
  );
  // The scene arm goes disabled (status error → unavailable, FR-7), so we arm
  // via localStorage carry-over from earlier is gone — the engine already holds
  // scene as the armed mode from step 9's escalation. PANIC must hold either way
  // because the designated target is unusable.
  await clickUntil(consolePage, "#panic", async () => (await loomState(output)).panicActive != null, "panic under broken safe scene");
  const fellBack = (await loomState(output)).panicActive;
  check("PANIC with a broken safe target degrades to hold (FR-7)", fellBack === "hold", `active=${fellBack}`);
  await consolePage.click("#panic"); // resume
} catch (err) {
  check("validation run completed", false, String(err));
} finally {
  writeFileSync(LIVE, originalLive);
  try { rmSync(SAFE, { force: true }); } catch {}
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

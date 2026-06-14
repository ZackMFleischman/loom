// M4 acceptance check: Clean stage. The Output is a pure projector surface
// (no overlay; fps hidden unless ?hud=1) rendering at a fixed internal
// resolution scaled with cover (never warped). Audio source selection moved
// to the Console (human-only set_audio; not an MCP tool). Staging is direct:
// drag a tile to the stage strip, stage button toggles to unstage, and the
// /staged page auditions + COMMITs the staged instance from its own tab.
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
const SCENE = join(ROOT, "content", "scenes", "live.scene.ts");
const PORT = 5201;
const WS_PORT = 7344;
// state=off: persisted tunings (M5) must never skew validation assertions.
const OUTPUT_URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}&state=off${resQuery}`;
// embed=0: validator consoles must never spawn an embedded engine (it would dial the default sidecar port).
const CONSOLE_URL = `http://localhost:${PORT}/console.html?embed=0`;
const STAGED_URL = `http://localhost:${PORT}/staged.html`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` â€” ${detail}` : ""}`);
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

const waitForFps = (page) =>
  page.waitForFunction(
    () => /\d+ fps/.test(document.querySelector("#fps")?.textContent ?? ""),
    null,
    { timeout: 20_000 },
  );

/** Mean luminance of a full page screenshot (and save it). */
async function pageLum(page, savePath) {
  const buf = await page.screenshot(savePath ? { path: savePath } : {});
  const png = PNG.sync.read(buf);
  let l = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    l += (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
  }
  return l / (png.width * png.height);
}

mkdirSync(ARTIFACTS, { recursive: true });
const PULSE_PIN = `export { default } from "./pulse.scene";\n`;
const originalScene = readFileSync(SCENE, "utf8");
writeFileSync(SCENE, PULSE_PIN);

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
      throw new Error(`vite exited early (code ${viteExit}) â€” is port ${PORT} already in use?`);
    })(),
  ]);

  client = new Client({ name: "validate-m4", version: "0.0.0" });
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
    args: [
      ...glArgs,
      "--autoplay-policy=no-user-gesture-required",
      // set_audio's mic path needs a (fake) capture device in headless.
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  await forceWebGL2(context);
  const output = await context.newPage();
  await output.goto(OUTPUT_URL);
  await waitForFps(output);

  // 1. Pure output (R9.1): no overlay element; fps populated but invisible.
  const pure = await output.evaluate(() => ({
    status: document.querySelector("#status") !== null,
    fpsVisibility: getComputedStyle(document.querySelector("#fps")).visibility,
    fpsText: document.querySelector("#fps").textContent,
  }));
  check("output has no #status overlay", pure.status === false);
  check(
    "fps readout is hidden yet still ticking",
    pure.fpsVisibility === "hidden" && /\d+ fps/.test(pure.fpsText),
    `visibility=${pure.fpsVisibility} text="${pure.fpsText}"`,
  );

  // 2. Fixed internal resolution + cover scaling (R9.2): the render buffer
  // never follows the window; CSS scales it without warping.
  const at169 = await output.evaluate(() => {
    const c = document.querySelector("#out");
    return { w: c.width, h: c.height, fit: getComputedStyle(c).objectFit };
  });
  check(
    "render buffer is fixed 1920x1080 with object-fit: cover",
    at169.w === 1920 && at169.h === 1080 && at169.fit === "cover",
    `${at169.w}x${at169.h} fit=${at169.fit}`,
  );
  await output.setViewportSize({ width: 960, height: 720 });
  await sleep(300);
  const at43 = await output.evaluate(() => {
    const c = document.querySelector("#out");
    const r = c.getBoundingClientRect();
    return { w: c.width, h: c.height, cw: Math.round(r.width), ch: Math.round(r.height) };
  });
  const lum43 = await pageLum(output, join(ARTIFACTS, "m4-1-cover-43.png"));
  check(
    "non-16:9 window: buffer unchanged, canvas fills, pixels alive",
    at43.w === 1920 && at43.h === 1080 && at43.cw === 960 && at43.ch === 720 && lum43 > 1,
    `buffer ${at43.w}x${at43.h} client ${at43.cw}x${at43.ch} lum ${lum43.toFixed(1)}`,
  );
  await output.setViewportSize({ width: 960, height: 540 });

  // 3. Engine reaches the sidecar. (The canonical MCP tool-surface assertion —
  // including the deliberate absence of the human-only set_audio — moved to the
  // shared boot-smoke suite validate-core.mjs, FR-5.)
  await waitFor(async () => {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    return res.isError ? null : toolJson(res);
  }, 15_000, "engine to connect to sidecar");

  // 4. Audio source picker in the Console drives set_audio (human path).
  const consolePage = await context.newPage();
  await consolePage.goto(CONSOLE_URL);
  await consolePage.waitForSelector('.tile[data-id="boot"]', { timeout: 10_000 });
  // state: "attached" â€” <option>s in a closed <select> are never "visible".
  await consolePage.waitForSelector('#audiomode option[value^="mic:"]', { timeout: 10_000, state: "attached" });
  const micOption = await consolePage.$eval('#audiomode option[value^="mic:"]', (o) => o.value);
  await consolePage.selectOption("#audiomode", micOption);
  await waitFor(async () => ((await loomState(output)).audioMode === "mic" ? true : null), 10_000, "mic mode");
  check("console picker switches audio to mic", true);
  await consolePage.selectOption("#audiomode", "test");
  await waitFor(async () => ((await loomState(output)).audioMode === "test" ? true : null), 10_000, "test mode");
  check("console picker switches audio back to test", true);

  // 5. Drag a tile onto the stage bar: drop = stage + commit (R9.3 redesign).
  // The grid runs on dnd-kit (pointer-driven, 8px activation slop), so drive
  // a real pointer drag from the tile's center to the stage strip's.
  const created = toolJson(await callOk(client, "create_instance", { scene: "lava" }));
  const cid = created.instance;
  const tileLoc = consolePage.locator(`.tile[data-id="${cid}"]`);
  await tileLoc.waitFor({ timeout: 10_000 });
  await tileLoc.scrollIntoViewIfNeeded();
  const tileBox = await tileLoc.boundingBox();
  const stripBox = await consolePage.locator("#stagestrip").boundingBox();
  await consolePage.mouse.move(tileBox.x + tileBox.width / 2, tileBox.y + tileBox.height / 2);
  await consolePage.mouse.down();
  await consolePage.mouse.move(
    stripBox.x + stripBox.width / 2,
    stripBox.y + stripBox.height / 2,
    { steps: 12 },
  );
  await consolePage.mouse.up();
  await waitFor(async () => {
    const s = await loomState(output);
    return s.live === cid && s.staged === null && s.mix === null ? true : null;
  }, 10_000, "drag to go live");
  check("drag onto the stage bar stages and commits", true);

  // 6. The staged tile's stage button reads "unstage" and unstages. The
  // Console refreshes at ~10 Hz — poll the DOM for the toggle instead of
  // reading it once (the single read raced the render and flaked).
  await callOk(client, "stage", { instance: "boot" });
  await waitFor(async () => ((await loomState(output)).staged === "boot" ? true : null), 5_000, "boot staged");
  await consolePage.waitForFunction(
    () => document.querySelector('.tile[data-id="boot"] .stagebtn')?.textContent === "unstage",
    null,
    { timeout: 5_000 },
  );
  check('staged tile button toggles to "unstage"', true);
  await consolePage.click('.tile[data-id="boot"] .stagebtn');
  await waitFor(async () => ((await loomState(output)).staged === null ? true : null), 5_000, "unstage");
  check("tile unstage button clears the staged slot", true);

  // 7. /staged page: empty state, live preview of the staged instance, COMMIT.
  const stagedPage = await context.newPage();
  await stagedPage.goto(STAGED_URL);
  await waitFor(
    () => stagedPage.evaluate(() => document.body.classList.contains("disconnected") ? null : true),
    10_000,
    "staged page to find the engine",
  );
  const emptyVisible = await stagedPage.$eval("#empty", (el) => getComputedStyle(el).display !== "none");
  check("staged page shows the empty state when nothing is staged", emptyVisible);
  // cid went LIVE in step 5, so boot is the candidate now.
  await callOk(client, "stage", { instance: "boot" });
  await waitFor(
    () => stagedPage.$eval("#stagedname", (el) => el.textContent.includes("boot") || null).catch(() => null),
    10_000,
    "staged name",
  );
  const previewSrc = await waitFor(
    () => stagedPage.$eval("#preview", (img) => (img.src.startsWith("data:image/") ? img.src : null)).catch(() => null),
    10_000,
    "staged preview pixels",
  );
  await stagedPage.screenshot({ path: join(ARTIFACTS, "m4-2-staged.png") });
  check("staged page streams the staged instance's preview", previewSrc.startsWith("data:image/"), previewSrc.slice(0, 30));
  await stagedPage.click("#commit");
  const midMix = await waitFor(async () => {
    const s = await loomState(output);
    return s.mix != null && s.mix > 0 ? s.mix : null;
  }, 5_000, "crossfade from staged page");
  await waitFor(async () => {
    const s = await loomState(output);
    return s.live === "boot" && s.staged === null && s.mix === null ? true : null;
  }, 10_000, "fade to finish and promote");
  check("staged page COMMIT crossfades to LIVE", true, `mid mix=${midMix.toFixed(2)}`);

  // 8. /staged unstage button.
  await callOk(client, "stage", { instance: cid });
  await waitFor(
    () => stagedPage.$eval("#stagedname", (el) => el.textContent.includes("lava") || null).catch(() => null),
    10_000,
    "lava staged",
  );
  await stagedPage.click("#unstage");
  await waitFor(async () => ((await loomState(output)).staged === null ? true : null), 5_000, "staged page unstage");
  check("staged page unstage clears the staged slot", true);

  // 9. ?hud=1 reveals diagnostics; ?res= overrides the internal resolution.
  await output.goto(`${OUTPUT_URL}&hud=1&res=640x360`);
  await waitForFps(output);
  const hud = await output.evaluate(() => ({
    vis: getComputedStyle(document.querySelector("#fps")).visibility,
    w: document.querySelector("#out").width,
    h: document.querySelector("#out").height,
  }));
  check(
    "?hud=1 shows fps and ?res= overrides internal resolution",
    hud.vis === "visible" && hud.w === 640 && hud.h === 360,
    `visibility=${hud.vis} buffer ${hud.w}x${hud.h}`,
  );
} catch (err) {
  check("validation run completed", false, String(err));
} finally {
  writeFileSync(SCENE, originalScene);
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

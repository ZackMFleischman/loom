// M3 acceptance check: Stage & Console. An MCP client creates and stages a
// candidate; the Console (driven by Playwright like a human) auditions it,
// drags a slider, COMMITs (crossfade never goes black), and PANICs. The
// agent cannot touch LIVE unless commit is armed (?agentCommit=1 proves the
// override).
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
const PORT = 5200;
const WS_PORT = 7343;
// state=off: persisted tunings (M5) must never skew validation assertions.
const OUTPUT_URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}&state=off${resQuery}`;
// embed=0: validator consoles must never spawn an embedded engine (it would dial the default sidecar port).
const CONSOLE_URL = `http://localhost:${PORT}/console.html?embed=0`;

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

  client = new Client({ name: "validate-m3", version: "0.0.0" });
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
    ],
  });
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  await forceWebGL2(context);
  const output = await context.newPage();
  await output.goto(OUTPUT_URL);
  await output.waitForFunction(
    () => /\d+ fps/.test(document.querySelector("#fps")?.textContent ?? ""),
    null,
    { timeout: 20_000 },
  );
  const consolePage = await context.newPage();
  await consolePage.goto(CONSOLE_URL);

  // 1. Tools + session shape.
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  check(
    "MCP exposes the M3 tools (+ modulators, chains, projects)",
    [
        "clear_modulation", "commit", "create_instance", "destroy_instance", "get_manifest",
        "get_session", "list_projects", "load_project", "modulate_param", "record_fixture", "save_chain",
        "save_project", "screenshot", "set_chain", "set_modulation_enabled", "set_param", "stage", "unstage",
      ].every((t) => tools.includes(t)) && !tools.includes("set_audio"),
    tools.join(", "),
  );
  const session0 = await waitFor(async () => {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    return res.isError ? null : toolJson(res);
  }, 15_000, "engine to connect to sidecar");
  check("session: boot instance is live", session0.live === "boot" && session0.scene === "pulse",
    `live=${session0.live} scene=${session0.scene}`);
  check(
    "session: catalog scenes available",
    ["gradient", "lava", "pulse"].every((s) => session0.availableScenes.includes(s)),
    session0.availableScenes.join(", "),
  );

  // 2. Console sees the engine: boot tile present.
  await consolePage.waitForSelector('.tile[data-id="boot"]', { timeout: 10_000 });
  check("console shows the live tile", true);
  const liveBadge = await consolePage.$eval('.tile[data-id="boot"] .live-badge', (el) => el.className);
  check("LIVE badge on the boot tile", liveBadge.includes("show"));

  // Decode a tile's thumbnail in-browser and return its average luminance.
  const tileThumbLum = (id) =>
    consolePage.evaluate(async (tileId) => {
      const img = document.querySelector(`.tile[data-id="${CSS.escape(tileId)}"] img`);
      if (!img?.src?.startsWith("data:image")) return null;
      const bmp = await createImageBitmap(await (await fetch(img.src)).blob());
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let l = 0;
      for (let i = 0; i < d.length; i += 4) l += (d[i] + d[i + 1] + d[i + 2]) / 3;
      return l / (c.width * c.height);
    }, id);

  // The LIVE tile's preview must show real pixels (regression: the canvas is
  // only readable in the render task â€” a stale-task read shows black).
  const liveLum = await waitFor(async () => {
    const l = await tileThumbLum("boot");
    return l != null && l > 2 ? l : null;
  }, 10_000, "live tile thumbnail to be non-black");
  check("LIVE tile thumbnail shows real pixels", true, `lum ${liveLum.toFixed(1)}`);

  // 3. Agent creates a sandbox candidate.
  const created = toolJson(await callOk(client, "create_instance", { scene: "lava" }));
  check(
    "create_instance returns id + params",
    created.scene === "lava" && created.paramPaths.includes("size"),
    JSON.stringify(created),
  );
  const cid = created.instance;
  await consolePage.waitForSelector(`.tile[data-id="${cid}"]`, { timeout: 10_000 });
  check("candidate tile appears in the console", true);
  const thumb = await waitFor(
    () => consolePage.$eval(`.tile[data-id="${cid}"] img`, (img) => img.src || null).catch(() => null),
    10_000,
    "candidate thumbnail",
  );
  check("candidate thumbnail streams", thumb.startsWith("data:image/"), thumb.slice(0, 30));

  // 4. Agent eyes on the candidate (offscreen target, not the live canvas).
  const shotRes = await callOk(client, "screenshot", { instance: cid });
  const img = shotRes.content.find((c) => c.type === "image");
  const shotPng = PNG.sync.read(Buffer.from(img.data, "base64"));
  let lum = 0;
  for (let i = 0; i < shotPng.data.length; i += 4) {
    lum += (shotPng.data[i] + shotPng.data[i + 1] + shotPng.data[i + 2]) / 3;
  }
  lum /= shotPng.width * shotPng.height;
  writeFileSync(join(ARTIFACTS, "m3-1-candidate.png"), PNG.sync.write(shotPng));
  check("candidate screenshot renders (non-black)", lum > 1, `lum ${lum.toFixed(2)} @ ${shotPng.width}x${shotPng.height}`);

  // 5. Param panel drives the candidate.
  await consolePage.click(`.tile[data-id="${cid}"]`);
  // The param input is MUI Slider's hidden <input type="range"> â€” attached
  // but not "visible" to Playwright, and React dedupes direct .value writes
  // through its value tracker, so write through the prototype setter.
  await consolePage.waitForSelector('[data-path="size"]', { state: "attached", timeout: 5_000 });
  await consolePage.$eval('[data-path="size"]', (el) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(el, "0.25");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // Range inputs snap to their step grid, so compare with tolerance.
  const sizeVal = await waitFor(async () => {
    const m = toolJson(await callOk(client, "get_manifest", { instance: cid }));
    return Math.abs(m.params.size.value - 0.25) < 0.01 ? m.params.size.value : null;
  }, 5_000, "slider write to land");
  check("console slider writes through to the manifest", sizeVal !== null, `size=${sizeVal}`);

  // 6. Stage via MCP; commit defaults ARMED for agents (redesign) but the
  // gate still works when the human disarms it.
  const staged = toolJson(await callOk(client, "stage", { instance: cid }));
  check("agent staged the candidate", staged.staged === cid && staged.live === "boot");
  await waitFor(
    () => consolePage.$(`.tile[data-id="${cid}"] .staged-badge.show`).then((h) => (h ? true : null)),
    5_000,
    "STAGED badge",
  );
  check("STAGED badge in the console", true);
  const sessionArmed = toolJson(await callOk(client, "get_session"));
  check("agent commit is armed by default", sessionArmed.agentCommitArmed === true);
  await consolePage.click("#armagent"); // human disarms from the console
  await waitFor(async () => {
    const s = toolJson(await callOk(client, "get_session"));
    return s.agentCommitArmed ? null : true;
  }, 5_000, "console checkbox to disarm");
  const blockedCommit = await client.callTool({ name: "commit", arguments: {} });
  check(
    "agent commit is blocked when disarmed",
    blockedCommit.isError === true && /armed/i.test(blockedCommit.content[0].text),
    blockedCommit.content?.[0]?.text,
  );
  let st = await loomState(output);
  check("LIVE untouched by blocked commit", st.live === "boot" && st.staged === cid);

  // 7. Human COMMIT: crossfade, never black, live pointer swaps.
  await consolePage.screenshot({ path: join(ARTIFACTS, "m3-2-console.png") });
  await consolePage.click("#commit");
  const midFade = await waitFor(async () => {
    const s = await loomState(output);
    return s.mix != null && s.mix > 0 ? s.mix : null;
  }, 5_000, "crossfade to start");
  const midStats = await centerStats(output, join(ARTIFACTS, "m3-3-midfade.png"));
  check("mid-fade frame is alive (not black)", midStats.lum > 1, `mix=${midFade.toFixed(2)} lum=${midStats.lum.toFixed(1)}`);
  await waitFor(async () => {
    const s = await loomState(output);
    return s.live === cid && s.staged === null && s.mix === null ? true : null;
  }, 10_000, "fade to finish and promote");
  check("COMMIT promoted the candidate to LIVE", true);
  st = await loomState(output);
  check("live scene is now lava", st.sceneName === "lava", `scene=${st.sceneName}`);
  const newLiveLum = await waitFor(async () => {
    const l = await tileThumbLum(cid);
    return l != null && l > 1 ? l : null;
  }, 10_000, "promoted tile thumbnail to be non-black");
  check("promoted LIVE tile thumbnail stays real", true, `lum ${newLiveLum.toFixed(1)}`);

  // 8. PANIC: pixels freeze, engine keeps ticking, RESUME recovers.
  await consolePage.click("#panic");
  await waitFor(async () => ((await loomState(output)).panicked ? true : null), 5_000, "panic");
  await sleep(300); // let the held frame settle
  const frameA = (await loomState(output)).frame;
  const holdA = await centerStats(output, join(ARTIFACTS, "m3-4-panic.png"));
  await sleep(500);
  const holdB = await centerStats(output);
  const frameB = (await loomState(output)).frame;
  const drift = Math.abs(holdA.r - holdB.r) + Math.abs(holdA.g - holdB.g) + Math.abs(holdA.b - holdB.b);
  check("PANIC holds the output pixels", drift < 1.5, `rgb drift ${drift.toFixed(2)} over 500 ms`);
  check("engine loop keeps ticking under PANIC", frameB > frameA + 10, `frames ${frameA}â†’${frameB}`);
  await consolePage.click("#panic"); // now reads RESUME
  await waitFor(async () => (!(await loomState(output)).panicked ? true : null), 5_000, "resume");
  check("RESUME releases the hold", true);

  // 9. Old live instance is destroyable now (and the LIVE one is protected).
  const protectedRes = await client.callTool({ name: "destroy_instance", arguments: { instance: cid } });
  check(
    "destroying the LIVE instance is refused",
    protectedRes.isError === true && /LIVE/i.test(protectedRes.content[0].text),
    protectedRes.content?.[0]?.text,
  );
  await callOk(client, "destroy_instance", { instance: "boot" });
  await waitFor(
    () => consolePage.$('.tile[data-id="boot"]').then((h) => (h ? null : true)),
    5_000,
    "old tile to disappear",
  );
  check("destroyed instance's tile disappears", true);

  // 9b. The human can spawn library scenes from the Console (R4.5 â€” works
  // with the agent absent): the "+" ghost tile opens the scene picker,
  // clicking a scene row creates the instance.
  await consolePage.click("#newinstance");
  await consolePage.click('.scenerow[data-scene="pulse"]');
  await consolePage.waitForSelector('.tile[data-id^="pulse-"]', { timeout: 10_000 });
  const pickedSession = toolJson(await callOk(client, "get_session"));
  check(
    "console scene picker creates an instance",
    pickedSession.instances.some((i) => i.id.startsWith("pulse-") && i.scene === "pulse"),
    pickedSession.instances.map((i) => i.id).join(", "),
  );

  // 9c. screenshot_console: the agent's eyes on the COCKPIT UI (console-screenshot).
  // The Console self-captures its own DOM (SVG-foreignObject) and replies over the
  // reverse envelope; assert a non-blank PNG with plausible dims, and gross
  // agreement with Playwright's OWN screenshot of the same Console.
  const lumOfPng = (png) => {
    let l = 0;
    for (let i = 0; i < png.data.length; i += 4) l += (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
    return l / (png.width * png.height);
  };
  const consoleShotRes = await callOk(client, "screenshot_console", { maxWidth: 800 });
  const consoleImg = consoleShotRes.content.find((c) => c.type === "image");
  const consoleMeta = JSON.parse(consoleShotRes.content.find((c) => c.type === "text")?.text ?? "{}");
  check(
    "screenshot_console returns a PNG with a consoleId and plausible dims",
    consoleImg != null &&
      typeof consoleMeta.consoleId === "string" &&
      consoleMeta.width > 0 &&
      consoleMeta.width <= 800 &&
      consoleMeta.height > 0,
    JSON.stringify(consoleMeta),
  );
  const consolePng = PNG.sync.read(Buffer.from(consoleImg.data, "base64"));
  writeFileSync(join(ARTIFACTS, "m3-5-console-capture.png"), PNG.sync.write(consolePng));
  const selfLum = lumOfPng(consolePng);
  check("screenshot_console PNG is non-blank (cockpit pixels)", selfLum > 2, `lum ${selfLum.toFixed(1)}`);

  // Playwright's own screenshot of the SAME Console page — gross agreement: both
  // show the populated cockpit (non-black), with closely matching aspect ratios.
  const pwBuf = await consolePage.screenshot({ path: join(ARTIFACTS, "m3-5-console-playwright.png") });
  const pwPng = PNG.sync.read(pwBuf);
  const pwLum = lumOfPng(pwPng);
  const selfAspect = consolePng.width / consolePng.height;
  const pwAspect = pwPng.width / pwPng.height;
  check(
    "screenshot_console grossly agrees with Playwright's own capture (both alive, matching aspect)",
    selfLum > 2 && pwLum > 2 && Math.abs(selfAspect - pwAspect) < 0.2,
    `self lum=${selfLum.toFixed(1)} aspect=${selfAspect.toFixed(2)} · pw lum=${pwLum.toFixed(1)} aspect=${pwAspect.toFixed(2)}`,
  );

  // 9d. No Console connected → the clean structured error (FR-3). Close the
  // Console page and let its presence beacon lapse (>5s), then the tool errors.
  await consolePage.close();
  // The engine's presence window (~5s) must lapse before it reports the Console
  // gone; until then a request to the just-closed page reads as "console did not
  // answer" (also a clean structured error, never a hang). Wait specifically for
  // the no-Console message.
  const noConsole = await waitFor(
    async () => {
      const res = await client.callTool({ name: "screenshot_console", arguments: {} });
      const text = res.content?.[0]?.text ?? "";
      return res.isError && /no Console connected/i.test(text) ? res : null;
    },
    15_000,
    "screenshot_console to report no Console once the presence window lapses",
  );
  check(
    "screenshot_console errors cleanly with no Console connected",
    /no Console connected/i.test(noConsole.content?.[0]?.text ?? ""),
    noConsole.content?.[0]?.text,
  );

  // 10. ?agentCommit=0 restores the human gate (boot override)...
  await output.goto(`${OUTPUT_URL}&agentCommit=0`);
  await output.waitForFunction(
    () => /\d+ fps/.test(document.querySelector("#fps")?.textContent ?? ""),
    null,
    { timeout: 20_000 },
  );
  const session1 = await waitFor(async () => {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    if (res.isError) return null;
    const s = toolJson(res);
    return s.agentCommitArmed === false ? s : null;
  }, 15_000, "disarmed engine to reconnect");
  check("?agentCommit=0 disarms agent commit", session1.agentCommitArmed === false);
  const c2 = toolJson(await callOk(client, "create_instance", { scene: "lava" }));
  await callOk(client, "stage", { instance: c2.instance });
  const blocked2 = await client.callTool({ name: "commit", arguments: {} });
  check(
    "agent commit is blocked under ?agentCommit=0",
    blocked2.isError === true && /armed/i.test(blocked2.content[0].text),
    blocked2.content?.[0]?.text,
  );

  // ...and a plain boot is armed end-to-end: create â†’ stage â†’ agent commit lands.
  await output.goto(OUTPUT_URL);
  await output.waitForFunction(
    () => /\d+ fps/.test(document.querySelector("#fps")?.textContent ?? ""),
    null,
    { timeout: 20_000 },
  );
  const session2 = await waitFor(async () => {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    if (res.isError) return null;
    const s = toolJson(res);
    return s.agentCommitArmed === true ? s : null;
  }, 15_000, "default-armed engine to reconnect");
  check("plain boot arms agent commit by default", session2.agentCommitArmed === true);
  const c3 = toolJson(await callOk(client, "create_instance", { scene: "lava" }));
  await callOk(client, "stage", { instance: c3.instance });
  await callOk(client, "commit", { durationFrames: 10 });
  await waitFor(async () => {
    const s = await loomState(output);
    return s.live === c3.instance ? true : null;
  }, 10_000, "default-armed agent commit to land");
  check("default-armed agent commit crossfades to LIVE", true);
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

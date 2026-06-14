// M4 acceptance check: Clean stage. The Output is a pure projector surface
// (no overlay; fps hidden unless ?hud=1) rendering at a fixed internal
// resolution scaled with cover (never warped). Audio source selection moved
// to the Console (human-only set_audio; not an MCP tool). Staging is direct:
// drag a tile to the stage strip, stage button toggles to unstage, and the
// /staged page auditions + COMMITs the staged instance from its own tab.
import {
  ARTIFACTS,
  bootStack,
  makeResults,
  sleep,
  toolJson,
  callOk,
  waitFor,
  waitForFps,
} from "./_harness.mjs";
import { join } from "node:path";
import { PNG } from "pngjs";

const PORT = 5201;
const WS_PORT = 7344;
// state=off: persisted tunings (M5) must never skew validation assertions.
const OUTPUT_URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}&state=off`;
// embed=0: validator consoles must never spawn an embedded engine (it would dial the default sidecar port).
const CONSOLE_URL = `http://localhost:${PORT}/console.html?embed=0`;
const STAGED_URL = `http://localhost:${PORT}/staged.html`;

const { results, check } = makeResults();
const loomState = (page) => page.evaluate(() => ({ ...window.__loom, instances: window.__loom.instances }));

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

const T_START = Date.now();
let tChecks = T_START;
let teardown = async () => {};
try {
  const boot = await bootStack({
    name: "validate-m4",
    port: PORT,
    wsPort: WS_PORT,
    url: OUTPUT_URL,
    viewport: { width: 960, height: 540 },
    fakeMedia: true, // set_audio's mic path needs a (fake) capture device in headless
  });
  teardown = boot.teardown;
  const { client, context, output } = boot;
  tChecks = Date.now();

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
  console.log(
    `[timing] m4 boot=${((tChecks - T_START) / 1000).toFixed(1)}s checks=${((Date.now() - tChecks) / 1000).toFixed(1)}s`,
  );
  await teardown();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

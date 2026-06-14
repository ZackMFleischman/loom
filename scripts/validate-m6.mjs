// M6 acceptance check (palette half): the global color palettes. Two named
// 5-stop palettes live on the "globals" pseudo-instance (palette.primary.0 …),
// scenes consume them via ctx.palette (color stops / ramp gradient / own
// defaults) with a per-frame palette.source switch that never rebuilds,
// edits retint consumers within a frame, the Console exposes color swatches +
// a stage-strip source selector, and tunings persist to palettes.json. Runs
// with state persistence ON — content/state/ is snapshotted and restored.
import { join } from "node:path";
import {
  ROOT,
  ARTIFACTS,
  bootStack,
  makeResults,
  sleep,
  toolJson,
  callOk,
  waitFor,
  waitForFps,
  avgColor,
  dist,
  backupState,
  restoreState,
} from "./_harness.mjs";
import { rmSync } from "node:fs";

const TMP_CHAIN = join(ROOT, "content", "modules", "effects", "chains", "validatorTmp.chain.json");
const PORT = 5203;
const WS_PORT = 7346;
// State persistence stays ON here (no state=off) — palette persistence is under test.
const OUTPUT_URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}`;
// embed=0: validator consoles must never spawn an embedded engine (it would dial the default sidecar port).
const CONSOLE_URL = `http://localhost:${PORT}/console.html?embed=0`;

const { results, check } = makeResults();

// Palette persistence is under test → snapshot content/state/ and run pristine.
const stateBackup = backupState();
restoreState(new Map());

const T_START = Date.now();
let tChecks = T_START;
let teardown = async () => {};
let booted;
try {
  booted = await bootStack({
    name: "validate-m6",
    port: PORT,
    wsPort: WS_PORT,
    url: OUTPUT_URL,
    stateMode: "on",
    fakeMedia: true,
  });
  teardown = booted.teardown;
  const { client, context, output } = booted;
  tChecks = Date.now();

  // 1. Globals manifest carries both palettes as color params.
  const globals = toolJson(await callOk(client, "get_manifest", { instance: "globals" }));
  const stopPaths = ["primary", "secondary"].flatMap((s) =>
    [0, 1, 2, 3, 4].map((i) => `palette.${s}.${i}`),
  );
  check(
    "globals manifest lists 10 color stops",
    stopPaths.every((p) => globals.params[p]?.type === "color"),
  );

  // 2. A ramp consumer + a stops consumer, built in sandboxes.
  const grad = toolJson(await callOk(client, "create_instance", { scene: "gradient" }));
  const lava = toolJson(await callOk(client, "create_instance", { scene: "lava" }));
  check("gradient auto-declares palette.source", grad.paramPaths.includes("palette.source"));
  await sleep(500); // let the new instances render at least one frame to their preview targets
  const gradBefore = avgColor(await callOk(client, "screenshot", { instance: grad.instance }));
  await output.screenshot({ path: join(ARTIFACTS, "m6-2-grad-primary.png") }).catch(() => {});

  // 3. Globals palette edit retints the consumer (R7 / shipped-when: "within a
  //    frame" — asserted as: the FIRST screenshot after the set_param ack differs).
  for (const i of [0, 1, 2, 3, 4]) {
    await callOk(client, "set_param", {
      instance: "globals",
      path: `palette.primary.${i}`,
      value: "#ff0000",
    });
  }
  // The retint reaches the GPU within a frame, but the preview render + async
  // pixel readback need a tick to flush — poll the screenshot until it lands.
  const gradRed = await waitFor(async () => {
    const c = avgColor(await callOk(client, "screenshot", { instance: grad.instance }));
    return dist(gradBefore, c) > 25 ? c : null;
  }, 5_000, "ramp consumer to retint").catch(async () =>
    avgColor(await callOk(client, "screenshot", { instance: grad.instance })),
  );
  check(
    "globals palette edit retints the ramp consumer",
    dist(gradBefore, gradRed) > 25,
    `Δ=${dist(gradBefore, gradRed).toFixed(1)}`,
  );
  check("retinted ramp is red-dominant", gradRed.r > gradRed.g + 40 && gradRed.r > gradRed.b + 40);

  // 4. No rebuild: builds counter untouched by retint + source flips.
  const buildsOf = async (id) =>
    toolJson(await callOk(client, "get_session", {})).instances.find((x) => x.id === id)?.builds;
  check("retint caused no rebuild", (await buildsOf(grad.instance)) === 1);
  await callOk(client, "set_param", { instance: grad.instance, path: "palette.source", value: 1 });
  const gradSecondary = await waitFor(async () => {
    const c = avgColor(await callOk(client, "screenshot", { instance: grad.instance }));
    return dist(gradRed, c) > 25 ? c : null;
  }, 5_000, "source flip to repaint").catch(async () =>
    avgColor(await callOk(client, "screenshot", { instance: grad.instance })),
  );
  check("flipping palette.source changes pixels", dist(gradRed, gradSecondary) > 25);
  check("source flip caused no rebuild", (await buildsOf(grad.instance)) === 1);

  // 5. own(): lava defaults to its authored stops and can flip away and back.
  const lavaManifest = toolJson(await callOk(client, "get_manifest", { instance: lava.instance }));
  check(
    "own() scene defaults palette.source to own",
    lavaManifest.params["palette.source"]?.value === 2,
  );

  // 6. Format-validating clamp: garbage is rejected, value untouched.
  const bad = await client.callTool({
    name: "set_param",
    arguments: { instance: "globals", path: "palette.primary.0", value: "#nope" },
  });
  check("invalid color value is rejected", bad.isError === true);

  // 7. Modulators: a cycle modulator CAN ride palette.source (an int).
  const cyc = await client.callTool({
    name: "modulate_param",
    arguments: {
      instance: grad.instance,
      path: "palette.source",
      modulator: { type: "cycle", periodBeats: 4, values: [0, 1] },
    },
  });
  check("cycle modulator CAN ride palette.source (int)", cyc.isError !== true);
  await callOk(client, "clear_modulation", { instance: grad.instance, path: "palette.source" });

  // 8. Console: rack drawer shows color inputs; editing one writes through.
  const consolePage = await context.newPage();
  await consolePage.goto(CONSOLE_URL);
  await consolePage.waitForSelector('.tile[data-id="boot"]', { timeout: 10_000 });
  await consolePage.keyboard.press("i");
  await consolePage.waitForSelector('#palettes input[type="color"][data-path="palette.primary.0"]', {
    timeout: 10_000,
  });
  await consolePage.evaluate(() => {
    const el = document.querySelector('input[data-path="palette.primary.0"]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(el, "#00ff00");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitFor(async () => {
    const g = toolJson(await callOk(client, "get_manifest", { instance: "globals" }));
    return g.params["palette.primary.0"].value === "#00ff00" ? true : null;
  }, 5_000, "swatch edit to land");
  check("Console swatch edits write through to globals", true);
  await consolePage.screenshot({ path: join(ARTIFACTS, "m6-1-palettes-drawer.png") });

  // 9. Param-drawer source selector (R7.2) — palette.source renders flat
  // (never buried in an accordion) as a labeled toggle group.
  await callOk(client, "stage", { instance: grad.instance });
  await consolePage.click(`.tile[data-id="${grad.instance}"]`);
  await consolePage.waitForSelector('#widgets [data-path="palette.source"]', { timeout: 10_000 });
  await consolePage.click('#widgets [data-path="palette.source"] button:has-text("own")');
  await waitFor(async () => {
    const m = toolJson(await callOk(client, "get_manifest", { instance: grad.instance }));
    return m.params["palette.source"].value === 2 ? true : null;
  }, 5_000, "selector click to land");
  check("param-drawer selector flips palette.source", true);
  await consolePage.screenshot({ path: join(ARTIFACTS, "m6-3-source-selector.png") });

  // ---- chain half (M6): per-instance post-effect chains ----

  // 11. The library exposes chainable effects (code primitives + the saved composite).
  const session1 = toolJson(await callOk(client, "get_session", {}));
  const effNames = new Set(session1.availableEffects.map((e) => e.name));
  check(
    "availableEffects lists primitives + a saved composite",
    ["glitch", "feedback", "levels", "bloomTrails"].every((n) => effNames.has(n)),
    [...effNames].join(", "),
  );
  check(
    "bloomTrails is reported as a composite",
    session1.availableEffects.find((e) => e.name === "bloomTrails")?.kind === "composite",
  );

  // 12. set_chain appends glitch → fx.glitch-1.* appears and the preview changes.
  const fx = toolJson(await callOk(client, "create_instance", { scene: "gradient" }));
  await sleep(400);
  const fxBase = avgColor(await callOk(client, "screenshot", { instance: fx.instance }));
  await callOk(client, "set_chain", {
    instance: fx.instance,
    steps: [{ effect: "glitch", params: { amount: 1, burst: 1 } }],
  });
  const fxManifest = toolJson(await callOk(client, "get_manifest", { instance: fx.instance }));
  check(
    "set_chain glitch exposes fx.glitch-1.amount + fx.glitch-1.mix",
    fxManifest.params["fx.glitch-1.amount"]?.type === "float" &&
      fxManifest.params["fx.glitch-1.mix"]?.type === "float",
  );
  const fxChain = toolJson(await callOk(client, "get_session", {})).instances.find(
    (x) => x.id === fx.instance,
  ).chain;
  check("get_session reports the chain step", fxChain[0]?.effect === "glitch" && fxChain[0]?.id === "glitch-1");
  const afterGlitch = await waitFor(async () => {
    const c = avgColor(await callOk(client, "screenshot", { instance: fx.instance }));
    return dist(fxBase, c) > 8 ? c : null;
  }, 5_000, "glitch to change the preview").catch(async () =>
    avgColor(await callOk(client, "screenshot", { instance: fx.instance })),
  );
  check("appending glitch visibly changes the preview", dist(fxBase, afterGlitch) > 8, `Δ=${dist(fxBase, afterGlitch).toFixed(1)}`);

  // 13. Wet/dry mix is a live param: mix=0 bypasses to the input, no rebuild.
  const buildsAfterAppend = await buildsOf(fx.instance);
  await callOk(client, "set_param", { instance: fx.instance, path: "fx.glitch-1.mix", value: 0 });
  const bypassed = await waitFor(async () => {
    const c = avgColor(await callOk(client, "screenshot", { instance: fx.instance }));
    return dist(fxBase, c) < 8 ? c : null;
  }, 5_000, "mix=0 to bypass back to source").catch(async () =>
    avgColor(await callOk(client, "screenshot", { instance: fx.instance })),
  );
  check("fx.<id>.mix=0 bypasses to the source pixels", dist(fxBase, bypassed) < 8, `Δ=${dist(fxBase, bypassed).toFixed(1)}`);
  check("riding the mix caused no rebuild", (await buildsOf(fx.instance)) === buildsAfterAppend);

  // 14. Reorder preserves knob positions (stable fx.<id> across the rebuild).
  await callOk(client, "set_chain", {
    instance: fx.instance,
    steps: [{ id: "glitch-1", effect: "glitch" }, { effect: "levels" }],
  });
  await callOk(client, "set_param", { instance: fx.instance, path: "fx.glitch-1.amount", value: 0.13 });
  const levelsId = toolJson(await callOk(client, "get_session", {})).instances
    .find((x) => x.id === fx.instance)
    .chain.find((s) => s.effect === "levels").id;
  await callOk(client, "set_chain", {
    instance: fx.instance,
    steps: [{ id: levelsId, effect: "levels" }, { id: "glitch-1", effect: "glitch" }],
  });
  const reordered = toolJson(await callOk(client, "get_manifest", { instance: fx.instance }));
  check(
    "reorder preserves the glitch knob value",
    Math.abs(reordered.params["fx.glitch-1.amount"].value - 0.13) < 1e-6,
    `amount=${reordered.params["fx.glitch-1.amount"].value}`,
  );

  // 15. A composite step folds its inner primitives under fx.<id>.<inner>.<param>.
  await callOk(client, "set_chain", { instance: fx.instance, steps: [{ effect: "bloomTrails" }] });
  const compId = toolJson(await callOk(client, "get_session", {})).instances
    .find((x) => x.id === fx.instance)
    .chain.find((s) => s.effect === "bloomTrails").id;
  const comp = toolJson(await callOk(client, "get_manifest", { instance: fx.instance }));
  check(
    "composite step namespaces inner params",
    comp.params[`fx.${compId}.feedback-1.amount`]?.type === "float" &&
      comp.params[`fx.${compId}.mix`]?.type === "float",
    Object.keys(comp.params).filter((p) => p.startsWith("fx.")).join(", "),
  );

  // 16. save_chain writes a reusable composite that the library then offers.
  await callOk(client, "set_chain", {
    instance: fx.instance,
    steps: [{ effect: "glitch", params: { amount: 0.7 } }, { effect: "levels" }],
  });
  await callOk(client, "save_chain", { instance: fx.instance, name: "validatorTmp" });
  const grew = await waitFor(async () => {
    const s = toolJson(await callOk(client, "get_session", {}));
    return s.availableEffects.some((e) => e.name === "validatorTmp" && e.kind === "composite") ? true : null;
  }, 6_000, "saved chain to appear in the library").catch(() => false);
  check("save_chain registers a new composite effect", grew === true);

  // 17. restoreDefault resets to the scene's declared chain (gradient: none).
  await callOk(client, "set_chain", { instance: fx.instance, restoreDefault: true });
  const restored = toolJson(await callOk(client, "get_session", {})).instances.find(
    (x) => x.id === fx.instance,
  ).chain;
  check("restoreDefault clears a chain with no scene default", restored.length === 0);

  // 10. Persistence: palettes.json round-trips a reload (state is ON in this run).
  await output.reload();
  await waitForFps(output);
  await waitFor(async () => {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    return res.isError ? null : toolJson(res);
  }, 15_000, "engine to reconnect after reload");
  const reloaded = toolJson(await callOk(client, "get_manifest", { instance: "globals" }));
  check(
    "palette tunings survive a reload",
    reloaded.params["palette.primary.0"].value === "#00ff00",
    `primary.0=${reloaded.params["palette.primary.0"].value}`,
  );
} catch (err) {
  check("validation run completed", false, String(err));
} finally {
  console.log(
    `[timing] m6 boot=${((tChecks - T_START) / 1000).toFixed(1)}s checks=${((Date.now() - tChecks) / 1000).toFixed(1)}s`,
  );
  // teardown() closes the engine page + sidecar + vite and restores the pinned
  // scene BEFORE we restore state (a live page could flush a late debounced save).
  await teardown();
  rmSync(TMP_CHAIN, { force: true }); // the save_chain test artifact
  restoreState(stateBackup);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

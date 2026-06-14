// Projects acceptance check: save -> mutate the session -> load restores
// instances, values, modulators, root + per-node chains and tile order with
// LIVE untouched throughout (no commit, no live rebuild); the replaced
// instances cull after a commit from the loaded set lands; projects survive a
// restart; agents list/load via MCP and agent SAVE is arming-gated; the
// Console has a load switcher + save dialog. State persistence is ON here —
// content/state/ is snapshotted and restored.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ARTIFACTS,
  STATE_DIR,
  bootStack,
  makeResults,
  sleep,
  toolJson,
  callOk,
  waitFor,
  waitForFps,
  backupState,
  restoreState,
} from "./_harness.mjs";

const PORT = 5206;
const WS_PORT = 7351;
const OUTPUT_URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}`;
const CONSOLE_URL = `http://localhost:${PORT}/console.html?embed=0`;
const PROJECT = "setlist01";

const { results, check } = makeResults();

// State persistence is under test → snapshot content/state/ and run pristine.
const stateBackup = backupState();
restoreState(new Map());

const T_START = Date.now();
let tChecks = T_START;
let teardown = async () => {};
try {
  const boot = await bootStack({
    name: "validate-projects",
    port: PORT,
    wsPort: WS_PORT,
    url: OUTPUT_URL,
    stateMode: "on",
  });
  teardown = boot.teardown;
  const { client, context, output } = boot;
  tChecks = Date.now();
  const session = async () => toolJson(await callOk(client, "get_session", {}));
  await waitFor(async () => {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    return res.isError ? null : toolJson(res);
  }, 15_000, "engine to connect to sidecar");

  // ---- build a set worth saving ----
  const grad = toolJson(await callOk(client, "create_instance", { scene: "gradient" })).instance;
  const vz = toolJson(await callOk(client, "create_instance", { scene: "vinyl-zoom" })).instance;
  await callOk(client, "set_param", { instance: grad, path: "speed", value: 0.4 });
  await callOk(client, "modulate_param", {
    instance: grad,
    path: "palette.source",
    modulator: { type: "cycle", periodBeats: 8, values: [0, 1] },
  });
  await callOk(client, "set_chain", {
    instance: grad,
    steps: [{ effect: "glitch", params: { amount: 0.77 } }],
  });
  await callOk(client, "set_chain", {
    instance: vz,
    node: "logo",
    steps: [{ effect: "pixelate", params: { amount: 0.5 } }],
  });
  await callOk(client, "set_param", { instance: vz, path: "logo.layer.scale", value: 0.6 });

  // ---- save (agent commit is armed by default in this engine boot) ----
  const saved = toolJson(
    await callOk(client, "save_project", { name: PROJECT, tileOrder: [vz, grad, "boot"] }),
  );
  check("save_project writes the set", saved.saved === PROJECT && saved.instances === 3, JSON.stringify(saved));
  const listed = toolJson(await callOk(client, "list_projects", {}));
  check("list_projects reports it", listed.projects.includes(PROJECT), listed.projects.join(", "));
  check(
    "project file exists on disk",
    existsSync(join(STATE_DIR, "projects", `${PROJECT}.json`)),
  );

  // ---- mutate the session ----
  await callOk(client, "destroy_instance", { instance: grad });
  await callOk(client, "set_param", { instance: vz, path: "logo.layer.scale", value: 2 });

  const before = await session();
  const liveBuilds = before.instances.find((i) => i.id === before.live)?.builds;

  // ---- load: audience-safe restore ----
  const loaded = toolJson(await callOk(client, "load_project", { name: PROJECT }));
  check(
    "load creates all three instances (ids suffixed where taken)",
    loaded.created.length === 3 && loaded.skipped.length === 0,
    JSON.stringify(loaded),
  );
  const after = await session();
  check("LIVE untouched by the load (same id, no commit)", after.live === before.live && after.staged === null);
  check(
    "LIVE instance never rebuilt during the load",
    after.instances.find((i) => i.id === after.live)?.builds === liveBuilds,
  );

  const [vz2, grad2] = loaded.created; // tile order: vz first, then grad, then boot copy
  check("created ids follow saved tile order (vz first)", vz2.startsWith("vinyl-zoom") && grad2.startsWith("gradient"));
  const order = after.instances.map((i) => i.id);
  check(
    "session order preserves saved tile order for the loaded set",
    order.indexOf(vz2) < order.indexOf(grad2) && order.indexOf(grad2) < order.indexOf(loaded.created[2]),
    order.join(" · "),
  );

  // values / modulators / chains restored
  const gm = toolJson(await callOk(client, "get_manifest", { instance: grad2 }));
  check("per-instance value restored over scene default", Math.abs(gm.params.speed.value - 0.4) < 1e-6, `speed=${gm.params.speed.value}`);
  const gradInfo = after.instances.find((i) => i.id === grad2);
  check(
    "modulator restored (cycle on palette.source)",
    gradInfo?.modulators.some((m) => m.path === "palette.source" && m.type === "cycle" && m.error == null),
    JSON.stringify(gradInfo?.modulators),
  );
  const glitchStep = gradInfo?.chain[0];
  check("root chain restored", glitchStep?.effect === "glitch", JSON.stringify(gradInfo?.chain));
  check(
    "root chain knob value restored",
    Math.abs(gm.params[`fx.${glitchStep?.id}.amount`]?.value - 0.77) < 1e-6,
  );
  const vm = toolJson(await callOk(client, "get_manifest", { instance: vz2 }));
  const vzInfo = after.instances.find((i) => i.id === vz2);
  const logoChain = vzInfo?.nodes.find((n) => n.id === "logo")?.chain ?? [];
  check("per-node chain restored on the logo node", logoChain[0]?.effect === "pixelate", JSON.stringify(vzInfo?.nodes));
  check(
    "node chain knob + rig value restored",
    Math.abs(vm.params[`logo.fx.${logoChain[0]?.id}.amount`]?.value - 0.5) < 1e-6 &&
      Math.abs(vm.params["logo.layer.scale"].value - 0.6) < 1e-6,
  );

  // ---- replaced instances cull after a commit from the loaded set ----
  const preCull = (await session()).instances.map((i) => i.id);
  check("pre-load instances still running before the commit", preCull.includes(vz) && preCull.includes("boot"));
  await callOk(client, "stage", { instance: vz2 });
  await callOk(client, "commit", { durationFrames: 10 });
  const culled = await waitFor(async () => {
    const s = await session();
    const ids = s.instances.map((i) => i.id);
    return s.live === vz2 && !ids.includes(vz) && !ids.includes("boot") ? s : null;
  }, 15_000, "replaced instances to cull after the commit lands");
  check("commit from the loaded set culls the replaced instances", true, culled.instances.map((i) => i.id).join(" · "));
  check(
    "the warm panic instance survives the cull",
    culled.instances.some((i) => i.pinned === "panic"),
  );

  // ---- restart: projects survive ----
  await output.reload();
  await waitForFps(output);
  await waitFor(async () => {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    return res.isError ? null : toolJson(res);
  }, 15_000, "engine to reconnect after reload");
  const relisted = toolJson(await callOk(client, "list_projects", {}));
  check("projects survive a restart", relisted.projects.includes(PROJECT));
  const reload2 = toolJson(await callOk(client, "load_project", { name: PROJECT }));
  check("load still works after restart", reload2.created.length === 3, JSON.stringify(reload2.created));

  // ---- agent save is arming-gated ----
  await output.goto(`${OUTPUT_URL}&agentCommit=0`);
  await waitForFps(output);
  await waitFor(async () => {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    if (res.isError) return null;
    return toolJson(res).agentCommitArmed === false ? true : null;
  }, 15_000, "disarmed engine to reconnect");
  const gatedSave = await client.callTool({ name: "save_project", arguments: { name: "blocked" } });
  check(
    "agent save_project is arming-gated",
    gatedSave.isError === true && /not armed/.test(gatedSave.content?.[0]?.text ?? ""),
  );
  const ungatedLoad = await client.callTool({ name: "load_project", arguments: { name: PROJECT } });
  check("agent load_project stays ungated (audience-safe)", ungatedLoad.isError !== true);

  // ---- Console: switcher + human save dialog (ungated) ----
  const consolePage = await context.newPage();
  await consolePage.goto(CONSOLE_URL);
  await consolePage.waitForSelector("#projects", { timeout: 10_000 });
  const options = await consolePage.$$eval("#projects option", (os) => os.map((o) => o.value));
  check("Console switcher lists the saved project", options.includes(PROJECT), options.join(", "));
  await consolePage.click("#projsave");
  await consolePage.fill("#projname", "humansave");
  await consolePage.click("#projsaveok");
  const humanSaved = await waitFor(async () => {
    const l = toolJson(await callOk(client, "list_projects", {}));
    return l.projects.includes("humansave") ? true : null;
  }, 10_000, "human save to land").catch(() => false);
  check("Console save dialog saves ungated (human trust tier)", humanSaved === true);
  await consolePage.screenshot({ path: join(ARTIFACTS, "projects-console.png") });
} catch (err) {
  check("validation run completed", false, String(err));
} finally {
  console.log(
    `[timing] projects boot=${((tChecks - T_START) / 1000).toFixed(1)}s checks=${((Date.now() - tChecks) / 1000).toFixed(1)}s`,
  );
  // teardown() kills the engine + restores the pinned scene BEFORE we restore
  // state (a still-alive page can flush a late debounced save after the restore).
  await teardown();
  restoreState(stateBackup);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

// M5 acceptance check: the input rack. Named channels (content/inputs.ts)
// are tunable on the "globals" pseudo-instance manifest, metered in the
// Console rack drawer, consumed late-bound by scenes (retune never rebuilds),
// persisted via the loom:state middleware, and bindable to (mocked) MIDI CCs
// through learn. Runs with state persistence ON â€” content/state/ is
// snapshotted and restored around the run.
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
const INPUTS = join(ROOT, "content", "inputs.ts");
const STATE_DIR = join(ROOT, "content", "state");
const PORT = 5202;
const WS_PORT = 7345;
// State persistence stays ON here (no state=off) â€” it's under test.
const OUTPUT_URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}${resQuery}`;
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

/** Sample window.__loom.inputs[name] on the output page for windowMs. */
async function sampleChannel(page, name, windowMs, stepMs = 80) {
  const samples = [];
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    samples.push(await page.evaluate((n) => window.__loom?.inputs?.[n] ?? 0, name));
    await sleep(stepMs);
  }
  return samples;
}

// ---- pin the scene, snapshot tuned state, keep originals for restore ----
const PULSE_PIN = `export { default } from "./pulse.scene";\n`;
const originalScene = readFileSync(SCENE, "utf8");
const originalInputs = readFileSync(INPUTS, "utf8");
writeFileSync(SCENE, PULSE_PIN);

const stateBackup = new Map();
if (existsSync(STATE_DIR)) {
  for (const rel of readdirSync(STATE_DIR, { recursive: true })) {
    const file = join(STATE_DIR, String(rel));
    if (file.endsWith(".json")) stateBackup.set(String(rel), readFileSync(file, "utf8"));
  }
}
rmSync(STATE_DIR, { recursive: true, force: true }); // pristine state for the run
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
      throw new Error(`vite exited early (code ${viteExit}) â€” is port ${PORT} already in use?`);
    })(),
  ]);

  client = new Client({ name: "validate-m5", version: "0.0.0" });
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
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await forceWebGL2(context);
  const output = await context.newPage();
  const consoleMsgs = [];
  output.on("console", (m) => consoleMsgs.push(m.text()));
  await output.goto(OUTPUT_URL);
  await waitForFps(output);
  await waitFor(async () => {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    return res.isError ? null : toolJson(res);
  }, 15_000, "engine to connect to sidecar");

  // 1. The globals pseudo-instance serves the rack's manifest over MCP.
  const globals = toolJson(await callOk(client, "get_manifest", { instance: "globals" }));
  const gp = globals.params ?? {};
  check(
    "get_manifest{globals} lists inputs.kick.* tunings",
    globals.instance === "globals" &&
      gp["inputs.kick.threshold"]?.value === 0.22 &&
      gp["inputs.kick.decay"]?.value === 0.22 &&
      gp["inputs.kick.enabled"]?.value === true &&
      gp["inputs.bass.gain"] != null &&
      gp["inputs.knob1.gain"] != null,
    Object.keys(gp).slice(0, 6).join(", ") + ", â€¦",
  );

  // 2. Channels are computed every frame with no consumers required: the
  // session snapshot meters move with the test audio.
  const session0 = toolJson(await callOk(client, "get_session", {}));
  const kickSamples = await sampleChannel(output, "kick", 3000);
  const bassSamples = await sampleChannel(output, "bass", 800);
  check(
    "snapshot exposes all rack channels",
    ["kick", "hats", "bass", "energy", "knob1"].every((n) => n in (session0.inputs ?? {})),
    Object.keys(session0.inputs ?? {}).join(", "),
  );
  check(
    "kick channel meters move with test audio",
    Math.max(...kickSamples) > 0.5 && Math.min(...kickSamples) < Math.max(...kickSamples),
    `kick max=${Math.max(...kickSamples).toFixed(2)} min=${Math.min(...kickSamples).toFixed(2)}`,
  );
  check(
    "bass level channel reads energy",
    Math.max(...bassSamples) > 0.02,
    `bass max=${Math.max(...bassSamples).toFixed(3)}`,
  );

  // 3. The Console rack drawer: "i" opens it; rows carry meters + widgets.
  const consolePage = await context.newPage();
  await consolePage.goto(CONSOLE_URL);
  await consolePage.waitForSelector('.tile[data-id="boot"]', { timeout: 10_000 });
  await consolePage.keyboard.press("i");
  await consolePage.waitForSelector('.rackrow[data-name="kick"]', { timeout: 10_000 });
  const hasWidget =
    (await consolePage.$('.rackrow[data-name="kick"] [data-path="inputs.kick.threshold"]')) != null;
  check("rack drawer opens on 'i' with a kick row and tuning widgets", hasWidget);
  const widths = [];
  for (let i = 0; i < 5; i++) {
    widths.push(
      await consolePage.$eval('.rackrow[data-name="kick"] .rackfill', (el) => el.style.width),
    );
    await sleep(220);
  }
  check("rack kick meter animates", new Set(widths).size > 1, widths.join(" "));
  await consolePage.screenshot({ path: join(ARTIFACTS, "m5-1-rack.png") });

  // 4. Late binding: retuning the global threshold silences the consuming
  // scene's channel without any instance rebuild.
  const bootManifest = toolJson(await callOk(client, "get_manifest", { instance: "boot" }));
  check(
    "consuming scene auto-declares input trims",
    bootManifest.params["input.kick.amount"] != null && bootManifest.params["input.bass.amount"] != null,
    Object.keys(bootManifest.params).join(", "),
  );
  const msgMark = consoleMsgs.length;
  // threshold proves the knob writes through; gain 0 (envelope peak) is what
  // makes the silence deterministic â€” the synthetic kick occasionally grazes
  // any threshold < 1 and a single onset mid-window flaked this check.
  await callOk(client, "set_param", { instance: "globals", path: "inputs.kick.threshold", value: 0.95 });
  await callOk(client, "set_param", { instance: "globals", path: "inputs.kick.gain", value: 0 });
  await sleep(1500); // let the envelope drain
  const deadSamples = await sampleChannel(output, "kick", 2500);
  check(
    "retuned kick (threshold 0.95, gain 0) silences the consuming scene",
    Math.max(...deadSamples) < 0.05,
    `max=${Math.max(...deadSamples).toFixed(4)}`,
  );
  await callOk(client, "set_param", { instance: "globals", path: "inputs.kick.threshold", value: 0.22 });
  await callOk(client, "set_param", { instance: "globals", path: "inputs.kick.gain", value: 1 });
  const recovered = await sampleChannel(output, "kick", 3000);
  check(
    "restoring the tunings recovers onsets",
    Math.max(...recovered) > 0.5,
    `max=${Math.max(...recovered).toFixed(2)}`,
  );
  check(
    "retuning rebuilt no instance (late-bound consumption)",
    !consoleMsgs.slice(msgMark).some((m) => m.includes("rebuilt")),
  );

  // 5. MIDI-learn: arm from the Console, twist a mocked CC, binding drives
  // the param through the same write path as set_param.
  await consolePage.click('.tile[data-id="boot"]');
  await consolePage.waitForSelector('#widgets [data-learn="punch"]', { timeout: 10_000 });
  await consolePage.click('#widgets [data-learn="punch"]');
  await waitFor(async () => {
    const s = toolJson(await callOk(client, "get_session", {}));
    return s.midi?.learning?.path === "punch" ? s.midi.learning : null;
  }, 5_000, "learn to arm");
  check("learn arms for pulse.punch (scene-keyed)", true);
  await output.evaluate(() => window.__loom.midiInject(21, 0, 0.75));
  const afterLearn = await waitFor(async () => {
    const s = toolJson(await callOk(client, "get_session", {}));
    return s.bindings?.some((b) => b.cc === 21 && b.scene === "pulse" && b.path === "punch") ? s : null;
  }, 5_000, "binding to land");
  check("mocked CC 21 binds via learn", afterLearn.midi.learning === null);
  const punchAt75 = toolJson(await callOk(client, "get_manifest", { instance: "boot" })).params.punch.value;
  await output.evaluate(() => window.__loom.midiInject(21, 0, 1));
  const punchAtMax = await waitFor(async () => {
    const v = toolJson(await callOk(client, "get_manifest", { instance: "boot" })).params.punch.value;
    return v === 3 ? v : null;
  }, 5_000, "bound CC to move punch to max");
  check(
    "bound CC rides punch across its range",
    Math.abs(punchAt75 - 2.25) < 1e-6 && punchAtMax === 3,
    `0.75â†’${punchAt75}, 1.0â†’${punchAtMax}`,
  );
  await waitFor(async () => {
    const learnBtn = await consolePage.$eval('#widgets [data-learn="punch"]', (b) => b.textContent);
    return learnBtn === "cc21" ? true : null;
  }, 5_000, "console to show the binding");
  check("console widget shows the cc21 binding", true);
  await consolePage.screenshot({ path: join(ARTIFACTS, "m5-2-midi-learn.png") });

  // 6. CC channels: the same mocked knob meters in the rack.
  await output.evaluate(() => window.__loom.midiInject(21, 0, 0.6));
  const knob1 = await waitFor(async () => {
    const v = await output.evaluate(() => window.__loom.inputs.knob1);
    return Math.abs(v - 0.6) < 1e-6 ? v : null;
  }, 5_000, "knob1 channel to track the CC");
  check("cc channel knob1 tracks injected CC", knob1 === 0.6);

  // 7. Persistence: tunings, per-scene values, and bindings round-trip a
  // full page reload through content/state/*.json.
  await callOk(client, "set_param", { instance: "globals", path: "inputs.kick.threshold", value: 0.7 });
  await callOk(client, "set_param", { instance: "boot", path: "punch", value: 2.5 });
  await waitFor(
    () => (existsSync(join(STATE_DIR, "inputs.json")) &&
      existsSync(join(STATE_DIR, "values", "pulse.json")) &&
      existsSync(join(STATE_DIR, "bindings.json"))) || null,
    10_000,
    "state files to be written",
  );
  await sleep(600); // let the last debounced write land
  const inputsJson = JSON.parse(readFileSync(join(STATE_DIR, "inputs.json"), "utf8"));
  const valuesJson = JSON.parse(readFileSync(join(STATE_DIR, "values", "pulse.json"), "utf8"));
  const bindingsJson = JSON.parse(readFileSync(join(STATE_DIR, "bindings.json"), "utf8"));
  check(
    "state files carry the tuned values",
    inputsJson["inputs.kick.threshold"] === 0.7 &&
      valuesJson.punch === 2.5 &&
      bindingsJson.some((b) => b.cc === 21 && b.scene === "pulse" && b.path === "punch"),
    `threshold=${inputsJson["inputs.kick.threshold"]} punch=${valuesJson.punch} bindings=${bindingsJson.length}`,
  );
  await output.reload();
  await waitForFps(output);
  const reloaded = await waitFor(async () => {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    return res.isError ? null : toolJson(res);
  }, 15_000, "engine to reconnect after reload");
  const globals2 = toolJson(await callOk(client, "get_manifest", { instance: "globals" }));
  const boot2 = toolJson(await callOk(client, "get_manifest", { instance: "boot" }));
  check(
    "tunings round-trip a reload",
    globals2.params["inputs.kick.threshold"].value === 0.7,
    `threshold=${globals2.params["inputs.kick.threshold"].value}`,
  );
  check(
    "per-scene tuned values reapply on boot (NFR-5)",
    boot2.params.punch.value === 2.5,
    `punch=${boot2.params.punch.value}`,
  );
  check(
    "bindings survive the reload",
    reloaded.bindings.some((b) => b.cc === 21 && b.scene === "pulse" && b.path === "punch"),
  );
  await output.evaluate(() => window.__loom.midiInject(21, 0, 1));
  const punchAfterReload = await waitFor(async () => {
    const v = toolJson(await callOk(client, "get_manifest", { instance: "boot" })).params.punch.value;
    return v === 3 ? v : null;
  }, 5_000, "reloaded binding to drive punch");
  check("reloaded binding still drives the param", punchAfterReload === 3);

  // 8. Unbind from the Console widget (bound button click = unbind).
  await consolePage.click('.tile[data-id="boot"]');
  await consolePage.waitForSelector('#widgets [data-learn="punch"]', { timeout: 10_000 });
  await waitFor(async () => {
    const t = await consolePage.$eval('#widgets [data-learn="punch"]', (b) => b.textContent);
    return t === "cc21" ? true : null;
  }, 5_000, "binding badge after reload");
  await consolePage.click('#widgets [data-learn="punch"]');
  await waitFor(async () => {
    const s = toolJson(await callOk(client, "get_session", {}));
    return s.bindings.length === 0 ? true : null;
  }, 5_000, "unbind");
  check("clicking a bound widget unbinds it", true);

  // 9. The rack is code-defined and hot-reloads: a new channel appears with
  // tuned values carried over; restoring the file removes it again.
  writeFileSync(
    INPUTS,
    originalInputs.replace(
      `d.cc("knob1", { cc: 21 });`,
      `d.cc("knob1", { cc: 21 });\n  d.onset("kickTight", { band: "bass", threshold: 0.5, decay: 0.1 });`,
    ),
  );
  const withTight = await waitFor(async () => {
    const g = toolJson(await callOk(client, "get_manifest", { instance: "globals" }));
    return g.params["inputs.kickTight.threshold"] ? g : null;
  }, 15_000, "inputs.ts hot reload to add kickTight");
  check(
    "inputs.ts hot-reloads; tuned kick threshold carries over",
    withTight.params["inputs.kickTight.threshold"].value === 0.5 &&
      withTight.params["inputs.kick.threshold"].value === 0.7,
    `kickTight=${withTight.params["inputs.kickTight.threshold"].value} kick=${withTight.params["inputs.kick.threshold"].value}`,
  );
  writeFileSync(INPUTS, originalInputs);
  await waitFor(async () => {
    const g = toolJson(await callOk(client, "get_manifest", { instance: "globals" }));
    return g.params["inputs.kickTight.threshold"] == null ? true : null;
  }, 15_000, "inputs.ts restore to drop kickTight");
  check("restoring inputs.ts drops the channel again", true);

  // 10. Button binding modes (set/cycle, rising-edge). midi_learn is
  // HUMAN_ONLY, so arm it the way the Console does: a req envelope on the
  // page's BroadcastChannel("loom").
  let chanSeq = 0;
  const humanReq = (type, args) =>
    output.evaluate(
      ([t, a, id]) =>
        new Promise((resolve, reject) => {
          const ch = new BroadcastChannel("loom");
          const timer = setTimeout(() => {
            ch.close();
            reject(new Error(`no response to ${t}`));
          }, 5000);
          ch.onmessage = (e) => {
            const m = e.data;
            if (m?.kind !== "res" || m.id !== id) return;
            clearTimeout(timer);
            ch.close();
            m.ok ? resolve(m.result) : reject(new Error(m.error));
          };
          ch.postMessage({ id, kind: "req", type: t, args: a });
        }),
      [type, args, `vm5-${++chanSeq}`],
    );

  await humanReq("midi_learn", { instance: "boot", path: "punch", mode: "set", value: 3 });
  await output.evaluate(() => window.__loom.midiInject(34, 0, 1)); // press learns + fires
  await output.evaluate(() => window.__loom.midiInject(34, 0, 0)); // release inert
  await humanReq("midi_learn", { instance: "boot", path: "punch", mode: "set", value: 0.75 });
  await output.evaluate(() => window.__loom.midiInject(35, 0, 1));
  await output.evaluate(() => window.__loom.midiInject(35, 0, 0));
  const radio = await waitFor(async () => {
    const s = toolJson(await callOk(client, "get_session", {}));
    const ours = s.bindings.filter((b) => b.path === "punch" && b.mode === "set");
    return ours.length === 2 ? s : null;
  }, 5_000, "radio group to land");
  check("set-mode learns accumulate a radio group", true, JSON.stringify(radio.bindings));
  const punchSet = toolJson(await callOk(client, "get_manifest", { instance: "boot" })).params.punch.value;
  check("set binding fired on the learning press", punchSet === 0.75, `punch=${punchSet}`);
  await output.evaluate(() => window.__loom.midiInject(34, 0, 1)); // radio: back to 3
  const punch3 = await waitFor(async () => {
    const v = toolJson(await callOk(client, "get_manifest", { instance: "boot" })).params.punch.value;
    return v === 3 ? v : null;
  }, 5_000, "radio press to set 3");
  check("radio press sets its option value", punch3 === 3);
  await output.evaluate(() => window.__loom.midiInject(34, 0, 0)); // release
  await sleep(300);
  const punchStill = toolJson(await callOk(client, "get_manifest", { instance: "boot" })).params.punch.value;
  check("release is inert (rising edge only)", punchStill === 3, `punch=${punchStill}`);

  // 11. Cycle on a globals bool â€” each press flips, release inert.
  await humanReq("midi_learn", { instance: "globals", path: "inputs.kick.enabled", mode: "cycle" });
  const enabledBefore = toolJson(await callOk(client, "get_manifest", { instance: "globals" }))
    .params["inputs.kick.enabled"].value;
  await output.evaluate(() => window.__loom.midiInject(36, 0, 1)); // learn + flip
  // (waitFor treats falsy as "not yet" â€” return true, never the flipped bool itself)
  await waitFor(async () => {
    const v = toolJson(await callOk(client, "get_manifest", { instance: "globals" }))
      .params["inputs.kick.enabled"].value;
    return v === !enabledBefore ? true : null;
  }, 5_000, "cycle to flip the bool");
  check("cycle flips a globals bool", true);
  await output.evaluate(() => window.__loom.midiInject(36, 0, 0)); // release
  await output.evaluate(() => window.__loom.midiInject(36, 0, 1)); // flip back
  await waitFor(async () => {
    const v = toolJson(await callOk(client, "get_manifest", { instance: "globals" }))
      .params["inputs.kick.enabled"].value;
    return v === enabledBefore ? true : null;
  }, 5_000, "second press to flip back");
  check("second press flips back (edge per press)", true);
  await output.evaluate(() => window.__loom.midiInject(36, 0, 0));

  // 12. Actions: live.next crossfades LIVE between ok tiles, wrapping.
  await callOk(client, "create_instance", { scene: "pulse", id: "deck2" });
  await humanReq("midi_learn", { instance: "actions", path: "live.next" });
  await output.evaluate(() => window.__loom.midiInject(44, 0, 1)); // learn + step
  const live2 = await waitFor(async () => {
    const s = toolJson(await callOk(client, "get_session", {}));
    return s.live === "deck2" ? s : null;
  }, 10_000, "live.next to switch live to deck2");
  check("live.next steps LIVE to the next ok tile", live2.live === "deck2");
  await output.evaluate(() => window.__loom.midiInject(44, 0, 0));
  await waitFor(async () => {
    const s = toolJson(await callOk(client, "get_session", {}));
    return s.mix == null ? true : null; // fade finished
  }, 10_000, "crossfade to finish");
  await output.evaluate(() => window.__loom.midiInject(44, 0, 1)); // wrap back
  const liveBack = await waitFor(async () => {
    const s = toolJson(await callOk(client, "get_session", {}));
    return s.live === "boot" ? s : null;
  }, 10_000, "live.next to wrap back to boot");
  check("live.next wraps around the tile ring", liveBack.live === "boot");
  await output.evaluate(() => window.__loom.midiInject(44, 0, 0));
  const stripChip = await waitFor(async () => {
    const t = await consolePage.$eval('[data-learn="live.next"]', (b) => b.textContent);
    return /cc44/.test(t ?? "") ? t : null;
  }, 5_000, "stage strip to show the action binding");
  check("stage strip shows the action binding", true, stripChip);

  // 13. Mode/value persist to bindings.json.
  await sleep(800); // debounced write
  const bindingsJson2 = JSON.parse(readFileSync(join(STATE_DIR, "bindings.json"), "utf8"));
  check(
    "bindings.json carries mode/value and the action binding",
    bindingsJson2.some((b) => b.mode === "set" && b.value === 3) &&
      bindingsJson2.some((b) => b.scene === "actions" && b.path === "live.next"),
    JSON.stringify(bindingsJson2),
  );

  // 14. The agent tool surface is unchanged: MIDI-learn (like set_audio)
  // is a Console-only, human-only affair.
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  check(
    "MCP tool surface unchanged (no midi tools for agents)",
    [
        "clear_modulation", "commit", "create_instance", "destroy_instance", "get_manifest",
        "get_session", "list_projects", "load_project", "modulate_param", "record_fixture", "save_chain",
        "save_project", "screenshot", "set_chain", "set_modulation_enabled", "set_param", "stage", "unstage",
      ].every((t) => tools.includes(t)) && !tools.includes("set_audio"),
    tools.join(", "),
  );
} catch (err) {
  check("validation run completed", false, String(err));
} finally {
  // Kill the engine BEFORE restoring state: a still-alive page can flush a
  // late debounced save and recreate files after the restore.
  if (client) await client.close().catch(() => {});
  if (browser) await browser.close();
  if (process.platform === "win32") {
    try { execSync(`taskkill /pid ${vite.pid} /T /F`, { stdio: "ignore" }); } catch {}
  } else {
    vite.kill("SIGTERM");
  }
  writeFileSync(SCENE, originalScene);
  writeFileSync(INPUTS, originalInputs);
  rmSync(STATE_DIR, { recursive: true, force: true });
  for (const [rel, content] of stateBackup) {
    const file = join(STATE_DIR, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

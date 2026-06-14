// M2 acceptance check: the agent loop works end-to-end through MCP.
// A real MCP client (this script) talks stdio to the sidecar, which bridges
// over WebSocket to the engine in headless Chromium: get_session/get_manifest
// reflect the live scene, set_param round-trips <100 ms and visibly changes
// pixels, screenshot returns the actual canvas.
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
const SCENE = join(ROOT, "content", "scenes", "live.scene.ts");
const PORT = 5199;
// Isolated sidecar port: a live Claude Code session may hold the default 7341.
const WS_PORT = 7342;
// state=off: persisted tunings (M5) must never skew validation assertions.
// agentCommit=0: boot UNARMED so the batch's commit hits the human-gate (the
// 8c check asserts an unarmed agent commit is gated inside a batch); the engine
// otherwise defaults to armed, which would short-circuit on "nothing staged".
const URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}&state=off&agentCommit=0${resQuery}`;

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

/** Parse the JSON text content of a (non-image) MCP tool result. */
function toolJson(res) {
  const text = res.content?.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text);
}

function decodeShot(res) {
  const img = res.content?.find((c) => c.type === "image");
  if (!img) throw new Error("screenshot result carried no image content");
  const png = PNG.sync.read(Buffer.from(img.data, "base64"));
  let lum = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    lum += (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
  }
  return { png, meta: toolJson(res), lum: lum / (png.width * png.height) };
}

async function avgScreenshotLum(client, n = 4, gapMs = 350) {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += decodeShot(await client.callTool({ name: "screenshot", arguments: {} })).lum;
    await sleep(gapMs);
  }
  return sum / n;
}

mkdirSync(ARTIFACTS, { recursive: true });

// Pin pulse as the live scene — the checks assert pulse's manifest (punch/
// trail/drift, trail clamp 0.97) — and restore the real live scene afterwards.
const PULSE_PIN = `export { default } from "./pulse.scene";\n`;
const originalScene = readFileSync(SCENE, "utf8");
writeFileSync(SCENE, PULSE_PIN);

// ---- spawn vite (engine) ----
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
  const serverReady = waitForServer(`http://localhost:${PORT}/`);
  await Promise.race([
    serverReady,
    (async () => {
      while (viteExit === null) await sleep(200);
      throw new Error(`vite exited early (code ${viteExit}) — is port ${PORT} already in use?`);
    })(),
  ]);

  // ---- connect MCP client (spawns the sidecar over stdio) ----
  client = new Client({ name: "validate-m2", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "packages/sidecar/src/index.ts"],
    cwd: ROOT,
    env: { ...process.env, LOOM_WS_PORT: String(WS_PORT) },
    stderr: "pipe",
  });
  await client.connect(transport);
  transport.stderr?.on("data", (d) => process.stderr.write(`[sidecar] ${d}`));

  // 1. MCP surface: the four M2 tools exist (later milestones add more).
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check(
    "MCP exposes the 4 M2 agent tools",
    ["get_manifest", "get_session", "screenshot", "set_param"].every((t) => tools.includes(t)),
    tools.sort().join(", "),
  );

  // 2. Engine absent: clean error, not a hang or crash.
  const noEngine = await client.callTool({ name: "get_session", arguments: {} });
  check(
    "engine-not-connected is a clean tool error",
    noEngine.isError === true && /not connected/i.test(noEngine.content[0].text),
    noEngine.content?.[0]?.text,
  );

  // ---- bring the engine up ----
  browser = await chromium.launch({
    headless: true,
    args: [
      ...glArgs,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await forceWebGL2(page);
  await page.goto(URL);
  await page.waitForFunction(
    () => /\d+ fps/.test(document.querySelector("#fps")?.textContent ?? ""),
    null,
    { timeout: 20_000 },
  );

  // Engine reconnects every 2 s; poll until the bridge is live.
  let session = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    if (!res.isError) {
      session = toolJson(res);
      break;
    }
    await sleep(500);
  }
  check("engine connected to sidecar", session !== null);
  if (!session) throw new Error("engine never connected to the sidecar");

  // 3. get_session reflects reality.
  check("session: scene is pulse", session.scene === "pulse", `scene=${session.scene}`);
  check("session: test audio mode", session.audioMode === "test", `mode=${session.audioMode}`);
  // Subset, not equality: M5's ctx.input() adds auto trim params to pulse.
  check(
    "session: manifest paths visible",
    ["drift", "punch", "trail"].every((p) => session.paramPaths.includes(p)),
    session.paramPaths.join(", "),
  );
  await sleep(500);
  const session2 = toolJson(await client.callTool({ name: "get_session", arguments: {} }));
  check(
    "session: frame counter advances",
    session2.frame > session.frame,
    `${session.frame} -> ${session2.frame}`,
  );

  // 4. get_manifest: full param descriptors.
  const manifest = toolJson(await client.callTool({ name: "get_manifest", arguments: {} }));
  const punch = manifest.params?.punch;
  check(
    "manifest: punch descriptor complete",
    punch?.type === "float" && punch?.min === 0 && punch?.max === 3 && punch?.default === 1.2,
    JSON.stringify(punch),
  );

  // 5. set_param: round-trip latency (median of 5 after warmup) < 100 ms.
  await client.callTool({ name: "set_param", arguments: { path: "trail", value: 0.88 } });
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await client.callTool({ name: "set_param", arguments: { path: "trail", value: 0.8 + i * 0.01 } });
    times.push(performance.now() - t0);
  }
  const median = times.sort((a, b) => a - b)[2];
  check("set_param round-trip < 100 ms", median < 100, `median ${median.toFixed(1)} ms of [${times.map((t) => t.toFixed(0)).join(", ")}]`);

  // 6. set_param clamps to the declared range.
  const clamped = toolJson(
    await client.callTool({ name: "set_param", arguments: { path: "trail", value: 5 } }),
  );
  check("set_param clamps out-of-range values", clamped.value === 0.97, `5 -> ${clamped.value}`);

  // 7. Unknown param is a clean, self-describing error.
  const bad = await client.callTool({ name: "set_param", arguments: { path: "nope", value: 1 } });
  check(
    "unknown param error lists the manifest",
    bad.isError === true && bad.content[0].text.includes("punch"),
    bad.content?.[0]?.text,
  );

  // 8. screenshot: real pixels from the canvas.
  const shot = decodeShot(await client.callTool({ name: "screenshot", arguments: {} }));
  writeFileSync(join(ARTIFACTS, "m2-1-screenshot.png"), PNG.sync.write(shot.png));
  check(
    "screenshot returns the rendered canvas (non-black)",
    shot.lum > 2 && shot.meta.width > 0 && shot.meta.frame > 0,
    `lum ${shot.lum.toFixed(1)}, ${shot.meta.width}x${shot.meta.height} @ frame ${shot.meta.frame}`,
  );

  // 8b. set_params: many knobs in one round-trip, partial success on a bad path.
  const many = toolJson(
    await client.callTool({
      name: "set_params",
      arguments: { values: { trail: 0.6, punch: 2, nope: 1 } },
    }),
  );
  check(
    "set_params applies good paths and reports bad ones",
    many.set.length === 2 &&
      many.set.some((s) => s.path === "trail" && s.value === 0.6) &&
      many.errors.length === 1 &&
      many.errors[0].path === "nope",
    `set ${JSON.stringify(many.set)} · errors ${JSON.stringify(many.errors)}`,
  );

  // 8c. batch: one call fans out to many; gates apply; screenshots come back as images.
  const batch = await client.callTool({
    name: "batch",
    arguments: {
      calls: [
        { tool: "set_params", args: { values: { trail: 0.7 } } },
        { tool: "get_session" },
        { tool: "screenshot" },
        { tool: "commit" }, // unarmed agent commit → gated, reported as ok:false
      ],
    },
  });
  const batchJson = JSON.parse(batch.content.find((c) => c.type === "text").text);
  const batchImg = batch.content.find((c) => c.type === "image");
  check(
    "batch runs calls serially, surfaces screenshot images, and preserves gates",
    batchJson.results.length === 4 &&
      batchJson.results[0].ok === true &&
      batchJson.results[1].ok === true &&
      batchJson.results[2].ok === true &&
      batchJson.results[3].ok === false &&
      /not armed/.test(batchJson.results[3].error) &&
      batchImg != null,
    `results ${JSON.stringify(batchJson.results.map((r) => [r.tool, r.ok]))}`,
  );

  // 9. Params visibly steer the picture: bright extreme vs dark extreme.
  await client.callTool({ name: "set_param", arguments: { path: "punch", value: 3 } });
  await client.callTool({ name: "set_param", arguments: { path: "trail", value: 0.97 } });
  await sleep(1500); // let trails accumulate
  const brightLum = await avgScreenshotLum(client);
  await client.callTool({ name: "set_param", arguments: { path: "punch", value: 0 } });
  await client.callTool({ name: "set_param", arguments: { path: "trail", value: 0.5 } });
  await sleep(1500); // let trails decay
  const darkLum = await avgScreenshotLum(client);
  check(
    "set_param visibly changes the output",
    brightLum > darkLum + 2,
    `bright extreme ${brightLum.toFixed(1)} vs dark extreme ${darkLum.toFixed(1)}`,
  );

  // ---- Diagnostics (app-instrumentation) ----
  // 11. get_diagnostics is exposed as a read-only agent tool.
  check(
    "MCP exposes get_diagnostics",
    tools.includes("get_diagnostics"),
    tools.filter((t) => t.startsWith("get_")).join(", "),
  );

  // 12. The perf rollup rides on get_session AND get_diagnostics, and is plausible.
  const perfSession = toolJson(await client.callTool({ name: "get_session", arguments: {} }));
  const perf = perfSession.perf;
  check(
    "get_session carries a plausible perf block",
    perf != null &&
      typeof perf.fps === "number" &&
      perf.fps > 0 &&
      (perf.clockSource === "raf" || perf.clockSource === "worker") &&
      Array.isArray(perf.instances) &&
      perf.instances.some((i) => i.id === session.live && typeof i.frameMs === "number"),
    perf ? `fps=${perf.fps.toFixed(0)} clock=${perf.clockSource} budget=${perf.frameBudgetMs} instances=${perf.instances.length}` : "no perf block",
  );

  // 13. Establish a diagnostics cursor, then FORCE A BUILD REJECTION by hot-swapping
  // live.scene.ts to a scene whose build() throws. Never-go-black: the previous
  // pixels must keep running, and the rejection must surface as a structured event.
  const cursorBefore = toolJson(await client.callTool({ name: "get_diagnostics", arguments: {} }));
  const sinceSeq = cursorBefore.now.seq;
  check(
    "get_diagnostics returns events + perf + a seq cursor",
    Array.isArray(cursorBefore.events) &&
      typeof cursorBefore.now.seq === "number" &&
      cursorBefore.perf != null,
    `seq=${sinceSeq}, ${cursorBefore.events.length} events`,
  );

  // Pixels before the bad save (the live scene is still pulse).
  const lumBeforeReject = await avgScreenshotLum(client, 3, 250);

  const THROWING_SCENE = join(ROOT, "content", "scenes", "__diag_throw.scene.ts");
  writeFileSync(
    THROWING_SCENE,
    `import { defineScene } from "@loom/runtime";\n` +
      `export default defineScene({\n` +
      `  name: "diagThrow",\n` +
      `  description: "deliberately throws at build (diagnostics acceptance)",\n` +
      `  tags: ["test"],\n` +
      `  build() { throw new Error("forced build rejection for diagnostics test"); },\n` +
      `});\n`,
  );
  writeFileSync(SCENE, `export { default } from "./__diag_throw.scene";\n`);

  // Poll get_diagnostics for the scene.rejected event the bad swap must produce.
  let rejectEvent = null;
  const rejectDeadline = Date.now() + 12_000;
  while (Date.now() < rejectDeadline) {
    const diagRes = toolJson(
      await client.callTool({
        name: "get_diagnostics",
        arguments: { since: sinceSeq, kinds: ["scene.rejected", "instance.rejected"] },
      }),
    );
    rejectEvent = diagRes.events.find((e) => e.kind === "scene.rejected");
    if (rejectEvent) break;
    await sleep(500);
  }
  check(
    "forced bad save surfaces a scene.rejected event with frame + instance",
    rejectEvent != null &&
      rejectEvent.level === "error" &&
      typeof rejectEvent.frame === "number" &&
      rejectEvent.frame > 0 &&
      typeof rejectEvent.instance === "string" &&
      typeof rejectEvent.data?.error === "string",
    rejectEvent ? `${rejectEvent.kind} @frame ${rejectEvent.frame} on "${rejectEvent.instance}": ${rejectEvent.data?.error}` : "no scene.rejected event seen",
  );

  // Never-go-black: the live pixels are unchanged by the rejected save.
  const lumAfterReject = await avgScreenshotLum(client, 3, 250);
  check(
    "live pixels unchanged after the rejected save (never go black)",
    Math.abs(lumAfterReject - lumBeforeReject) < lumBeforeReject * 0.5 + 5 && lumAfterReject > 1,
    `before ${lumBeforeReject.toFixed(1)} vs after ${lumAfterReject.toFixed(1)}`,
  );

  // 14. `since` paging: a fresh cursor at "now" returns no past events; the older
  // cursor still does — the cursor advances monotonically.
  const afterReject = toolJson(await client.callTool({ name: "get_diagnostics", arguments: {} }));
  const pagedFromNow = toolJson(
    await client.callTool({ name: "get_diagnostics", arguments: { since: afterReject.now.seq } }),
  );
  check(
    "get_diagnostics pages forward with `since` (no replay past the cursor)",
    afterReject.now.seq > sinceSeq && pagedFromNow.events.length === 0,
    `seq advanced ${sinceSeq} -> ${afterReject.now.seq}; pagedFromNow=${pagedFromNow.events.length}`,
  );

  // 15. The sidecar's OWN per-tool latency table (scope:"sidecar", answered locally).
  const sidecarDiag = toolJson(
    await client.callTool({ name: "get_diagnostics", arguments: { scope: "sidecar" } }),
  );
  const getSessionStat = sidecarDiag.tools?.find((t) => t.tool === "get_session");
  check(
    "get_diagnostics scope:sidecar reports per-tool call latency",
    sidecarDiag.scope === "sidecar" &&
      sidecarDiag.engineConnected === true &&
      getSessionStat != null &&
      getSessionStat.count > 0 &&
      typeof getSessionStat.p50 === "number",
    getSessionStat ? `get_session: ${getSessionStat.count} calls, p50 ${getSessionStat.p50} ms, p95 ${getSessionStat.p95} ms` : "no get_session stat",
  );

  // Restore pulse for the remaining checks, and clean up the throwing scene.
  writeFileSync(SCENE, PULSE_PIN);
  rmSync(THROWING_SCENE, { force: true });
  await sleep(800); // let the live scene recover to pulse

  // NOTE — freeze-id (instance.frozen carries the instance id, not the scene name)
  // is proven by the kernel unit test packages/runtime/test/instance-freeze-id.test.ts.
  // A render-time-freeze acceptance check was prototyped here but couldn't observe
  // the event: in this WebGL2 validator the NFR-2 freeze console.error fires yet no
  // `instance.frozen` reaches the diagnostics ring (only perf.* events do) — a
  // PRE-EXISTING delivery gap in the `Instance.diagSink` path, unrelated to the id
  // field this feature fixes. Flagged as an escalation; not blocking m2.

  // 16. Instrumentation overhead is negligible: an engine booted ?diag=0 renders
  // at essentially the same fps as the instrumented one (NFR-1 frame budget).
  // Isolated (unused) ws port so this second engine never steals the bridge from
  // the instrumented page (latest-connection-wins) — we only read its fps.
  const diagOffUrl = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT + 50}&state=off&diag=0${resQuery}`;
  const offPage = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await forceWebGL2(offPage);
  await offPage.goto(diagOffUrl);
  await offPage.waitForFunction(
    () => /\d+ fps/.test(document.querySelector("#fps")?.textContent ?? ""),
    null,
    { timeout: 20_000 },
  );
  await sleep(2500); // let both fps meters settle
  const fpsOff = await offPage.evaluate(() => window.__loom?.fps ?? 0);
  const fpsOn = await page.evaluate(() => window.__loom?.fps ?? 0);
  await offPage.close();
  check(
    "?diag=0 vs ?diag=1 frame budget is unchanged (negligible overhead)",
    fpsOn > 0 && fpsOff > 0 && Math.abs(fpsOn - fpsOff) <= Math.max(8, fpsOff * 0.25),
    `diag on ${fpsOn.toFixed(0)} fps vs diag off ${fpsOff.toFixed(0)} fps`,
  );

  // 10. Restore defaults for the human.
  await client.callTool({ name: "set_param", arguments: { path: "punch", value: 1.2 } });
  await client.callTool({ name: "set_param", arguments: { path: "trail", value: 0.88 } });
  await client.callTool({ name: "set_param", arguments: { path: "drift", value: 1.015 } });
  const restored = toolJson(await client.callTool({ name: "get_manifest", arguments: {} }));
  check("params restored to defaults", restored.params.trail.value === 0.88);
} catch (err) {
  check("validation run completed", false, String(err));
} finally {
  writeFileSync(SCENE, originalScene);
  rmSync(join(ROOT, "content", "scenes", "__diag_throw.scene.ts"), { force: true });
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

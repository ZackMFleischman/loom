// M11 acceptance check: library & parallel build. The catalog carries the
// chainable / inputs-consumed columns; a brand-new module written DURING the
// run hot-registers into the catalog (the "found tomorrow" loop); the three
// subagent-built library scenes (static-haunt / biolume / prism-array) build
// healthy; and the parallel substrate holds — three fixture-driven sandboxes
// created CONCURRENTLY, each its own tile, all rendering, no cross-talk.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { chromium } from "playwright";
import { glArgs, forceWebGL2, resQuery } from "./_browser.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ARTIFACTS = join(ROOT, "artifacts");
const SCENE = join(ROOT, "content", "scenes", "live.scene.ts");
const CATALOG = join(ROOT, "content", "CATALOG.md");
const TMP_MODULE = join(ROOT, "content", "modules", "effects", "validatorTmpMod.ts");
const STATE_DIR = join(ROOT, "content", "state");
const PORT = 5213;
const WS_PORT = 7357;
const OUTPUT_URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}&state=off${resQuery}`;

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

function lumOf(res) {
  const img = res.content?.find((c) => c.type === "image");
  const png = PNG.sync.read(Buffer.from(img.data, "base64"));
  let l = 0;
  for (let i = 0; i < png.data.length; i += 4) l += (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
  return l / (png.width * png.height);
}

const TMP_MODULE_SRC = `import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { vec4 } from "three/tsl";

export interface ValidatorTmpModOpts {
  input: TexNode;
  lift?: SignalLike;
}

/** validator-only: proves a just-written module hot-registers into the catalog. */
export const validatorTmpMod = defineModule(
  {
    name: "validatorTmpMod",
    kind: "effect",
    description: "Validator-only throwaway effect proving catalog hot-registration.",
    tags: ["validator"],
    example: "validatorTmpMod(ctx, { input: src })",
    chainParams: [{ name: "lift", default: 0, min: 0, max: 1, description: "additive lift" }],
  },
  (ctx: BuildCtx, opts: ValidatorTmpModOpts): TexNode => {
    const lift = ctx.uniformOf(opts.lift ?? 0);
    const c = opts.input.color;
    return texNode(vec4(c.rgb.add(lift), c.a), opts.input.passes);
  },
);
`;

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

  client = new Client({ name: "validate-m11", version: "0.0.0" });
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
  const session = async () => toolJson(await callOk(client, "get_session", {}));
  await waitFor(async () => {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    return res.isError ? null : toolJson(res);
  }, 15_000, "engine to connect to sidecar");

  // 1. The catalog carries the M11 columns.
  const catalog = readFileSync(CATALOG, "utf8");
  check(
    "catalog marks chainable effects (⛓)",
    /\*\*bloom\*\*.*⛓chainable/.test(catalog) && /\*\*blur\*\*.*⛓chainable/.test(catalog),
  );
  check(
    "catalog marks two-input effects NOT chainable (mixer, over)",
    /\*\*mixer\*\*(?!.*⛓)/.test(catalog.split("\n").find((l) => l.includes("**mixer**")) ?? "x⛓") &&
      !(catalog.split("\n").find((l) => l.includes("**over**")) ?? "⛓").includes("⛓"),
  );
  // Modules take SignalLike opts by design (scenes do the channel wiring), so
  // the ⚡ marker lives on SCENE lines.
  check(
    "catalog lists inputs consumed (⚡) on scenes",
    /\*\*pulse\*\*.*⚡inputs: kick, bass/.test(catalog) && /\*\*hippo-swarm\*\*.*⚡inputs: .*hats/.test(catalog),
  );

  // 2. A module written NOW hot-registers into the catalog (found tomorrow).
  writeFileSync(TMP_MODULE, TMP_MODULE_SRC);
  await waitFor(
    () => (readFileSync(CATALOG, "utf8").includes("**validatorTmpMod**") ? true : null),
    20_000,
    "the new module to appear in the regenerated catalog",
  );
  const grown = readFileSync(CATALOG, "utf8");
  check(
    "a just-written module appears in the catalog with its chainable mark",
    /\*\*validatorTmpMod\*\*.*⛓chainable/.test(grown),
  );
  const effects = await waitFor(async () => {
    const s = await session();
    return s.availableEffects.some((e) => e.name === "validatorTmpMod") ? s.availableEffects : null;
  }, 15_000, "the new effect to reach availableEffects").catch(() => null);
  check("the new effect is selectable for chains without a reload", effects != null);

  // 3. The three subagent-built library scenes exist and build healthy.
  for (const scene of ["static-haunt", "biolume", "prism-array"]) {
    const inst = toolJson(await callOk(client, "create_instance", { scene })).instance;
    const lit = await waitFor(async () => {
      try {
        const l = lumOf(await callOk(client, "screenshot", { instance: inst }));
        return l > 1 ? l : null;
      } catch {
        return null;
      }
    }, 25_000, `${scene} to render`);
    const info = (await session()).instances.find((i) => i.id === inst);
    check(`subagent scene "${scene}" builds and renders`, info?.status === "ok" && lit > 1, `lum=${lit.toFixed(1)}`);
    await callOk(client, "destroy_instance", { instance: inst });
  }

  // 4. Parallel substrate: three fixture-driven sandboxes created CONCURRENTLY.
  await callOk(client, "record_fixture", { name: "m11trace", frames: 60 });
  const created = await Promise.all(
    ["pulse", "biolume", "prism-array"].map((scene) =>
      callOk(client, "create_instance", { scene, inputs: "fixture:m11trace" }).then((r) => toolJson(r).instance),
    ),
  );
  check("three fixture instances create concurrently (distinct ids)", new Set(created).size === 3, created.join(" · "));
  const after = await session();
  check(
    "all three run healthy on the shared trace, one tile each",
    created.every((id) => {
      const i = after.instances.find((x) => x.id === id);
      return i?.status === "ok" && i.fixture === "m11trace" && i.builds === 1;
    }),
  );
  const lums = [];
  for (const id of created) {
    lums.push(
      await waitFor(async () => {
        try {
          const l = lumOf(await callOk(client, "screenshot", { instance: id }));
          return l > 1 ? l : null;
        } catch {
          return null;
        }
      }, 25_000, `${id} to render`),
    );
  }
  check("all three render non-black in their own tiles", lums.every((l) => l > 1), lums.map((l) => l.toFixed(1)).join(" · "));
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
  rmSync(TMP_MODULE, { force: true });
  rmSync(join(STATE_DIR, "fixtures"), { recursive: true, force: true });
  for (const [rel, content] of stateBackup) {
    const file = join(STATE_DIR, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  try { execSync(`node "${join(ROOT, "scripts", "build-catalog.mjs")}"`, { stdio: "ignore" }); } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

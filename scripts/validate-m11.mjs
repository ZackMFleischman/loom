// M11 acceptance check: library & parallel build. The catalog carries the
// chainable / inputs-consumed columns; a brand-new module written DURING the
// run hot-registers into the catalog (the "found tomorrow" loop); the three
// subagent-built library scenes (static-haunt / biolume / prism-array) build
// healthy; and the parallel substrate holds — three fixture-driven sandboxes
// created CONCURRENTLY, each its own tile, all rendering, no cross-talk.
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import {
  ROOT,
  STATE_DIR,
  bootStack,
  makeResults,
  toolJson,
  callOk,
  waitFor,
  backupState,
} from "./_harness.mjs";

const CATALOG = join(ROOT, "content", "CATALOG.md");
const TMP_MODULE = join(ROOT, "content", "modules", "effects", "validatorTmpMod.ts");
const PORT = 5213;
const WS_PORT = 7357;
const OUTPUT_URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}&state=off`;

const { results, check } = makeResults();

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

const stateBackup = backupState(); // fixtures get written during the run

const T_START = Date.now();
let tChecks = T_START;
let teardown = async () => {};
try {
  const boot = await bootStack({
    name: "validate-m11",
    port: PORT,
    wsPort: WS_PORT,
    url: OUTPUT_URL,
  });
  teardown = boot.teardown;
  const { client } = boot;
  tChecks = Date.now();
  const session = async () => toolJson(await callOk(client, "get_session", {}));

  // 1. The catalog carries the M11 columns.
  const catalog = readFileSync(CATALOG, "utf8");
  check(
    "catalog marks chainable effects (⛓)",
    /\*\*bloom\*\*.*⛓chainable/.test(catalog) && /\*\*blur\*\*.*⛓chainable/.test(catalog),
  );
  check(
    // `over` became chainable as a multi-input step (declares a `tex` chainInput
    // satisfiable by an instance/earlier-step source — see multi-input-chain-steps).
    // `mixer`/`flyby` stay non-chainable: their second input isn't wired as a
    // chainInput yet (flyby needs the M10 asset explorer).
    "catalog marks over chainable (multi-input) while mixer/flyby stay non-chainable",
    (catalog.split("\n").find((l) => l.includes("**over**")) ?? "").includes("⛓") &&
      !(catalog.split("\n").find((l) => l.includes("**mixer**")) ?? "⛓").includes("⛓") &&
      !(catalog.split("\n").find((l) => l.includes("**flyby**")) ?? "⛓").includes("⛓"),
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
  console.log(
    `[timing] m11 boot=${((tChecks - T_START) / 1000).toFixed(1)}s checks=${((Date.now() - tChecks) / 1000).toFixed(1)}s`,
  );
  await teardown(); // closes engine/sidecar/vite and restores the original live scene
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

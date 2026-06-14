// Layers acceptance check: ctx.layer(name, tex) named nodes with per-node rigs
// and per-node FX chains. Shipped-when, asserted here: an unmodified scene
// gains a wrapped "logo" layer in ONE live edit; set_param logo.layer.* moves/
// fades it with NO rebuild; set_chain { node: "logo" } affects just that node
// (NFR-5 on a throwing step); layer params modulate like any other param; the
// Console shows the node tree with a per-node "+ effect". (MIDI-learn on layer
// params rides the same scene+path binding mechanics m5 already validates.)
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import {
  ROOT,
  ARTIFACTS,
  SCENE,
  bootStack,
  makeResults,
  sleep,
  toolJson,
  callOk,
  waitFor,
  dist,
} from "./_harness.mjs";

const BROKEN_CHAIN = join(ROOT, "content", "modules", "effects", "chains", "validatorBroken.chain.json");
const PORT = 5205;
const WS_PORT = 7350;
// agentCommit=1: the boot instance is LIVE and this run edits its chain as the agent.
const OUTPUT_URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}&state=off&agentCommit=1`;
const CONSOLE_URL = `http://localhost:${PORT}/console.html?embed=0`;

const { results, check } = makeResults();

/** Average RGB of a fractional region [x0..x1]×[y0..y1] of an MCP screenshot. */
function regionAvg(res, x0, y0, x1, y1) {
  const img = res.content?.find((c) => c.type === "image");
  if (!img?.data) throw new Error("screenshot result carried no image data");
  const png = PNG.sync.read(Buffer.from(img.data, "base64"));
  const c0 = Math.floor(x0 * png.width), c1 = Math.ceil(x1 * png.width);
  const r0 = Math.floor(y0 * png.height), r1 = Math.ceil(y1 * png.height);
  let r = 0, g = 0, b = 0, n = 0;
  for (let row = r0; row < r1; row++) {
    for (let col = c0; col < c1; col++) {
      const i = (row * png.width + col) * 4;
      r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n++;
    }
  }
  return { r: r / n, g: g / n, b: b / n };
}
// The logo patch sits at screen center (±0.15 uv); corners are flat backdrop.
const center = (res) => regionAvg(res, 0.45, 0.45, 0.55, 0.55);
const corner = (res) => regionAvg(res, 0.0, 0.0, 0.08, 0.08);

// ---- the validator scene: flat backdrop + a red logo patch ----
// Version A: the patch is NOT wrapped. Version B adds ctx.layer("logo", …) — the
// "one live edit" of the shipped-when.
const sceneSource = (wrapped) => `import { defineScene, texNode } from "@loom/runtime";
import { abs, step, uv, vec4 } from "three/tsl";
import { over } from "../modules/effects/over";

export default defineScene({
  name: "layerval",
  description: "Layers validator: flat backdrop + a red logo patch.",
  build(ctx) {
    const bg = texNode(vec4(0.05, 0.05, 0.3, 1));
    const d = abs(uv().sub(0.5));
    const inside = step(d.x, 0.15).mul(step(d.y, 0.15));
    ${
      wrapped
        ? `const patch = ctx.layer("logo", texNode(vec4(inside, 0, 0, inside)));`
        : `const patch = texNode(vec4(inside, 0, 0, inside));`
    }
    return over(ctx, { input: bg, overlay: patch });
  },
});
`;

// A composite whose inner step references a nonexistent primitive: plan()
// accepts it (the composite IS registered), the fold throws — a real
// throwing-step build for the NFR-5 check.
writeFileSync(
  BROKEN_CHAIN,
  JSON.stringify({
    name: "validatorBroken",
    description: "validator-only: inner step explodes at build time",
    steps: [{ id: "nope-1", effect: "doesNotExistEffect", params: {} }],
  }),
);

const T_START = Date.now();
let tChecks = T_START;
let teardown = async () => {};
try {
  // Boot into the UNWRAPPED layerval scene; "the one live edit" rewrites it to
  // the wrapped version mid-run. bootStack captures + restores the real scene.
  const boot = await bootStack({
    name: "validate-layers",
    port: PORT,
    wsPort: WS_PORT,
    url: OUTPUT_URL,
    pin: sceneSource(false),
  });
  teardown = boot.teardown;
  const { client, context } = boot;
  tChecks = Date.now();
  await waitFor(async () => {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    return res.isError ? null : toolJson(res);
  }, 15_000, "engine to connect to sidecar");

  const bootInfo = async () =>
    toolJson(await callOk(client, "get_session", {})).instances.find((x) => x.id === "boot");

  // 1. Unwrapped scene: no nodes, no rig params.
  const before = await bootInfo();
  const m0 = toolJson(await callOk(client, "get_manifest", { instance: "boot" }));
  check("unwrapped scene reports no nodes", before.nodes.length === 0 && (m0.nodes ?? []).length === 0);
  check("unwrapped scene has no rig params", m0.params["logo.layer.x"] == null);
  const buildsBefore = before.builds;

  // 2. ONE live edit wraps the patch → the node + rig params appear.
  writeFileSync(SCENE, sceneSource(true));
  const after = await waitFor(async () => {
    const info = await bootInfo();
    return info.builds > buildsBefore && info.nodes.some((n) => n.id === "logo") ? info : null;
  }, 20_000, "the logo node to appear after the live edit");
  check(
    "one live edit registers the logo node (parent null, empty chain)",
    after.nodes.length === 1 && after.nodes[0].parent === null && after.nodes[0].chain.length === 0,
  );
  const m1 = toolJson(await callOk(client, "get_manifest", { instance: "boot" }));
  check(
    "rig params logo.layer.x/y/scale/rotate/opacity declared with identity defaults",
    ["x", "y", "scale", "rotate", "opacity"].every((k) => m1.params[`logo.layer.${k}`]?.type === "float") &&
      m1.params["logo.layer.x"].value === 0.5 &&
      m1.params["logo.layer.scale"].value === 1 &&
      m1.params["logo.layer.opacity"].value === 1,
  );
  check("get_manifest lists the node", (m1.nodes ?? []).some((n) => n.id === "logo"));

  await sleep(500); // settle frames before sampling
  const base = await callOk(client, "screenshot", { instance: "boot" });
  const baseCenter = center(base);
  const baseCorner = corner(base);
  check(
    "baseline: red logo at center over flat backdrop",
    baseCenter.r > baseCenter.b + 40 && baseCorner.b > baseCorner.r + 20,
    `center=(${baseCenter.r.toFixed(0)},${baseCenter.g.toFixed(0)},${baseCenter.b.toFixed(0)}) corner=(${baseCorner.r.toFixed(0)},${baseCorner.g.toFixed(0)},${baseCorner.b.toFixed(0)})`,
  );

  // 3. set_param logo.layer.x moves the node — pixels change, NO rebuild.
  const buildsWrapped = (await bootInfo()).builds;
  await callOk(client, "set_param", { instance: "boot", path: "logo.layer.x", value: 0.25 });
  const moved = await waitFor(async () => {
    const s = await callOk(client, "screenshot", { instance: "boot" });
    return dist(center(s), baseCenter) > 60 ? s : null;
  }, 8_000, "the moved logo to leave the center");
  check("logo.layer.x moves the node out of center", true, `Δcenter=${dist(center(moved), baseCenter).toFixed(0)}`);
  check("corner backdrop untouched by the move", dist(corner(moved), baseCorner) < 12);
  check("rig set_param caused NO rebuild", (await bootInfo()).builds === buildsWrapped);
  await callOk(client, "set_param", { instance: "boot", path: "logo.layer.x", value: 0.5 });

  // 4. logo.layer.opacity fades the node out (backdrop shows through).
  await callOk(client, "set_param", { instance: "boot", path: "logo.layer.opacity", value: 0 });
  const faded = await waitFor(async () => {
    const s = await callOk(client, "screenshot", { instance: "boot" });
    const c = center(s);
    return c.b > c.r + 20 ? s : null;
  }, 8_000, "the faded logo to reveal the backdrop");
  check("logo.layer.opacity=0 reveals the backdrop", true, `center.b=${center(faded).b.toFixed(0)}`);
  check("opacity ride caused NO rebuild", (await bootInfo()).builds === buildsWrapped);
  await callOk(client, "set_param", { instance: "boot", path: "logo.layer.opacity", value: 1 });

  // 5. Layer params modulate like any other param.
  await callOk(client, "modulate_param", {
    instance: "boot",
    path: "logo.layer.x",
    modulator: { type: "sine", periodSeconds: 1.2, lo: 0.2, hi: 0.8 },
  });
  const sA = await callOk(client, "screenshot", { instance: "boot" });
  await sleep(450);
  const sB = await callOk(client, "screenshot", { instance: "boot" });
  const band = (res) => regionAvg(res, 0.1, 0.45, 0.9, 0.55);
  check("modulator animates logo.layer.x (frames differ)", dist(band(sA), band(sB)) > 6, `Δ=${dist(band(sA), band(sB)).toFixed(1)}`);
  await callOk(client, "clear_modulation", { instance: "boot", path: "logo.layer.x" });
  await callOk(client, "set_param", { instance: "boot", path: "logo.layer.x", value: 0.5 });

  // 6. set_chain { node: "logo" }: FX on just that node.
  await callOk(client, "set_chain", {
    instance: "boot",
    node: "logo",
    steps: [{ effect: "levels", params: { gain: 0 } }],
  });
  const m2 = toolJson(await callOk(client, "get_manifest", { instance: "boot" }));
  const levelsId = (m2.nodes ?? []).find((n) => n.id === "logo")?.chain[0]?.id;
  check(
    "node chain params live at logo.fx.<id>.*",
    levelsId != null && m2.params[`logo.fx.${levelsId}.gain`]?.type === "float" && m2.params[`logo.fx.${levelsId}.mix`]?.type === "float",
    `id=${levelsId}`,
  );
  const rootChain = (await bootInfo()).chain;
  check("the root chain stays empty (node chain is separate)", rootChain.length === 0);
  const darkened = await waitFor(async () => {
    const s = await callOk(client, "screenshot", { instance: "boot" });
    const c = center(s);
    return c.r < 60 ? s : null;
  }, 8_000, "gain=0 to black out the logo");
  const darkCorner = corner(darkened);
  check("levels(gain 0) on the node blacks out JUST the logo", dist(darkCorner, baseCorner) < 12, `corner Δ=${dist(darkCorner, baseCorner).toFixed(1)}`);

  // 7. NFR-5: a throwing step is rejected; previous chain + pixels keep running.
  const buildsChained = (await bootInfo()).builds;
  const broken = await client.callTool({
    name: "set_chain",
    arguments: {
      instance: "boot",
      node: "logo",
      steps: [{ id: levelsId, effect: "levels" }, { effect: "validatorBroken" }],
    },
  });
  check("a throwing node-chain step is rejected", broken.isError === true);
  const afterBroken = await bootInfo();
  check(
    "previous node chain + pixels keep running after the rejection",
    afterBroken.nodes[0].chain.length === 1 &&
      afterBroken.nodes[0].chain[0].id === levelsId &&
      afterBroken.builds === buildsChained,
  );

  // 8. Unknown node errors helpfully.
  const badNode = await client.callTool({
    name: "set_chain",
    arguments: { instance: "boot", node: "nope", steps: [] },
  });
  check(
    "set_chain on an unknown node lists the real nodes",
    badNode.isError === true && /unknown node "nope"/.test(badNode.content?.[0]?.text ?? "") && /logo/.test(badNode.content?.[0]?.text ?? ""),
  );

  // 9. restoreDefault on a node clears it (nodes have no scene default).
  await callOk(client, "set_chain", { instance: "boot", node: "logo", restoreDefault: true });
  const cleared = await bootInfo();
  check("restoreDefault clears the node chain", cleared.nodes[0].chain.length === 0);
  const back = await waitFor(async () => {
    const s = await callOk(client, "screenshot", { instance: "boot" });
    const c = center(s);
    return c.r > c.b + 40 ? s : null;
  }, 8_000, "the logo to come back");
  check("logo renders again after the clear", true, `center.r=${center(back).r.toFixed(0)}`);

  // 10. Console shows the node tree with a per-node "+ effect".
  const consolePage = await context.newPage();
  await consolePage.goto(CONSOLE_URL);
  await consolePage.waitForSelector('.tile[data-id="boot"]', { timeout: 10_000 });
  await consolePage.click('.tile[data-id="boot"]');
  await consolePage.waitForSelector('[data-node="logo"]', { timeout: 10_000 });
  check("Console param panel shows the logo node section", true);
  await consolePage.click('[data-node="logo"] .MuiAccordionSummary-root'); // expand the accordion
  await consolePage.waitForSelector('[data-fxnode="logo"] [data-fxadd]', { timeout: 10_000 });
  check("the node section carries its own + effect chain", true);
  await consolePage.screenshot({ path: join(ARTIFACTS, "layers-console-node-tree.png") });
} catch (err) {
  check("validation run completed", false, String(err));
} finally {
  console.log(
    `[timing] layers boot=${((tChecks - T_START) / 1000).toFixed(1)}s checks=${((Date.now() - tChecks) / 1000).toFixed(1)}s`,
  );
  await teardown(); // closes engine/sidecar/vite and restores the original live scene
  rmSync(BROKEN_CHAIN, { force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

// Param modulators acceptance check: attach/replace/clear via MCP, FR-7
// set_param ownership, FR-4 HMR survival + orphan reporting, FR-10
// PANIC/RESUME pause without catch-up, FR-5 BPM retune, and pixels actually
// responding to a modulated param. Runs on isolated ports like the other
// validators; pins pulse as the live scene and restores it afterwards.
import { rmSync, writeFileSync } from "node:fs";
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
} from "./_harness.mjs";
import { PNG } from "pngjs";

const SCRATCH = join(ROOT, "content", "scenes", "modtest.scene.ts");
const PORT = 5203;
const WS_PORT = 7346;
// state=off: persisted tunings (M5) must never skew validation assertions.
const OUTPUT_URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}&state=off`;

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

/** Post a human-sourced engine command from inside the output page. */
const channelPost = (page, type, args = {}) =>
  page.evaluate(
    ([t, a]) => {
      new BroadcastChannel("loom").postMessage({
        id: `vmod-${t}-${Math.random().toString(36).slice(2)}`,
        kind: "req",
        type: t,
        args: a,
      });
    },
    [type, args],
  );

const countDirChanges = (vals) => {
  let changes = 0;
  let lastSign = 0;
  for (let i = 1; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    if (Math.abs(d) < 1e-9) continue;
    const sign = Math.sign(d);
    if (lastSign !== 0 && sign !== lastSign) changes++;
    lastSign = sign;
  }
  return changes;
};

const scratchSrc = (paths) => `import { defineScene, texNode } from "@loom/runtime";
import { vec4 } from "three/tsl";

export default defineScene({
  name: "modtest",
  description: "modulator validation scratch scene",
  build(ctx) {
${paths.map((p) => `    ctx.float(${JSON.stringify(p)}, { default: 0.5, min: 0, max: 1 });`).join("\n")}
    return texNode(vec4(0.3, 0.2, 0.6, 1));
  },
});
`;

const T_START = Date.now();
let tChecks = T_START;
let teardown = async () => {};
try {
  const boot = await bootStack({
    name: "validate-modulators",
    port: PORT,
    wsPort: WS_PORT,
    url: OUTPUT_URL,
    viewport: { width: 960, height: 540 },
  });
  teardown = boot.teardown;
  const { client, output } = boot;
  tChecks = Date.now();

  const manifestVal = async (instance, path) =>
    toolJson(await callOk(client, "get_manifest", { instance })).params[path].value;

  // 1. (The MCP tool-surface assertion — the modulator tools are present and
  // set_audio is absent — moved to the shared boot-smoke suite validate-core.mjs,
  // FR-5: one canonical tool-list instead of six divergent copies.)

  // 2. A sine animates the param within its range, visible in get_manifest +
  // get_session, and the returned config carries the parsed defaults.
  const attached = toolJson(
    await callOk(client, "modulate_param", {
      instance: "boot",
      path: "trail",
      modulator: { type: "sine", periodSeconds: 2 },
    }),
  );
  check(
    "modulate_param returns the validated config",
    attached.modulator.type === "sine" && attached.modulator.phase === 0,
    JSON.stringify(attached.modulator),
  );
  const samples = [];
  for (let i = 0; i < 12; i++) {
    samples.push(await manifestVal("boot", "trail"));
    await sleep(200); // 2.2 s window: covers a full 2 s period, so a peak is guaranteed
  }
  const distinct = new Set(samples.map((v) => v.toFixed(4))).size;
  const inRange = samples.every((v) => v >= 0.5 && v <= 0.97);
  check(
    "sine modulator animates trail within [0.5, 0.97]",
    distinct >= 3 && inRange && countDirChanges(samples) >= 1,
    `${distinct} distinct, dirChanges=${countDirChanges(samples)}, [${samples.map((v) => v.toFixed(3)).join(", ")}]`,
  );
  const session1 = toolJson(await callOk(client, "get_session"));
  const bootMods = session1.instances.find((i) => i.id === "boot")?.modulators ?? [];
  check(
    "get_session reports the active modulator",
    bootMods.length === 1 && bootMods[0].path === "trail" && bootMods[0].type === "sine" && bootMods[0].error === null,
    JSON.stringify(bootMods),
  );
  const manifest1 = toolJson(await callOk(client, "get_manifest", { instance: "boot" }));
  check(
    "get_manifest carries modulator config (and null elsewhere)",
    manifest1.params.trail.modulator?.type === "sine" && manifest1.params.punch.modulator === null,
    JSON.stringify(manifest1.params.trail.modulator),
  );

  // 3. Pixels respond: a slow square on trail (feedback persistence) makes
  // the hi half visibly brighter than the lo half.
  await callOk(client, "modulate_param", {
    instance: "boot",
    path: "trail",
    modulator: { type: "square", periodSeconds: 6, lo: 0.5, hi: 0.97 },
  });
  const lumAt = async (waitMs, tag) => {
    await sleep(waitMs);
    const lums = [];
    for (let i = 0; i < 3; i++) {
      lums.push(await pageLum(output, join(ARTIFACTS, `mod-${tag}-${i}.png`)));
      await sleep(300);
    }
    return lums.reduce((a, b) => a + b, 0) / lums.length;
  };
  const lumHi = await lumAt(800, "hi"); // samples ~0.8â€“1.4 s (hi half: 0â€“3 s)
  const lumLo = await lumAt(1500, "lo"); // samples ~3.5â€“4.1 s (lo half: 3â€“6 s)
  check("square on trail visibly modulates output luminance", lumHi > lumLo, `hi=${lumHi.toFixed(2)} lo=${lumLo.toFixed(2)}`);

  // 4. FR-7: direct writes are rejected while modulated; clear releases.
  const rejected = await client.callTool({
    name: "set_param",
    arguments: { instance: "boot", path: "trail", value: 0.6 },
  });
  check(
    "set_param on a modulated path errors and names the modulator",
    rejected.isError === true && /modulated/.test(rejected.content?.[0]?.text ?? ""),
    rejected.content?.[0]?.text?.slice(0, 80),
  );
  const cleared = toolJson(await callOk(client, "clear_modulation", { instance: "boot", path: "trail" }));
  const setAfter = await client.callTool({
    name: "set_param",
    arguments: { instance: "boot", path: "trail", value: 0.6 },
  });
  const clearedAgain = toolJson(await callOk(client, "clear_modulation", { instance: "boot", path: "trail" }));
  check(
    "clear_modulation releases the param (second clear is a no-op success)",
    cleared.cleared === true && setAfter.isError !== true && clearedAgain.cleared === false,
    `cleared=${cleared.cleared} setOk=${setAfter.isError !== true} again=${clearedAgain.cleared}`,
  );

  // 5. FR-10: PANIC freezes the modulated value; RESUME continues w/o a jump.
  await callOk(client, "modulate_param", {
    instance: "boot",
    path: "trail",
    modulator: { type: "sine", periodSeconds: 12 },
  });
  await sleep(400);
  await channelPost(output, "panic");
  await waitFor(async () => ((await loomState(output)).panicked ? true : null), 5_000, "panic");
  const frozen1 = await manifestVal("boot", "trail");
  await sleep(600);
  const frozen2 = await manifestVal("boot", "trail");
  check("PANIC freezes the modulated value", frozen1 === frozen2, `${frozen1} == ${frozen2}`);
  await channelPost(output, "resume");
  await waitFor(async () => ((await loomState(output)).panicked ? null : true), 5_000, "resume");
  await sleep(250);
  const resumed = await manifestVal("boot", "trail");
  const span = 0.97 - 0.5;
  check(
    "RESUME continues from the paused phase (no catch-up jump)",
    Math.abs(resumed - frozen1) < 0.15 * span,
    `|${resumed.toFixed(3)} - ${frozen1.toFixed(3)}| < ${(0.15 * span).toFixed(3)}`,
  );
  await sleep(1500);
  const later = await manifestVal("boot", "trail");
  check("modulation keeps running after RESUME", Math.abs(later - resumed) > 0.005, `${resumed.toFixed(3)} -> ${later.toFixed(3)}`);
  await callOk(client, "clear_modulation", { instance: "boot", path: "trail" });

  // 6. FR-5 + FR-4 on a scratch scene instance.
  writeFileSync(SCRATCH, scratchSrc(["a", "b"]));
  await waitFor(async () => {
    const s = toolJson(await callOk(client, "get_session"));
    return s.availableScenes.includes("modtest") ? true : null;
  }, 15_000, "modtest scene to hot-register");
  const created = toolJson(await callOk(client, "create_instance", { scene: "modtest" }));
  const cid = created.instance;

  // FR-5: doubling BPM doubles a periodBeats modulator's rate.
  await callOk(client, "modulate_param", {
    instance: cid,
    path: "a",
    modulator: { type: "sine", periodBeats: 2 },
  });
  const sample15 = async () => {
    const vals = [];
    for (let i = 0; i < 15; i++) {
      vals.push(await manifestVal(cid, "a"));
      await sleep(100);
    }
    return vals;
  };
  const changesAt120 = countDirChanges(await sample15());
  await channelPost(output, "set_transport", { bpm: 240 });
  await waitFor(async () => ((await loomState(output)).bpm === 240 ? true : null), 5_000, "bpm 240");
  const changesAt240 = countDirChanges(await sample15());
  check(
    "periodBeats modulator retunes immediately on BPM change",
    changesAt240 > changesAt120,
    `dirChanges 120bpm=${changesAt120} 240bpm=${changesAt240}`,
  );
  await channelPost(output, "set_transport", { bpm: 120 });

  // FR-4: rebuild keeps the surviving modulator, orphans the vanished one.
  await callOk(client, "modulate_param", {
    instance: cid,
    path: "b",
    modulator: { type: "sine", periodSeconds: 1 },
  });
  writeFileSync(SCRATCH, scratchSrc(["a"])); // param "b" vanishes
  await waitFor(async () => {
    const s = toolJson(await callOk(client, "get_session"));
    const inst = s.instances.find((i) => i.id === cid);
    return inst && !inst.paramPaths.includes("b") ? inst : null;
  }, 15_000, "instance rebuild without b");
  const rebuilt = toolJson(await callOk(client, "get_session")).instances.find((i) => i.id === cid);
  const modA = rebuilt.modulators.find((m) => m.path === "a");
  const modB = rebuilt.modulators.find((m) => m.path === "b");
  check(
    "modulators survive an HMR rebuild; orphans are reported (FR-4)",
    rebuilt.status === "ok" && modA?.error === null && /vanished/.test(modB?.error ?? ""),
    `a=${JSON.stringify(modA)} b=${JSON.stringify(modB)}`,
  );
  const va = await manifestVal(cid, "a");
  await sleep(300);
  const va2 = await manifestVal(cid, "a");
  const frameBefore = (await loomState(output)).frame;
  await sleep(300);
  const frameAfter = (await loomState(output)).frame;
  check(
    "survivor still animates and the loop keeps ticking (FR-9 containment)",
    va !== va2 && frameAfter > frameBefore,
    `a ${va.toFixed(3)}->${va2.toFixed(3)}, frame ${frameBefore}->${frameAfter}`,
  );
  await callOk(client, "destroy_instance", { instance: cid });
} catch (err) {
  check("validation run completed", false, String(err));
} finally {
  console.log(
    `[timing] modulators boot=${((tChecks - T_START) / 1000).toFixed(1)}s checks=${((Date.now() - tChecks) / 1000).toFixed(1)}s`,
  );
  await teardown();
  rmSync(SCRATCH, { force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

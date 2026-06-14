// Fixtures acceptance check: deterministic input traces. record_fixture
// captures the live rack to content/state/fixtures/<name>.json; a recorded
// trace replays bit-identically (two players over the same trace agree —
// asserted here as two INSTANCES rendering identical pixels); and
// screenshot({frames:[…]}) is deterministic against a fixture: the same
// fixture + frame list returns byte-identical images on every call.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ARTIFACTS,
  STATE_DIR,
  bootStack,
  makeResults,
  toolJson,
  callOk,
  waitFor,
  backupState,
} from "./_harness.mjs";

const PORT = 5208;
const WS_PORT = 7353;
const OUTPUT_URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}&state=off`;
const FIXTURE = "valtrace";

const { results, check } = makeResults();

function toolImages(res) {
  return (res.content ?? []).filter((c) => c.type === "image").map((c) => c.data);
}

// The trace file is written under content/state/ — snapshot it for restore.
const stateBackup = backupState();

const T_START = Date.now();
let tChecks = T_START;
let teardown = async () => {};
try {
  const boot = await bootStack({
    name: "validate-fixtures",
    port: PORT,
    wsPort: WS_PORT,
    url: OUTPUT_URL,
  });
  teardown = boot.teardown;
  const { client } = boot;
  tChecks = Date.now();
  await waitFor(async () => {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    return res.isError ? null : toolJson(res);
  }, 15_000, "engine to connect to sidecar");

  // 1. Record a trace off the synthetic test audio.
  const rec = toolJson(await callOk(client, "record_fixture", { name: FIXTURE, frames: 90 }));
  check(
    "record_fixture captures the rack (90 frames, named channels, bpm)",
    rec.saved === FIXTURE && rec.frames === 90 && rec.channels.includes("kick") && rec.bpm === 120,
    JSON.stringify({ frames: rec.frames, channels: rec.channels, bpm: rec.bpm }),
  );
  const file = join(STATE_DIR, "fixtures", `${FIXTURE}.json`);
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  check(
    "the trace is plain JSON on disk with one row per frame",
    onDisk.frames.length === 90 && onDisk.frames.every((r) => r.length === onDisk.channels.length),
  );
  check(
    "the recorded test signal actually moved (kick column not flat zero)",
    onDisk.frames.some((r) => r[onDisk.channels.indexOf("kick")] > 0.05),
  );

  // 2. A fixture instance replays the trace instead of the live rack.
  const a = toolJson(await callOk(client, "create_instance", { scene: "pulse", inputs: `fixture:${FIXTURE}` }));
  check("create_instance accepts inputs:fixture:<name>", a.instance.length > 0);
  const info = toolJson(await callOk(client, "get_session", {})).instances.find((i) => i.id === a.instance);
  check("get_session reports the fixture binding", info?.fixture === FIXTURE);

  // 3. screenshot({frames}) is deterministic: same call twice → identical bytes.
  const shotA1 = await callOk(client, "screenshot", { instance: a.instance, frames: [10, 45] });
  const shotA2 = await callOk(client, "screenshot", { instance: a.instance, frames: [10, 45] });
  const [a1f10, a1f45] = toolImages(shotA1);
  const [a2f10, a2f45] = toolImages(shotA2);
  check("same fixture + frame list → byte-identical images (call twice)", a1f10 === a2f10 && a1f45 === a2f45);
  check("different frames show different pixels (sanity)", a1f10 !== a1f45);
  writeFileSync(join(ARTIFACTS, "fixtures-f10.png"), Buffer.from(a1f10, "base64"));
  writeFileSync(join(ARTIFACTS, "fixtures-f45.png"), Buffer.from(a1f45, "base64"));

  // 4. Bit-identical replay across INSTANCES: a second instance over the same
  // trace renders the very same pixels at the same frames.
  const b = toolJson(await callOk(client, "create_instance", { scene: "pulse", inputs: `fixture:${FIXTURE}` }));
  const shotB = await callOk(client, "screenshot", { instance: b.instance, frames: [10, 45] });
  const [b1f10, b1f45] = toolImages(shotB);
  check("a second instance over the same trace replays bit-identically", b1f10 === a1f10 && b1f45 === a1f45);

  // 5. The deterministic pass never disturbs the live loop or the instance.
  const after = toolJson(await callOk(client, "get_session", {})).instances.find((i) => i.id === a.instance);
  check("offline passes leave the instance untouched (builds, status)", after?.builds === 1 && after?.status === "ok");

  // 6. frames on a non-fixture instance errors helpfully.
  const bad = await client.callTool({
    name: "screenshot",
    arguments: { instance: "boot", frames: [5] },
  });
  check(
    "screenshot{frames} on a live-rack instance is refused",
    bad.isError === true && /fixture/.test(bad.content?.[0]?.text ?? ""),
  );

  // 7. Unknown fixtures error at create time.
  const nope = await client.callTool({
    name: "create_instance",
    arguments: { scene: "pulse", inputs: "fixture:doesnotexist" },
  });
  check("unknown fixture names error at create_instance", nope.isError === true);
} catch (err) {
  check("validation run completed", false, String(err));
} finally {
  console.log(
    `[timing] fixtures boot=${((tChecks - T_START) / 1000).toFixed(1)}s checks=${((Date.now() - tChecks) / 1000).toFixed(1)}s`,
  );
  await teardown(); // closes engine/sidecar/vite and restores the original live scene
  rmSync(join(STATE_DIR, "fixtures"), { recursive: true, force: true });
  for (const [rel, content] of stateBackup) {
    const file = join(STATE_DIR, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

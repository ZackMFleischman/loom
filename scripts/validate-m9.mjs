// M9 acceptance check: video sources. A scene plays a looping clip as its
// source; set_param retimes (speed), freezes (speed 0) and scrubs it live with
// NO rebuild; the clip loops past its duration; the M4 cover-scaling checks
// hold against a video source; and the loom:media middleware serves
// repo-external files (Range/206 for seeking) confined to registered roots.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const ROOTS_FILE = join(ROOT, "content", "state", "media-roots.json");
const CLIP = join(ROOT, "content", "assets", "test", "clip.mp4");
const PORT = 5207;
const WS_PORT = 7352;
const OUTPUT_URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}&state=off`;

const { results, check } = makeResults();

/** Average RGB of an MCP screenshot's center band (where testsrc2 animates). */
function bandAvg(res) {
  const img = res.content?.find((c) => c.type === "image");
  if (!img?.data) throw new Error("screenshot result carried no image data");
  const png = PNG.sync.read(Buffer.from(img.data, "base64"));
  const r0 = Math.floor(png.height * 0.2), r1 = Math.floor(png.height * 0.8);
  let r = 0, g = 0, b = 0, n = 0;
  for (let row = r0; row < r1; row++) {
    for (let col = 0; col < png.width; col += 2) {
      const i = (row * png.width + col) * 4;
      r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n++;
    }
  }
  return { r: r / n, g: g / n, b: b / n, lum: (r + g + b) / (3 * n) };
}

// The validator scene: one full-screen test clip with speed/scrub params.
const sceneSource = (urlExpr) => `import { defineScene, Signal } from "@loom/runtime";
import { video } from "../modules/sources/video";

export default defineScene({
  name: "videoval",
  description: "M9 validator: one full-screen looping test clip.",
  build(ctx) {
    const speed = ctx.float("speed", { default: 1, min: 0, max: 4 });
    const scrubbing = ctx.bool("scrubbing", { default: false });
    const scrub = ctx.float("scrub", { default: 0, min: 0, max: 1 });
    const sb = scrubbing.signal();
    return video(ctx, {
      url: ${urlExpr},
      speed: speed.signal(),
      scrubbing: new Signal((f) => (sb.get(f) ? 1 : 0)),
      scrub: scrub.signal(),
      transform: { scale: 1.2 },
    });
  },
});
`;
const REPO_CLIP_EXPR = `new URL("../assets/test/clip.mp4", import.meta.url).href`;

const originalRoots = existsSync(ROOTS_FILE) ? readFileSync(ROOTS_FILE, "utf8") : null;

// A media root OUTSIDE the repo with a copy of the clip (middleware phase).
const mediaDir = mkdtempSync(join(tmpdir(), "loom-media-"));
copyFileSync(CLIP, join(mediaDir, "clip.mp4"));
writeFileSync(ROOTS_FILE, JSON.stringify({ roots: [mediaDir] }));

const T_START = Date.now();
let tChecks = T_START;
let teardown = async () => {};
try {
  // Boot directly into the M9 video scene (not pulse) — `boot` IS the videoval.
  const boot = await bootStack({
    name: "validate-m9",
    port: PORT,
    wsPort: WS_PORT,
    url: OUTPUT_URL,
    pin: sceneSource(REPO_CLIP_EXPR),
  });
  teardown = boot.teardown;
  const { client, output } = boot;
  tChecks = Date.now();

  const buildsOf = async () =>
    toolJson(await callOk(client, "get_session", {})).instances.find((x) => x.id === "boot")?.builds;
  const shot = async () => callOk(client, "screenshot", { instance: "boot" });

  // 1. The clip plays: non-black and frames advance.
  const playing = await waitFor(async () => {
    const a = bandAvg(await shot());
    return a.lum > 10 ? a : null;
  }, 15_000, "the clip to start rendering");
  check("video scene renders non-black", true, `lum=${playing.lum.toFixed(1)}`);
  const f1 = bandAvg(await shot());
  await sleep(400);
  const f2 = bandAvg(await shot());
  check("frames advance while playing", dist(f1, f2) > 2, `Δ=${dist(f1, f2).toFixed(2)}`);
  const builds0 = await buildsOf();

  // 2. speed=0 freezes the frame — no rebuild.
  await callOk(client, "set_param", { instance: "boot", path: "speed", value: 0 });
  await sleep(300); // let the pause land
  const p1 = bandAvg(await shot());
  await sleep(500);
  const p2 = bandAvg(await shot());
  check("speed=0 freezes the frame", dist(p1, p2) < 1.5, `Δ=${dist(p1, p2).toFixed(2)}`);
  check("retiming caused NO rebuild", (await buildsOf()) === builds0);

  // 3. Scrubbing seeks: two scrub positions show different frames.
  await callOk(client, "set_param", { instance: "boot", path: "scrubbing", value: true });
  await callOk(client, "set_param", { instance: "boot", path: "scrub", value: 0.1 });
  const s1 = await waitFor(async () => {
    const s = bandAvg(await shot());
    return s.lum > 10 ? s : null;
  }, 8_000, "scrub head to land at 0.1");
  await callOk(client, "set_param", { instance: "boot", path: "scrub", value: 0.85 });
  const s2 = await waitFor(async () => {
    const s = bandAvg(await shot());
    return dist(s1, s) > 2 ? s : null;
  }, 8_000, "scrub head to land at 0.85").catch(async () => bandAvg(await shot()));
  check("scrub moves the playhead (different frames)", dist(s1, s2) > 2, `Δ=${dist(s1, s2).toFixed(2)}`);
  check("scrubbing caused NO rebuild", (await buildsOf()) === builds0);

  // 4. Back to playing; the 2 s clip loops past its duration.
  await callOk(client, "set_param", { instance: "boot", path: "scrubbing", value: false });
  await callOk(client, "set_param", { instance: "boot", path: "speed", value: 1 });
  await sleep(2600); // > clip duration: only a looping clip still animates
  const l1 = bandAvg(await shot());
  await sleep(400);
  const l2 = bandAvg(await shot());
  check("clip loops past its duration (still animating)", dist(l1, l2) > 2 && l1.lum > 10, `Δ=${dist(l1, l2).toFixed(2)}`);

  // 5. M4 cover-scaling checks hold against a video source.
  const at169 = await output.evaluate(() => {
    const c = document.querySelector("#out");
    return { w: c.width, h: c.height, fit: getComputedStyle(c).objectFit };
  });
  check(
    "render buffer fixed 1920x1080 with object-fit: cover (video live)",
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
  const cover = bandAvg(await shot());
  check(
    "non-16:9 window: buffer unchanged, canvas fills, video alive",
    at43.w === 1920 && at43.h === 1080 && at43.cw === 960 && at43.ch === 720 && cover.lum > 10,
    `buffer ${at43.w}x${at43.h} client ${at43.cw}x${at43.ch} lum ${cover.lum.toFixed(1)}`,
  );
  await output.screenshot({ path: join(ARTIFACTS, "m9-1-video-cover.png") }).catch(() => {});

  // 6. loom:media middleware: Range/206, root confinement, 404.
  const base = `http://localhost:${PORT}/loom/media?p=`;
  const extClip = encodeURIComponent(join(mediaDir, "clip.mp4"));
  const ranged = await fetch(base + extClip, { headers: { range: "bytes=0-99" } });
  const body = Buffer.from(await ranged.arrayBuffer());
  check(
    "media middleware serves Range requests (206 + content-range)",
    ranged.status === 206 && body.length === 100 && /^bytes 0-99\/\d+$/.test(ranged.headers.get("content-range") ?? ""),
    `status=${ranged.status} len=${body.length} content-range=${ranged.headers.get("content-range")}`,
  );
  const full = await fetch(base + extClip);
  check("media middleware serves full files (200, video/mp4)", full.status === 200 && full.headers.get("content-type") === "video/mp4");
  const outside = await fetch(base + encodeURIComponent(CLIP)); // repo path, not a registered root
  check("paths outside registered roots are refused (403)", outside.status === 403, `status=${outside.status}`);
  const missing = await fetch(base + encodeURIComponent(join(mediaDir, "nope.mp4")));
  check("missing files under a root are 404", missing.status === 404, `status=${missing.status}`);

  // 7. End to end: a scene plays the EXTERNAL clip through mediaUrl().
  writeFileSync(SCENE, sceneSource(`"${(base + extClip).replace(`http://localhost:${PORT}`, "")}"`));
  const ext = await waitFor(async () => {
    const s = toolJson(await callOk(client, "get_session", {}));
    const boot = s.instances.find((x) => x.id === "boot");
    if (boot == null || boot.builds <= builds0 || boot.status !== "ok") return null;
    const a = bandAvg(await shot());
    return a.lum > 10 ? a : null;
  }, 20_000, "the external clip to hot-swap in and render");
  check("a scene plays a repo-external clip via the media middleware", true, `lum=${ext.lum.toFixed(1)}`);
} catch (err) {
  check("validation run completed", false, String(err));
} finally {
  console.log(
    `[timing] m9 boot=${((tChecks - T_START) / 1000).toFixed(1)}s checks=${((Date.now() - tChecks) / 1000).toFixed(1)}s`,
  );
  await teardown(); // closes engine/sidecar/vite and restores the original live scene
  if (originalRoots != null) writeFileSync(ROOTS_FILE, originalRoots);
  else rmSync(ROOTS_FILE, { force: true });
  rmSync(mediaDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

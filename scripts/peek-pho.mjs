// Visual peek at pho-nebula through the real MCP agent surface (not a validator).
// Spawns the sidecar on an isolated WS port, opens a headless Output page
// against the ALREADY-RUNNING dev server (port 5173), then uses MCP tools:
// get_session -> create_instance("pho-nebula") -> screenshot. Live output untouched.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUTDIR = join(ROOT, "artifacts", "peek");
const WS_PORT = 7343; // isolated: the live session holds 7341
const URL = `http://localhost:5173/?audio=test&bpm=120&ws=${WS_PORT}&state=off&res=640x360`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toolJson = (res) => JSON.parse(res.content?.find((c) => c.type === "text")?.text ?? "null");

mkdirSync(OUTDIR, { recursive: true });

const client = new Client({ name: "peek-pho", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "packages/sidecar/src/index.ts"],
  cwd: ROOT,
  env: { ...process.env, LOOM_WS_PORT: String(WS_PORT) },
  stderr: "pipe",
});

let browser;
try {
  await client.connect(transport);
  transport.stderr?.on("data", (d) => process.stderr.write(`[sidecar] ${d}`));

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.goto(URL);
  await page.waitForFunction(
    () => /\d+ fps/.test(document.querySelector("#fps")?.textContent ?? ""),
    null,
    { timeout: 20_000 },
  );
  await sleep(1000); // let the engine connect to the sidecar WS

  const session = toolJson(await client.callTool({ name: "get_session", arguments: {} }));
  console.log(`scenes: ${session.availableScenes?.join(", ")}`);
  if (!session.availableScenes?.includes("pho-nebula")) throw new Error("pho-nebula not in catalog");

  const created = toolJson(
    await client.callTool({ name: "create_instance", arguments: { scene: "pho-nebula", id: "pho-peek" } }),
  );
  console.log(`created: ${JSON.stringify(created)}`);
  await sleep(2500); // let broth/steam/kicks accumulate

  const save = async (name) => {
    let img;
    for (let attempt = 1; attempt <= 6 && !img; attempt++) {
      const fps = await page.evaluate(() => document.querySelector("#fps")?.textContent ?? "?");
      const res = await client.callTool({ name: "screenshot", arguments: { instance: "pho-peek" } });
      img = res.content?.find((c) => c.type === "image");
      if (!img) console.log(`attempt ${attempt} (${fps}): ${JSON.stringify(res.content)}`);
    }
    if (!img) throw new Error(`screenshot ${name}: no image after 3 attempts`);
    writeFileSync(join(OUTDIR, name), Buffer.from(img.data, "base64"));
    console.log(`saved ${name}`);
  };

  await save("pho-1.png");
  await sleep(3000);
  await save("pho-2.png");

  const set = (path, value) =>
    client.callTool({ name: "set_param", arguments: { instance: "pho-peek", path, value } });
  await set("garnish.count", 16);
  await set("garnish.size", 0.1);
  await sleep(2500);
  await save("pho-3-loaded.png");

  const sess2 = toolJson(await client.callTool({ name: "get_session", arguments: {} }));
  const inst = sess2.instances?.find((i) => i.id === "pho-peek");
  console.log(`instance state: ${JSON.stringify(inst)}`);

  await client.callTool({ name: "destroy_instance", arguments: { instance: "pho-peek" } });
  console.log("destroyed pho-peek");
} catch (e) {
  console.error(String(e));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await client.close().catch(() => {});
}

// Core acceptance check (Phase 2 consolidation): the boot smoke + the SINGLE
// canonical MCP tool-surface assertion. Booting the full stack is the dominant
// cost of every validator (Phase 0: ~4-5s boot vs the actual checks), and the
// "engine reaches FPS / get_session reflects the live scene / a screenshot is
// non-black" smoke plus the exact MCP tool-list were re-proven at the top of
// every full-stack suite. This suite proves them ONCE so the others don't have to.
//
// The tool-surface check (the agent-facing MCP tools, and the deliberate ABSENCE
// of human-only verbs: set_audio, midi, and the panic/arm/designate family) used
// to be duplicated in m3/m4/m5/modulators/panic. It now lives here, in one place
// (FR-5) — a new MCP tool updates ONE list.
import { join } from "node:path";
import {
  ARTIFACTS,
  bootStack,
  makeResults,
  toolJson,
  callOk,
  avgColor,
} from "./_harness.mjs";

const PORT = 5198;
const WS_PORT = 7341 + 100; // 7441 — isolated, never a live session's default 7341
const OUTPUT_URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}&state=off`;

const { results, check } = makeResults("core");

const T_START = Date.now();
let tChecks = T_START;
let teardown = async () => {};
try {
  const boot = await bootStack({
    name: "validate-core",
    port: PORT,
    wsPort: WS_PORT,
    url: OUTPUT_URL,
    viewport: { width: 960, height: 540 },
  });
  teardown = boot.teardown;
  const { client, output } = boot;
  tChecks = Date.now();

  // ---- Boot smoke: the stack is alive and reflects the pinned live scene ----

  // 1. Engine reached FPS (bootStack waited on #fps + the get_session handshake).
  const session = toolJson(await callOk(client, "get_session", {}));
  check(
    "boot: get_session reflects the live pulse scene",
    session.live === "boot" && session.scene === "pulse" && session.audioMode === "test",
    `live=${session.live} scene=${session.scene} audio=${session.audioMode}`,
  );
  check(
    "boot: Output window reports a live framerate",
    await output.evaluate(() => (window.__loom?.fps ?? 0) > 0),
    `fps=${await output.evaluate(() => window.__loom?.fps ?? 0)}`,
  );

  // 2. A screenshot is real, non-black pixels.
  const shot = await callOk(client, "screenshot", {});
  const c = avgColor(shot);
  const lum = (c.r + c.g + c.b) / 3;
  await output.screenshot({ path: join(ARTIFACTS, "core-boot.png") }).catch(() => {});
  check("boot: screenshot is non-black", lum > 2, `lum=${lum.toFixed(1)}`);

  // ---- Canonical MCP tool surface (FR-5: the ONE place this is asserted) ----

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();

  // The agent-facing tools every milestone since M3 must expose. Subset check
  // (.every includes) — later milestones add tools; this list is the floor.
  // Absorbs the identical assertions removed from m3/m4/m5/modulators.
  check(
    "MCP exposes the agent tool surface (modulators, chains, projects), no set_audio",
    [
      "clear_modulation", "commit", "create_instance", "destroy_instance", "get_manifest",
      "get_session", "list_projects", "load_project", "modulate_param", "record_fixture", "save_chain",
      "save_project", "screenshot", "search_content", "set_chain", "set_modulation_enabled", "set_param",
      "stage", "unstage",
    ].every((t) => tools.includes(t)) && !tools.includes("set_audio"),
    tools.join(", "),
  );

  // MIDI learn is Console-only — no agent path (absorbed from m5).
  check(
    "MCP exposes no MIDI tools (MIDI-learn is human-only)",
    !tools.some((t) => /midi/i.test(t)),
    tools.filter((t) => /midi/i.test(t)).join(", ") || "(none)",
  );

  // The panic path is human-only: no trigger/clear/arm/designate tools (absorbed
  // from panic). The agent can OBSERVE panic state via get_session, never touch it.
  check(
    "MCP exposes no panic/arm/designate tools (human-only emergency hatch)",
    !tools.includes("panic") &&
      !tools.includes("resume") &&
      !tools.includes("arm_panic_mode") &&
      !tools.includes("set_panic_instance"),
    tools.filter((t) => /panic|arm|designate|resume/i.test(t)).join(", ") || "(none)",
  );
} catch (err) {
  check("validation run completed", false, String(err));
} finally {
  console.log(
    `[timing] core boot=${((tChecks - T_START) / 1000).toFixed(1)}s checks=${((Date.now() - tChecks) / 1000).toFixed(1)}s`,
  );
  await teardown();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

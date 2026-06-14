#!/usr/bin/env node
// pnpm pack:add <git-url|path> [--name <name>] [--ref <branch|tag|sha>]
// pnpm pack:update [<name>]   (re-pins all packs, or just one)
//
// Installs a module pack into the gitignored packs/ directory and records it in
// content/state/packs.json (the committed registry — the single source of truth
// for which packs a project depends on). Mirrors the media-roots registration
// idiom: the checkout is local scratch, the JSON is what travels in git.
//
// - A git URL is `git clone`d into packs/<name>/ and pinned to the resolved
//   commit SHA (so `pack:update` can show drift and re-pin).
// - A local path is SYMLINKED into packs/<name>/ (developing a pack alongside
//   the host repo) and recorded source: "<abs path>", pin: null.
//
// Trust: a pack is arbitrary TypeScript executed in the engine — the SAME trust
// level as editing content/ yourself. We DON'T sandbox (documented in
// DECISIONS.md); typecheck is the real gate, loomApi is the fast hint.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import {
  PACK_NAME_RE,
  packsDir,
  readPackManifest,
  readRegistry,
  writeRegistry,
} from "./lib/packs.mjs";

const HOST_API = "1"; // the runtime API generation this host implements.

function fail(msg) {
  console.error(`pack: ${msg}`);
  process.exit(1);
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function isGitUrl(s) {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(s) || s.endsWith(".git");
}

/** Pull `--flag value` pairs out of argv, returning { positionals, flags }. */
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) flags[a.slice(2)] = argv[++i];
    else positionals.push(a);
  }
  return { positionals, flags };
}

/** Fallback name from a source path/URL when no manifest name is available. */
function basenameOf(source) {
  return path
    .basename(source.replace(/\.git$/, "").replace(/[\\/]+$/, ""))
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
}

/**
 * The canonical pack name — the namespace authors publish under and the
 * marketplace keys on. Precedence: explicit --name > loom-pack.json `name` >
 * source basename. The manifest is authoritative so packs/<name> and the
 * "<pack>/<item>" ids match what the author declared (not an accident of which
 * folder/URL they happened to clone from).
 */
function deriveName(flagName, manifest, source) {
  if (flagName) return flagName;
  if (manifest?.name) return manifest.name;
  return basenameOf(source);
}

function checkApi(manifest, name) {
  if (!manifest) {
    console.warn(
      `pack: ${name} has no loom-pack.json — installing anyway (typecheck is the real gate).`,
    );
    return;
  }
  if (manifest.loomApi && !satisfiesApi(manifest.loomApi, HOST_API)) {
    console.warn(
      `pack: ${name} declares loomApi "${manifest.loomApi}" but this host implements "${HOST_API}". ` +
        `This is a HINT, not a gate — run \`pnpm typecheck\` to confirm compatibility.`,
    );
  }
}

/** Cheap "^1"/"1.x"/"1" caret-major check; typecheck is the true compatibility test. */
function satisfiesApi(declared, host) {
  const major = String(declared).replace(/[^\d]*(\d+).*/, "$1");
  return major === String(host).replace(/[^\d]*(\d+).*/, "$1");
}

function add(argv) {
  const { positionals, flags } = parseArgs(argv);
  const source = positionals[0];
  if (!source) fail("usage: pnpm pack:add <git-url|path> [--name <name>] [--ref <ref>]");

  const reg = readRegistry();
  mkdirSync(packsDir, { recursive: true });

  let entry;
  if (isGitUrl(source)) {
    const ref = flags.ref;
    // Clone to a temp dir FIRST so we can read loom-pack.json's `name` and adopt
    // it as the canonical namespace, then move into packs/<name>.
    const tmp = path.join(packsDir, `.tmp-clone-${Date.now()}`);
    console.log(`pack: cloning ${source}${ref ? ` @ ${ref}` : ""}`);
    git(["clone", "--depth", "1", ...(ref ? ["--branch", ref] : []), source, tmp]);
    // Record the branch we're tracking so pack:update can fetch/reset it
    // explicitly (origin/HEAD is unreliable on a shallow clone).
    let branch;
    try {
      branch = git(["rev-parse", "--abbrev-ref", "HEAD"], tmp);
    } catch {
      branch = ref ?? null;
    }
    const manifest = readPackManifest(tmp);
    const name = settleName(flags.name, manifest, source, reg);
    const dest = path.join(packsDir, name);
    if (existsSync(dest)) {
      rmSync(tmp, { recursive: true, force: true });
      fail(`packs/${name} already exists on disk — remove it first.`);
    }
    renameSync(tmp, dest);
    const pin = git(["rev-parse", "HEAD"], dest);
    entry = { name, source, pin, ...(branch ? { branch } : {}) };
    checkApi(manifest, name);
    if (manifest?.loomApi) entry.loomApi = manifest.loomApi;
  } else {
    const abs = path.resolve(source);
    if (!existsSync(abs)) fail(`local path does not exist: ${abs}`);
    const manifest = readPackManifest(abs); // read from source directly (no checkout yet)
    const name = settleName(flags.name, manifest, source, reg);
    const dest = path.join(packsDir, name);
    if (existsSync(dest)) fail(`packs/${name} already exists on disk — remove it first.`);
    console.log(`pack: linking ${abs} → packs/${name}`);
    symlinkSync(abs, dest, "junction"); // junction works without admin on Windows
    entry = { name, source: abs, pin: null };
    checkApi(manifest, name);
    if (manifest?.loomApi) entry.loomApi = manifest.loomApi;
  }

  reg.packs.push(entry);
  writeRegistry(reg);
  console.log(
    `pack: registered "${entry.name}"${entry.pin ? ` @ ${entry.pin.slice(0, 10)}` : " (linked)"}. ` +
      `Run \`pnpm typecheck\` to verify and regenerate the catalog (content appears as "${entry.name}/<item>").`,
  );
}

/** Resolve + validate the canonical name and guard against a duplicate registration. */
function settleName(flagName, manifest, source, reg) {
  const name = deriveName(flagName, manifest, source);
  if (!PACK_NAME_RE.test(name)) {
    fail(`invalid pack name "${name}" — must be letters-first, [a-z][a-zA-Z0-9-]*. Pass --name.`);
  }
  if (reg.packs.some((p) => p.name === name)) {
    fail(`pack "${name}" is already registered — use \`pnpm pack:update ${name}\` or remove it first.`);
  }
  return name;
}

function update(argv) {
  const { positionals } = parseArgs(argv);
  const only = positionals[0];
  const reg = readRegistry();
  const targets = only ? reg.packs.filter((p) => p.name === only) : reg.packs;
  if (only && targets.length === 0) fail(`no registered pack "${only}".`);
  if (targets.length === 0) {
    console.log("pack: nothing to update (no packs registered).");
    return;
  }

  for (const entry of targets) {
    const dest = path.join(packsDir, entry.name);
    if (!existsSync(dest)) {
      console.warn(`pack: ${entry.name} not checked out — skipping (run pack:add to install).`);
      continue;
    }
    // Symlinked local packs track their source directory live — nothing to pin.
    if (lstatSync(dest).isSymbolicLink() || entry.pin == null) {
      console.log(`pack: ${entry.name} is linked (local) — always live, no pin.`);
      continue;
    }
    console.log(`pack: updating ${entry.name} (${entry.source})`);
    // origin/HEAD is unreliable on a shallow clone — fetch/reset the explicit
    // branch we recorded at add time (fall back to the clone's current branch).
    let branch = entry.branch;
    if (!branch) {
      try {
        branch = git(["rev-parse", "--abbrev-ref", "HEAD"], dest);
      } catch {
        branch = "HEAD";
      }
    }
    git(["fetch", "--depth", "1", "origin", branch], dest);
    git(["reset", "--hard", "FETCH_HEAD"], dest);
    const newPin = git(["rev-parse", "HEAD"], dest);
    if (newPin !== entry.pin) {
      console.log(`pack: ${entry.name} ${entry.pin.slice(0, 10)} → ${newPin.slice(0, 10)}`);
      entry.pin = newPin;
    } else {
      console.log(`pack: ${entry.name} already at latest (${newPin.slice(0, 10)}).`);
    }
    const manifest = readPackManifest(dest);
    checkApi(manifest, entry.name);
    if (manifest?.loomApi) entry.loomApi = manifest.loomApi;
  }
  writeRegistry(reg);
  console.log("pack: registry updated. Run `pnpm typecheck` to verify.");
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "add") add(rest);
else if (cmd === "update") update(rest);
else fail(`unknown command "${cmd ?? ""}" — expected "add" or "update".`);

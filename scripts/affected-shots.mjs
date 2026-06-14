// affected-shots.mjs — decide which screenshots a PR's diff warrants, so the
// Cloudflare preview comment shows what actually changed instead of always the
// boot scene. Emits ready-to-use shoot.mjs arguments on stdout (scene names,
// plus `--console` when console UI changed); a human note goes to stderr.
//
//   node scripts/affected-shots.mjs [--base <ref>] [--cap <n>] [--changed <f>...]
//
// --base <ref>     git ref to diff HEAD against (default: $GITHUB_BASE_REF
//                  prefixed with origin/, else "origin/main"). Ignored if
//                  --changed is given.
// --cap <n>        max scenes to shoot (default 6). Software GL in CI is slow.
// --changed <f>... explicit changed-file list (skips git; used by tests/manual).
//
// The decision logic is pure and unit-tested (affected-shots.test.mjs); only the
// CLI at the bottom touches git and the filesystem.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.resolve(HERE, "../content");

/** Normalize a diff path to forward-slash posix (the diff runs at the repo root). */
export function repoRel(p) {
  return p.replace(/\\/g, "/");
}

/** Console cockpit sources — any change here is worth a console screenshot. */
export function isConsolePath(rel) {
  return rel.startsWith("packages/engine-app/src/ui/");
}

/**
 * Content that effectively fans out to every scene (the rack, the boot pointer,
 * test fixtures) — too broad to pick scenes from, so the caller falls back to
 * the boot scene rather than shooting the whole library.
 */
export function isGlobalContent(rel) {
  return (
    rel === "content/inputs.ts" ||
    rel === "content/scenes/live.scene.ts" ||
    rel.startsWith("content/test/")
  );
}

/** "content/scenes/<name>.scene.ts" → "<name>"; null for the live pointer or non-scenes. */
export function sceneNameFromPath(rel) {
  const m = /^content\/scenes\/(.+)\.scene\.ts$/.exec(rel);
  if (!m || m[1] === "live") return null;
  return m[1];
}

/** The file plus everything it transitively imports (cycle-safe). */
export function transitiveClosure(file, importsOf) {
  const seen = new Set();
  const stack = [file];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const dep of importsOf(f)) if (!seen.has(dep)) stack.push(dep);
  }
  return seen;
}

/**
 * Pick the screenshots a changed-file set warrants.
 *   changed     repo-relative-ish paths (normalized internally)
 *   sceneFiles  Map<sceneName, "content/scenes/<name>.scene.ts">
 *   importsOf   forward import graph: (file) => [imported files]
 *   cap         max scenes (default 6)
 * → { scenes: string[] (sorted, directly-changed first), console, truncated }
 */
export function selectShots({ changed, sceneFiles, importsOf, cap = 6 }) {
  const rels = changed.map(repoRel);
  const console = rels.some(isConsolePath);

  // Content files that should drive scene selection (skip global/broad ones).
  const relevant = new Set(rels.filter((r) => r.startsWith("content/") && !isGlobalContent(r)));

  const direct = new Set(); // scenes whose own file changed — priority for the cap
  for (const r of rels) {
    const name = sceneNameFromPath(r);
    if (name && sceneFiles.has(name)) direct.add(name);
  }

  const affected = new Set(direct);
  if (relevant.size > 0) {
    for (const [name, file] of sceneFiles) {
      if (affected.has(name)) continue;
      const closure = transitiveClosure(file, importsOf);
      for (const f of closure) {
        if (relevant.has(f)) {
          affected.add(name);
          break;
        }
      }
    }
  }

  // Directly-changed scenes first (they're the focus), then the fan-out, each sorted.
  const directSorted = [...direct].sort();
  const fanout = [...affected].filter((n) => !direct.has(n)).sort();
  const ordered = [...directSorted, ...fanout];
  const scenes = ordered.slice(0, cap);
  return { scenes, console, truncated: ordered.length > scenes.length };
}

// ── CLI: build the real import graph from disk, diff against the base ref ─────

/** List content/*.ts(x) files as loom-relative posix paths. */
function listContentFiles() {
  return readdirSync(CONTENT, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && /\.tsx?$/.test(d.name))
    .map((d) => repoRel(path.relative(path.resolve(CONTENT, ".."), path.join(d.parentPath, d.name))));
}

/** Resolve a relative import spec from `fromRel` to a loom-relative content file, or null. */
function resolveImport(fromRel, spec, exists) {
  if (!spec.startsWith(".")) return null; // bare specifier (@loom/runtime, three, …)
  const baseDir = path.posix.dirname(fromRel);
  const joined = path.posix.normalize(path.posix.join(baseDir, spec));
  for (const cand of [`${joined}.ts`, `${joined}.tsx`, `${joined}/index.ts`]) {
    if (exists.has(cand)) return cand;
  }
  return null;
}

/** Forward import graph over content/: file → [imported content files]. */
function buildGraph(files) {
  const exists = new Set(files);
  const graph = new Map();
  const importRe = /(?:import|export)[^'"]*?\bfrom\s*["']([^"']+)["']/g;
  for (const rel of files) {
    const src = readFileSync(path.resolve(CONTENT, "..", rel), "utf8");
    const deps = new Set();
    for (const m of src.matchAll(importRe)) {
      const resolved = resolveImport(rel, m[1], exists);
      if (resolved) deps.add(resolved);
    }
    graph.set(rel, [...deps]);
  }
  return graph;
}

function sceneFileMap(files) {
  const map = new Map();
  for (const rel of files) {
    const name = sceneNameFromPath(rel);
    if (name) map.set(name, rel);
  }
  return map;
}

function parseArgs(argv) {
  const out = { base: null, cap: 6, changed: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") out.base = argv[++i];
    else if (argv[i] === "--cap") out.cap = Number(argv[++i]) || 6;
    else if (argv[i] === "--changed") {
      out.changed = argv.slice(i + 1);
      break;
    }
  }
  return out;
}

function gitChangedFiles(base) {
  const ref = base ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main");
  // base...HEAD = changes on this branch since it diverged (merge-base diff).
  const out = execFileSync("git", ["diff", "--name-only", `${ref}...HEAD`], {
    cwd: path.resolve(CONTENT, ".."),
    encoding: "utf8",
  });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

let _graph = null;
function buildGraphMemo(files) {
  _graph ??= buildGraph(files);
  return _graph;
}

// Run only as a CLI (not when imported by the test).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { base, cap, changed } = parseArgs(process.argv.slice(2));
  let changedFiles = changed;
  if (!changedFiles) {
    try {
      changedFiles = gitChangedFiles(base);
    } catch (err) {
      process.stderr.write(`[affected-shots] git diff failed (${err.message}); falling back to boot scene\n`);
      process.exit(0); // no args → shoot.mjs shoots the boot scene
    }
  }
  const files = listContentFiles();
  const result = selectShots({
    changed: changedFiles,
    sceneFiles: sceneFileMap(files),
    importsOf: (f) => buildGraphMemo(files).get(f) ?? [],
    cap,
  });
  const args = [...result.scenes, ...(result.console ? ["--console"] : [])];
  if (result.scenes.length === 0 && !result.console) {
    process.stderr.write("[affected-shots] no scene/console changes — boot scene fallback\n");
  } else {
    process.stderr.write(
      `[affected-shots] scenes: ${result.scenes.join(", ") || "(none)"}` +
        `${result.console ? " · console" : ""}${result.truncated ? " · (capped)" : ""}\n`,
    );
  }
  process.stdout.write(args.join(" "));
}

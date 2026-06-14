// Generates content/CATALOG.md — a one-line-per-item index of every module and
// scene, extracted from the defineModule/defineScene metadata via the TS AST
// (no Node import of three). Runs standalone (`pnpm catalog`) and as part of
// `pnpm typecheck`, so it regenerates automatically. `--check` exits 1 if the
// committed file is stale instead of writing.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { discoverPacks, listPackFiles, namespacedId } from "./lib/packs.mjs";

const contentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../content");
const catalogPath = path.join(contentDir, "CATALOG.md");
const KIND_ORDER = ["control", "source", "effect", "geo", "output"];

function parse(file) {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

function* walk(node) {
  yield node;
  for (const child of node.getChildren()) yield* walk(child);
}

/** First object-literal argument of the first `name(...)` call in the file. */
function callArgObject(sourceFile, name) {
  for (const node of walk(sourceFile)) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText() === name &&
      node.arguments.length > 0 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      return node.arguments[0];
    }
  }
  return undefined;
}

function prop(obj, key) {
  return obj.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === key)
    ?.initializer;
}

function str(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

function strArray(node) {
  return node && ts.isArrayLiteralExpression(node)
    ? node.elements.map((e) => str(e)).filter(Boolean)
    : [];
}

function listFiles(dir, filter) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && filter(d.name))
    .map((d) => path.join(d.parentPath, d.name))
    .sort();
}

/** Every named rack channel the file consumes via ctx.input("..."). */
function inputsConsumed(sourceFile) {
  const names = new Set();
  for (const node of walk(sourceFile)) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText() === "ctx" &&
      node.expression.name.text === "input"
    ) {
      const name = str(node.arguments[0]);
      if (name) names.add(name);
    }
  }
  return [...names];
}

/**
 * Extract one module's catalog row from a file. `pack` namespaces the name as
 * "<pack>/<name>" (pack content); undefined leaves it bare (local content).
 */
function moduleRow(file, pack) {
  const sourceFile = parse(file);
  const meta = callArgObject(sourceFile, "defineModule");
  if (!meta) return null;
  const bare = str(prop(meta, "name")) ?? path.basename(file, ".ts");
  return {
    name: pack ? namespacedId(pack, bare) : bare,
    pack: pack ?? null,
    kind: str(prop(meta, "kind")) ?? "?",
    description: str(prop(meta, "description")) ?? "",
    tags: strArray(prop(meta, "tags")),
    example: str(prop(meta, "example")) ?? "",
    // Declares chainParams → selectable as an FX-chain step (set_chain / picker).
    chainable: prop(meta, "chainParams") != null,
    inputs: inputsConsumed(sourceFile),
  };
}

/** Extract one scene's catalog row from a file (namespaced like moduleRow). */
function sceneRow(file, pack, liveTarget) {
  const sourceFile = parse(file);
  const meta = callArgObject(sourceFile, "defineScene");
  if (!meta) return null;
  const bare = str(prop(meta, "name")) ?? path.basename(file, ".scene.ts");
  const inputs = inputsConsumed(sourceFile);
  const params = [];
  for (const node of walk(sourceFile)) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText() === "ctx" &&
      ["float", "int", "bool"].includes(node.expression.name.text)
    ) {
      const name = str(node.arguments[0]);
      if (name) params.push(name);
    }
  }
  return {
    name: pack ? namespacedId(pack, bare) : bare,
    pack: pack ?? null,
    description: str(prop(meta, "description")) ?? "",
    tags: strArray(prop(meta, "tags")),
    params,
    inputs,
    // Only a local scene can be the boot/live target (live.scene.ts is local).
    live: !pack && path.basename(file, ".scene.ts") === liveTarget,
  };
}

const packs = discoverPacks();

const modules = [
  ...listFiles(path.join(contentDir, "modules"), (n) => n.endsWith(".ts") && n !== "index.ts").map(
    (f) => moduleRow(f, undefined),
  ),
  ...packs.flatMap((p) =>
    listPackFiles(p.dir, "modules", (n) => n.endsWith(".ts") && n !== "index.ts").map((f) =>
      moduleRow(f, p.name),
    ),
  ),
].filter(Boolean);

const liveTarget = /from\s+"\.\/(.+)\.scene"/.exec(
  readFileSync(path.join(contentDir, "scenes/live.scene.ts"), "utf8"),
)?.[1];

const scenes = [
  ...listFiles(
    path.join(contentDir, "scenes"),
    (n) => n.endsWith(".scene.ts") && n !== "live.scene.ts",
  ).map((f) => sceneRow(f, undefined, liveTarget)),
  ...packs.flatMap((p) =>
    listPackFiles(p.dir, "scenes", (n) => n.endsWith(".scene.ts") && n !== "live.scene.ts").map(
      (f) => sceneRow(f, p.name, liveTarget),
    ),
  ),
].filter(Boolean);

const lines = [
  "# Content catalog",
  "",
  "<!-- Generated by scripts/build-catalog.mjs (runs with `pnpm typecheck` / `pnpm catalog`). Do not edit by hand. -->",
  "",
  "## Modules (`content/modules/`)",
];
for (const kind of KIND_ORDER) {
  const ofKind = modules.filter((m) => m.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
  if (!ofKind.length) continue;
  lines.push("", `### ${kind}`);
  for (const m of ofKind) {
    const chain = m.chainable ? " ⛓chainable" : "";
    const inputs = m.inputs.length ? ` ⚡inputs: ${m.inputs.join(", ")}` : "";
    lines.push(`- **${m.name}** — ${m.description} \`${m.example}\` _[${m.tags.join(", ")}]_${chain}${inputs}`);
  }
}
lines.push("", "## Scenes (`content/scenes/`)", "");
for (const s of scenes.sort((a, b) => a.name.localeCompare(b.name))) {
  const live = s.live ? " **(live)**" : "";
  const inputs = s.inputs.length ? ` ⚡inputs: ${s.inputs.join(", ")}` : "";
  lines.push(`- **${s.name}**${live} — ${s.description} params: ${s.params.join(", ") || "none"} _[${s.tags.join(", ")}]_${inputs}`);
}
// Only emitted when packs are installed, so a pack-free repo's CATALOG.md is
// byte-for-byte what it was before this feature (local-content behavior frozen).
if (packs.length) {
  lines.push("", "## Installed packs (`packs/` · `content/state/packs.json`)", "");
  for (const p of packs) {
    const ver = p.manifest?.version ? ` v${p.manifest.version}` : "";
    const api = p.loomApi ? ` loomApi:${p.loomApi}` : "";
    const pin = p.pin ? ` @${p.pin.slice(0, 10)}` : " (linked)";
    const desc = p.manifest?.description ? ` — ${p.manifest.description}` : "";
    lines.push(`- **${p.name}**${ver}${api}${pin}${desc} \`<${p.name}/…>\``);
  }
}
const output = lines.join("\n") + "\n";

if (process.argv.includes("--check")) {
  let existing = "";
  try {
    existing = readFileSync(catalogPath, "utf8");
  } catch {}
  if (existing !== output) {
    console.error("content/CATALOG.md is stale — run `pnpm catalog`.");
    process.exit(1);
  }
} else {
  writeFileSync(catalogPath, output);
  console.log(`content/CATALOG.md: ${modules.length} modules, ${scenes.length} scenes.`);
}

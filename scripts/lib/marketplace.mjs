// Shared marketplace-index helpers (Node ESM, no `three` / no browser deps).
//
// The marketplace is the DISCOVERY layer on top of module-packs: module-packs
// lets you DEPEND on a pack you already know the URL of; the marketplace lets you
// FIND one you don't. This module is the single source of truth (Node side) for:
//   - the FROZEN index.json schema (FR-1) + its validator,
//   - reading the index from a local path OR a fetched URL (NFR-1: the schema is
//     the stable seam; the transport is swappable),
//   - ranking entries against a query + tags (FR-2/FR-3 share one ranker so the
//     agent tool and the CLI return the SAME order),
//   - the `pack:add <gitUrl>` install hint (FR-4: discovery hands off to
//     module-packs, it does not reimplement loading).
//
// It is consumed by scripts/pack.mjs (pack:search / pack:fork) and
// scripts/marketplace.test.mjs. The sidecar mirrors the schema + ranker in
// packages/sidecar/src/marketplace.ts (the agent surface, FR-2) — keep them in
// sync; the frozen schema (below) is what makes that safe.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Where the index lives by default — a committed seed in the repo. Override with
 * the LOOM_MARKETPLACE_INDEX env var (an absolute/relative path OR an http(s)
 * URL) to point at a community index without code changes (NFR-1). The seed is
 * the contract demo + the test fixture; a real deployment points the env var at
 * the community repo's raw index.json.
 */
export const DEFAULT_INDEX_PATH = path.join(repoRoot, "content/marketplace/index.json");

/** The index.json schema generation (FR-1). FROZEN in Phase 1 — Phase 2's hosted
 *  store returns the SAME shape with extra fields, so bump only on an incompatible
 *  change (adding optional fields like richer ratings does NOT bump it). */
export const INDEX_SCHEMA_VERSION = 1;

/** Tags drawn from the catalog vocabulary (content/CATALOG.md columns) — search
 *  terms are the ones agents already filter local content by (NFR-4). Authors
 *  SHOULD use these; the validator warns (not errors) on an off-vocabulary tag so
 *  the vocabulary can grow without breaking the index. */
export const CATALOG_TAGS = [
  "base",
  "finish",
  "stateful",
  "audio-reactive",
  "generative",
  "geometric",
  "organic",
  "retro",
  "3d",
  "particles",
  "video",
  "feedback",
  "color",
  "warp",
];

const GIT_URL_RE = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/;
const PACK_NAME_RE = /^[a-z][a-zA-Z0-9-]*$/;

/**
 * Validate a parsed index object against the FR-1 schema. Returns
 * { ok, errors[], warnings[], index }. Pure (no IO) so the CI/schema test can
 * feed it crafted objects. `errors` is fatal (the index is malformed); `warnings`
 * are advisory (e.g. an off-vocabulary tag) and never block use.
 */
export function validateIndex(raw) {
  const errors = [];
  const warnings = [];

  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["index must be a JSON object"], warnings, index: null };
  }
  if (raw.schemaVersion !== INDEX_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${INDEX_SCHEMA_VERSION} (got ${JSON.stringify(raw.schemaVersion)})`);
  }
  if (!Array.isArray(raw.packs)) {
    errors.push("`packs` must be an array");
    return { ok: errors.length === 0, errors, warnings, index: raw };
  }

  const seen = new Set();
  raw.packs.forEach((p, i) => {
    const at = `packs[${i}]`;
    if (p == null || typeof p !== "object") {
      errors.push(`${at} must be an object`);
      return;
    }
    // Required string fields.
    for (const f of ["name", "gitUrl", "description", "author", "loomApi"]) {
      if (typeof p[f] !== "string" || p[f].length === 0) {
        errors.push(`${at}.${f} is required (non-empty string)`);
      }
    }
    if (typeof p.name === "string") {
      if (!PACK_NAME_RE.test(p.name)) {
        errors.push(`${at}.name "${p.name}" must be letters-first, [a-z][a-zA-Z0-9-]* (mirrors loom-pack.json)`);
      }
      if (seen.has(p.name)) errors.push(`${at}.name "${p.name}" is a duplicate entry`);
      seen.add(p.name);
    }
    if (typeof p.gitUrl === "string" && !GIT_URL_RE.test(p.gitUrl) && !p.gitUrl.endsWith(".git")) {
      errors.push(`${at}.gitUrl "${p.gitUrl}" is not a git URL (https://, git@, ssh://, git:// or *.git)`);
    }
    // tags: required array of strings (may be empty); off-vocabulary → warning.
    if (!Array.isArray(p.tags)) {
      errors.push(`${at}.tags must be an array of strings`);
    } else {
      for (const t of p.tags) {
        if (typeof t !== "string") errors.push(`${at}.tags must contain only strings`);
        else if (!CATALOG_TAGS.includes(t)) {
          warnings.push(`${at}.tags "${t}" is not in the catalog vocabulary (${CATALOG_TAGS.join(", ")})`);
        }
      }
    }
    // Optional fields.
    if (p.gitRef !== undefined && (typeof p.gitRef !== "string" || p.gitRef.length === 0)) {
      errors.push(`${at}.gitRef, when present, must be a non-empty string`);
    }
    if (p.rating !== undefined) {
      if (typeof p.rating !== "number" || p.rating < 0) {
        errors.push(`${at}.rating, when present, must be a number >= 0`);
      }
    }
  });

  return { ok: errors.length === 0, errors, warnings, index: raw };
}

/**
 * Load + validate the index from a local path (default) or, if `source` looks
 * like an http(s) URL, fetch it. Returns the validated index object. Throws a
 * CLEAN, user-facing Error on any failure (missing file, bad JSON, schema
 * violation, network failure) — NFR-2: discovery failing is a clean error, it
 * NEVER blocks already-pinned packs (which load from packs.json offline).
 */
export async function loadIndex(source = process.env.LOOM_MARKETPLACE_INDEX || DEFAULT_INDEX_PATH) {
  let raw;
  if (/^https?:\/\//.test(source)) {
    let res;
    try {
      res = await fetch(source);
    } catch (err) {
      throw new Error(
        `marketplace: could not reach the index at ${source} (${err instanceof Error ? err.message : String(err)}). ` +
          `Search needs the network; already-installed packs are unaffected.`,
      );
    }
    if (!res.ok) {
      throw new Error(`marketplace: index fetch failed: ${res.status} ${res.statusText} (${source}).`);
    }
    try {
      raw = await res.json();
    } catch {
      throw new Error(`marketplace: index at ${source} is not valid JSON.`);
    }
  } else {
    if (!existsSync(source)) {
      throw new Error(
        `marketplace: no index found at ${source}. Set LOOM_MARKETPLACE_INDEX to a path or URL, ` +
          `or ship a seed index.json. Already-installed packs are unaffected (they load offline from packs.json).`,
      );
    }
    try {
      raw = JSON.parse(readFileSync(source, "utf8"));
    } catch {
      throw new Error(`marketplace: index at ${source} is not valid JSON.`);
    }
  }

  const { ok, errors, index } = validateIndex(raw);
  if (!ok) {
    throw new Error(`marketplace: index at ${source} is invalid:\n  - ${errors.join("\n  - ")}`);
  }
  return index;
}

/** The exact, copy-pasteable install command for a found entry (FR-4). A pinned
 *  gitRef is passed through as `--ref` so the install matches the indexed pin. */
export function installHint(entry) {
  return entry.gitRef ? `pnpm pack:add ${entry.gitUrl} --ref ${entry.gitRef}` : `pnpm pack:add ${entry.gitUrl}`;
}

/**
 * Rank index entries against a free-text query + optional tag filter (FR-2/3 —
 * ONE ranker so the agent tool and the CLI agree). Deterministic and pure.
 *
 * Scoring (higher = better):
 *   - exact name match            +100
 *   - name contains a query term   +40 (per term)
 *   - a tag equals a query term    +25 (per term)
 *   - description contains a term  +10 (per term)
 *   - rating (popularity, NOT a security signal — NFR-3) tie-breaks: +rating*0.5
 * `tags` (the filter) is a hard AND gate: an entry must carry every requested
 * tag to appear at all. An empty query with tags = "everything with these tags".
 * Ties break by rating, then name (stable, testable order).
 */
export function rankEntries(packs, query = "", tags = []) {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const filter = (tags ?? []).map((t) => String(t).toLowerCase());

  const scored = [];
  for (const p of packs) {
    const pTags = (p.tags ?? []).map((t) => t.toLowerCase());
    // Hard tag-AND gate.
    if (filter.length && !filter.every((t) => pTags.includes(t))) continue;

    const name = String(p.name ?? "").toLowerCase();
    const desc = String(p.description ?? "").toLowerCase();
    let score = 0;
    if (terms.length && name === query.toLowerCase()) score += 100;
    for (const term of terms) {
      if (name.includes(term)) score += 40;
      if (pTags.includes(term)) score += 25;
      if (desc.includes(term)) score += 10;
    }
    // With no query, every tag-passing entry is a hit (browse-by-tag).
    if (!terms.length) score += 1;
    if (score <= 0) continue;
    score += (Number(p.rating) || 0) * 0.5;
    scored.push({ entry: p, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const rb = Number(b.entry.rating) || 0;
    const ra = Number(a.entry.rating) || 0;
    if (rb !== ra) return rb - ra;
    return String(a.entry.name).localeCompare(String(b.entry.name));
  });
  return scored.map((s) => s.entry);
}

/** Shape a ranked entry into the public search result (FR-2 surface). */
export function toResult(entry) {
  return {
    name: entry.name,
    description: entry.description,
    tags: entry.tags ?? [],
    gitUrl: entry.gitUrl,
    ...(entry.gitRef ? { gitRef: entry.gitRef } : {}),
    author: entry.author,
    ...(entry.rating !== undefined ? { rating: entry.rating } : {}),
    loomApi: entry.loomApi,
    installHint: installHint(entry),
  };
}

/** Convenience: load + rank + shape, the whole CLI/tool pipeline in one call. */
export async function searchIndex({ query = "", tags = [], source } = {}) {
  const index = await loadIndex(source);
  return rankEntries(index.packs, query, tags).map(toResult);
}

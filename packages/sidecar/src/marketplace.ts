// Marketplace discovery, agent side (content-sharing-marketplace FR-2).
//
// This is the SIDECAR mirror of scripts/lib/marketplace.mjs (the Node/CLI side).
// The `search_content` MCP tool reads the SHAREABLE index — a committed JSON file
// or a fetched URL — and returns ranked entries. It needs NOTHING from the engine
// (it pulls nothing), so it lives entirely sidecar-side and answers even when no
// engine is connected. The schema (FR-1) is FROZEN; keep this in sync with the
// .mjs side. NFR-2: a missing/unreachable index is a CLEAN error, never a crash —
// already-installed packs are unaffected.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** The index.json schema generation (FR-1). FROZEN in Phase 1. */
export const INDEX_SCHEMA_VERSION = 1;

const GIT_URL_RE = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/;
const PACK_NAME_RE = /^[a-z][a-zA-Z0-9-]*$/;

/** One marketplace index entry (FR-1). `name`/`loomApi` mirror loom-pack.json. */
export const IndexEntry = z.object({
  name: z.string().regex(PACK_NAME_RE, "letters-first [a-z][a-zA-Z0-9-]*"),
  gitUrl: z
    .string()
    .min(1)
    .refine((u) => GIT_URL_RE.test(u) || u.endsWith(".git"), "must be a git URL"),
  gitRef: z.string().min(1).optional(),
  description: z.string().min(1),
  tags: z.array(z.string()),
  author: z.string().min(1),
  loomApi: z.string().min(1),
  rating: z.number().min(0).optional(),
});
export type IndexEntry = z.infer<typeof IndexEntry>;

/** The frozen index document (FR-1). */
export const MarketplaceIndex = z.object({
  schemaVersion: z.literal(INDEX_SCHEMA_VERSION),
  packs: z.array(IndexEntry),
});
export type MarketplaceIndex = z.infer<typeof MarketplaceIndex>;

/** A shaped search result (FR-2 surface). */
export interface SearchResult {
  name: string;
  description: string;
  tags: string[];
  gitUrl: string;
  gitRef?: string;
  author: string;
  rating?: number;
  loomApi: string;
  installHint: string;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Default committed seed; override with LOOM_MARKETPLACE_INDEX (path or URL) — NFR-1. */
export function indexSource(): string {
  return process.env.LOOM_MARKETPLACE_INDEX || path.join(repoRoot, "content/marketplace/index.json");
}

/** The exact, copy-pasteable install command for a found entry (FR-4). */
export function installHint(entry: IndexEntry): string {
  return entry.gitRef ? `pnpm pack:add ${entry.gitUrl} --ref ${entry.gitRef}` : `pnpm pack:add ${entry.gitUrl}`;
}

/**
 * Load + validate the index from a local path (default) or an http(s) URL.
 * Throws a CLEAN, user-facing Error on any failure (missing/bad/unreachable) —
 * NFR-2: search failing never blocks already-pinned packs.
 */
export async function loadIndex(source = indexSource()): Promise<MarketplaceIndex> {
  let raw: unknown;
  if (/^https?:\/\//.test(source)) {
    let res: Response;
    try {
      res = await fetch(source);
    } catch (err) {
      throw new Error(
        `marketplace: could not reach the index at ${source} ` +
          `(${err instanceof Error ? err.message : String(err)}). Already-installed packs are unaffected.`,
      );
    }
    if (!res.ok) throw new Error(`marketplace: index fetch failed: ${res.status} ${res.statusText} (${source}).`);
    try {
      raw = await res.json();
    } catch {
      throw new Error(`marketplace: index at ${source} is not valid JSON.`);
    }
  } else {
    if (!existsSync(source)) {
      throw new Error(
        `marketplace: no index found at ${source}. Set LOOM_MARKETPLACE_INDEX to a path or URL. ` +
          `Already-installed packs are unaffected (they load offline from packs.json).`,
      );
    }
    try {
      raw = JSON.parse(await readFile(source, "utf8"));
    } catch {
      throw new Error(`marketplace: index at ${source} is not valid JSON.`);
    }
  }

  const parsed = MarketplaceIndex.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`marketplace: index at ${source} is invalid: ${msg}`);
  }
  return parsed.data;
}

/**
 * Rank index entries against a query + optional tags. Mirrors the .mjs ranker
 * (one scoring rule so the agent tool and the CLI agree). `tags` is a hard AND
 * gate; ties break by rating (popularity, NOT a security signal — NFR-3) then
 * name. Pure + deterministic so it is unit-testable without IO.
 */
export function rankEntries(packs: IndexEntry[], query = "", tags: string[] = []): IndexEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const filter = tags.map((t) => t.toLowerCase());

  const scored: { entry: IndexEntry; score: number }[] = [];
  for (const p of packs) {
    const pTags = p.tags.map((t) => t.toLowerCase());
    if (filter.length && !filter.every((t) => pTags.includes(t))) continue;

    const name = p.name.toLowerCase();
    const desc = p.description.toLowerCase();
    let score = 0;
    if (terms.length && name === query.toLowerCase()) score += 100;
    for (const term of terms) {
      if (name.includes(term)) score += 40;
      if (pTags.includes(term)) score += 25;
      if (desc.includes(term)) score += 10;
    }
    if (!terms.length) score += 1;
    if (score <= 0) continue;
    score += (p.rating ?? 0) * 0.5;
    scored.push({ entry: p, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const rb = b.entry.rating ?? 0;
    const ra = a.entry.rating ?? 0;
    if (rb !== ra) return rb - ra;
    return a.entry.name.localeCompare(b.entry.name);
  });
  return scored.map((s) => s.entry);
}

/** Shape a ranked entry into the public result (FR-2). */
export function toResult(entry: IndexEntry): SearchResult {
  return {
    name: entry.name,
    description: entry.description,
    tags: entry.tags,
    gitUrl: entry.gitUrl,
    ...(entry.gitRef ? { gitRef: entry.gitRef } : {}),
    author: entry.author,
    ...(entry.rating !== undefined ? { rating: entry.rating } : {}),
    loomApi: entry.loomApi,
    installHint: installHint(entry),
  };
}

/** The whole tool pipeline: load → rank → shape. Throws cleanly on index failure. */
export async function searchContent(query: string, tags: string[] = [], source?: string): Promise<SearchResult[]> {
  const index = await loadIndex(source);
  return rankEntries(index.packs, query, tags).map(toResult);
}

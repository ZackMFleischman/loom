import {
  type ChainableEffect,
  type CompositeEffectEntry,
  type EffectEntry,
  type EffectRegistry,
  type ModuleFactory,
  type PrimitiveEffectEntry,
} from "@loom/runtime";
import { z } from "zod";

/**
 * The chainable-effect library (M6). Two sources, one registry:
 *  - code effects in content/modules/effects/*.ts that declare `meta.chainParams`
 *    (primitives), globbed like the scenes barrel so adding one hot-registers it;
 *  - saved chains in content/modules/effects/chains/*.chain.json (composites) —
 *    data-only definitions written by save_chain, selectable like any effect.
 * A bad composite file is skipped (never-go-black's cousin: the picker keeps
 * working) rather than breaking the registry.
 */

type AnyFactory = ModuleFactory<unknown, unknown, unknown> & {
  meta: { name: string; kind: string; description?: string; chainParams?: unknown[] };
};

const codeMods = import.meta.glob("../../../content/modules/effects/*.ts", { eager: true });
const chainData = import.meta.glob("../../../content/modules/effects/chains/*.chain.json", {
  eager: true,
});

const CompositeFile = z.object({
  name: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
  description: z.string().optional(),
  steps: z
    .array(
      z.object({
        id: z.string().min(1),
        effect: z.string().min(1),
        params: z.record(z.string(), z.union([z.number(), z.boolean()])).default({}),
        mix: z.number().min(0).max(1).optional(),
      }),
    )
    .min(1),
});

export interface EffectDescriptor {
  name: string;
  kind: "primitive" | "composite";
  description?: string;
}

export interface EffectLibrary extends EffectRegistry {
  describe(): EffectDescriptor[];
}

function build(): EffectLibrary {
  const map = new Map<string, EffectEntry>();

  for (const mod of Object.values(codeMods)) {
    for (const exp of Object.values(mod as Record<string, unknown>)) {
      const f = exp as AnyFactory;
      if (typeof f !== "function" || f.meta?.kind !== "effect" || !f.meta.chainParams) continue;
      const entry: PrimitiveEffectEntry = {
        name: f.meta.name,
        kind: "primitive",
        chainParams: f.meta.chainParams as PrimitiveEffectEntry["chainParams"],
        factory: f as unknown as ChainableEffect,
        ...(f.meta.description != null ? { description: f.meta.description } : {}),
      };
      map.set(entry.name, entry);
    }
  }

  // Composites reference primitives only (one level deep): drop any that don't resolve.
  for (const [path, mod] of Object.entries(chainData)) {
    const parsed = CompositeFile.safeParse((mod as { default?: unknown }).default);
    if (!parsed.success) {
      console.warn(`[loom] skipping malformed saved chain ${path}: ${parsed.error.message}`);
      continue;
    }
    const def = parsed.data;
    const bad = def.steps.find((s) => map.get(s.effect)?.kind !== "primitive");
    if (bad) {
      console.warn(`[loom] saved chain "${def.name}" references non-primitive "${bad.effect}" — skipped`);
      continue;
    }
    const entry: CompositeEffectEntry = {
      name: def.name,
      kind: "composite",
      steps: def.steps,
      ...(def.description != null ? { description: def.description } : {}),
    };
    map.set(entry.name, entry);
  }

  return {
    get: (n) => map.get(n),
    names: () => [...map.keys()],
    describe: () =>
      [...map.values()].map((e) => ({
        name: e.name,
        kind: e.kind,
        ...(e.description != null ? { description: e.description } : {}),
      })),
  };
}

/**
 * Build the effect library from the (eagerly globbed) modules. Editing or
 * adding an effect / saved chain re-executes this module via the barrel, and
 * main.ts re-caches the result on the `./effects` hot-update — mirroring scenes.
 */
export function getEffectLibrary(): EffectLibrary {
  return build();
}

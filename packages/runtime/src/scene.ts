import { z } from "zod";
import type { BuildCtx } from "./buildctx";
import type { ChainStepInput } from "./chain";
import type { TexNode } from "./texnode";

const ChainStepInputSchema = z.object({
  id: z.string().min(1).optional(),
  effect: z.string().min(1),
  params: z.record(z.string(), z.union([z.number(), z.boolean()])).optional(),
  mix: z.number().min(0).max(1).optional(),
});

const SceneMetaSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  /** A default post-effect chain the instance seeds with (M6). */
  chain: z.array(ChainStepInputSchema).optional(),
});

export interface SceneDef {
  name: string;
  description?: string;
  tags: string[];
  /** Scene-declared default chain, seeded at create and restorable in the Console. */
  chain?: ChainStepInput[];
  build(ctx: BuildCtx): TexNode;
}

export interface SceneInput {
  name: string;
  description?: string;
  tags?: string[];
  chain?: ChainStepInput[];
  build(ctx: BuildCtx): TexNode;
}

/** A composition of modules; metadata zod-validated at definition time. */
export function defineScene(def: SceneInput): SceneDef {
  if (typeof def?.build !== "function") {
    throw new Error("defineScene: build must be a function (ctx) => TexNode");
  }
  const meta = SceneMetaSchema.parse(def);
  return {
    name: meta.name,
    tags: meta.tags,
    build: def.build,
    ...(meta.description !== undefined ? { description: meta.description } : {}),
    ...(meta.chain !== undefined ? { chain: meta.chain } : {}),
  };
}

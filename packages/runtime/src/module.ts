import { z } from "zod";

/**
 * A knob an effect exposes when it is used as a step in a post-effect chain
 * (M6). `set_chain` declares one `fx.<stepId>.<name>` param per entry and feeds
 * its live signal into the matching factory opt — so the effect's existing
 * `SignalLike` options become the chain's mixing board. float/int carry a
 * range; bool is an on/off. The step's own wet/dry `mix` is added automatically.
 */
export const ChainParamSpec = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-zA-Z0-9]*$/, "chain param names are lowerCamelCase identifiers"),
    type: z.enum(["float", "int", "bool"]).default("float"),
    default: z.union([z.number(), z.boolean()]),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
    labels: z.array(z.string().min(1)).optional(),
    description: z.string().optional(),
  })
  .refine((s) => s.type === "bool" || (s.min != null && s.max != null), {
    message: "float/int chain params need min and max",
  });
export type ChainParamSpec = z.infer<typeof ChainParamSpec>;
export type ChainParamInput = z.input<typeof ChainParamSpec>;

/**
 * A typed *extra input slot* an effect declares for chain use (multi-input
 * chain steps). The piped `input` is always slot-0 and implicit; `chainInputs`
 * names the ADDITIONAL TexNode sources the effect needs (e.g. `over`'s
 * `overlay`). Each slot is bound — via `ChainStep.inputs[name]` — to a
 * `SourceRef` the human/agent picks (another instance, an earlier step, or —
 * once M10 lands — an asset). The fold resolves each ref to a TexNode and feeds
 * it into the factory opt of the same name. `kind: "tex"` is the only kind for
 * now (Geo/Cam slots are a later milestone).
 */
export const ChainInputSpec = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-zA-Z0-9]*$/, "chain input names are lowerCamelCase identifiers"),
  kind: z.literal("tex").default("tex"),
  description: z.string().optional(),
});
export type ChainInputSpec = z.infer<typeof ChainInputSpec>;
export type ChainInputInput = z.input<typeof ChainInputSpec>;

export const ModuleMetaSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-zA-Z0-9]*$/, "module names are lowerCamelCase identifiers"),
  kind: z.enum(["control", "source", "effect", "geo", "output"]),
  description: z.string().min(1),
  tags: z.array(z.string()).default([]),
  example: z.string().optional(),
  /** Effects opt into chain use by declaring the knobs `set_chain` should expose. */
  chainParams: z.array(ChainParamSpec).optional(),
  /**
   * Extra typed input slots (beyond the piped `input`) this effect needs to be
   * usable as a chain step (multi-input chain steps) — e.g. `over`'s overlay.
   * Each slot is bound to a SourceRef per ChainStep and resolved in the fold.
   */
  chainInputs: z.array(ChainInputSpec).optional(),
});

export type ModuleMeta = z.infer<typeof ModuleMetaSchema>;
export type ModuleMetaInput = z.input<typeof ModuleMetaSchema>;

export interface ModuleFactory<Ctx, Opts, Out> {
  (ctx: Ctx, opts: Opts): Out;
  meta: ModuleMeta;
}

/**
 * A typed composable unit. The metadata is zod-validated at definition time
 * and rides into the catalog (M5); the factory body builds into an instance
 * via the BuildCtx it receives.
 */
export function defineModule<Ctx, Opts, Out>(
  meta: ModuleMetaInput,
  create: (ctx: Ctx, opts: Opts) => Out,
): ModuleFactory<Ctx, Opts, Out> {
  const parsed = ModuleMetaSchema.parse(meta);
  const factory = ((ctx: Ctx, opts: Opts) => create(ctx, opts)) as ModuleFactory<Ctx, Opts, Out>;
  factory.meta = parsed;
  return factory;
}

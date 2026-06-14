import type { Node, WebGPURenderer } from "./tsl";
import type { FrameCtx } from "./frame";

/** TexNodes always carry a vec4 color expression — keeps composition typed. */
export type ColorNode = Node<"vec4">;

/** A stateful GPU step (e.g. feedback accumulation) run once per frame. */
export interface Pass {
  render(renderer: WebGPURenderer, f: FrameCtx): void;
  dispose(): void;
}

/**
 * A node in the GPU image graph: a TSL color expression plus whatever
 * stateful passes it depends on, in execution order. Effects concatenate
 * their input's passes with their own so order stays topological.
 */
export interface TexNode {
  readonly color: ColorNode;
  readonly passes: readonly Pass[];
}

export function texNode(color: ColorNode, passes: readonly Pass[] = []): TexNode {
  return { color, passes };
}

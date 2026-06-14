export type ModField =
  | { key: string; label: string; kind: "number"; step: number; min?: number; max?: number }
  | { key: string; label: string; kind: "select"; options: string[] }
  | { key: string; label: string; kind: "values" };

export type ModTypeDesc = { type: string; bool: boolean; clocked: boolean; fields: ModField[] };

export const MOD_TYPES: ModTypeDesc[] = [
  { type: "sine", bool: false, clocked: true, fields: [] },
  { type: "triangle", bool: false, clocked: true, fields: [] },
  {
    type: "ramp", bool: false, clocked: true,
    fields: [{ key: "direction", label: "direction", kind: "select", options: ["up", "down"] }],
  },
  {
    type: "square", bool: true, clocked: true,
    fields: [{ key: "duty", label: "duty", kind: "number", step: 0.05, min: 0, max: 1 }],
  },
  { type: "random", bool: true, clocked: true, fields: [] },
  {
    type: "drift", bool: false, clocked: true,
    fields: [{ key: "smooth", label: "smooth s", kind: "number", step: 0.1, min: 0 }],
  },
  {
    type: "cycle", bool: true, clocked: true,
    fields: [
      { key: "order", label: "order", kind: "select", options: ["forward", "reverse", "pingpong", "random"] },
      { key: "values", label: "values", kind: "values" },
    ],
  },
  {
    type: "audio", bool: false, clocked: false,
    fields: [
      { key: "band", label: "band", kind: "select", options: ["rms", "bass", "mid", "treble"] },
      { key: "smooth", label: "smooth s", kind: "number", step: 0.01, min: 0 },
    ],
  },
];

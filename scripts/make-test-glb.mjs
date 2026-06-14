// One-shot generator for content/assets/test/cube.glb — a minimal valid glTF
// 2.0 binary (one unit cube, flat normals, base color) so model-loading
// validators and stdlib smokes stay machine-independent. Checked in; rerun
// only if the asset needs to change.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// 24 vertices (4 per face, flat normals), 36 indices.
const P = [];
const N = [];
const I = [];
const faces = [
  { n: [0, 0, 1], q: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { n: [0, 0, -1], q: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
  { n: [1, 0, 0], q: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { n: [-1, 0, 0], q: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { n: [0, 1, 0], q: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { n: [0, -1, 0], q: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
];
for (const { n, q } of faces) {
  const base = P.length / 3;
  for (const v of q) {
    P.push(v[0] * 0.5, v[1] * 0.5, v[2] * 0.5);
    N.push(...n);
  }
  I.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

const pos = new Float32Array(P);
const nor = new Float32Array(N);
const idx = new Uint16Array(I);

const align = (n, to = 4) => Math.ceil(n / to) * to;
const posOff = 0;
const norOff = align(posOff + pos.byteLength);
const idxOff = align(norOff + nor.byteLength);
const binLen = align(idxOff + idx.byteLength);
const bin = Buffer.alloc(binLen);
Buffer.from(pos.buffer).copy(bin, posOff);
Buffer.from(nor.buffer).copy(bin, norOff);
Buffer.from(idx.buffer).copy(bin, idxOff);

const gltf = {
  asset: { version: "2.0", generator: "loom make-test-glb" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: "testCube" }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
  materials: [
    {
      name: "testOrange",
      pbrMetallicRoughness: { baseColorFactor: [1.0, 0.45, 0.1, 1.0], metallicFactor: 0, roughnessFactor: 0.6 },
    },
  ],
  buffers: [{ byteLength: binLen }],
  bufferViews: [
    { buffer: 0, byteOffset: posOff, byteLength: pos.byteLength, target: 34962 },
    { buffer: 0, byteOffset: norOff, byteLength: nor.byteLength, target: 34962 },
    { buffer: 0, byteOffset: idxOff, byteLength: idx.byteLength, target: 34963 },
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 24, type: "VEC3", min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
    { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" },
    { bufferView: 2, componentType: 5123, count: 36, type: "SCALAR" },
  ],
};

let json = Buffer.from(JSON.stringify(gltf), "utf8");
const jsonPad = align(json.length) - json.length;
if (jsonPad > 0) json = Buffer.concat([json, Buffer.alloc(jsonPad, 0x20)]); // pad with spaces

const header = Buffer.alloc(12);
header.write("glTF", 0, "ascii");
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
const jsonChunk = Buffer.alloc(8);
jsonChunk.writeUInt32LE(json.length, 0);
jsonChunk.writeUInt32LE(0x4e4f534a, 4); // "JSON"
const binChunk = Buffer.alloc(8);
binChunk.writeUInt32LE(bin.length, 0);
binChunk.writeUInt32LE(0x004e4942, 4); // "BIN\0"

const out = join(ROOT, "content", "assets", "test", "cube.glb");
writeFileSync(out, Buffer.concat([header, jsonChunk, json, binChunk, bin]));
console.log(`wrote ${out} (${12 + 8 + json.length + 8 + bin.length} bytes)`);

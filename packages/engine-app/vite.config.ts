import { execFile } from "node:child_process";
import { createReadStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { injectLoopGuards } from "../runtime/src/loopguard";

// Loop-guard (signal robustness): every loop in agent-authored content/ gets an
// iteration budget injected at build time, so a runaway/infinite loop in a
// scene or module THROWS instead of wedging the single render thread — and a
// throw is already contained (NFR-2 freezes that instance, never-go-black
// holds). Count-based (deterministic), so fixture replays stay byte-identical.
// Defensive: any transform failure falls through to the untransformed source —
// the guard must never itself break the dev server.
const loopGuard: Plugin = {
  name: "loom:loop-guard",
  enforce: "pre",
  transform(code, id) {
    const file = id.split("?")[0]!; // skip ?raw and other query imports below
    if (id.includes("?")) return null;
    if (!file.endsWith(".ts") || file.endsWith(".d.ts")) return null;
    if (!normalize(file).includes(`${sep}content${sep}`)) return null;
    if (!/\b(for|while|do)\b/.test(code)) return null; // nothing to guard
    try {
      return { code: injectLoopGuards(code, { fileName: file }), map: null };
    } catch {
      return null; // never-go-black: a broken transform must not break the build
    }
  },
};

// content/ sits outside this package's root, so Vite's watcher never learns
// about NEW files created there: import.meta.glob("../../../content/scenes/*")
// then misses additions until something else invalidates the scenes barrel.
// Watching the directory explicitly makes file add/unlink events reach Vite's
// glob-importer invalidation, so a new *.scene.ts is hot-registered on save.
const watchContent: Plugin = {
  name: "loom:watch-content",
  configureServer(server) {
    server.watcher.add(fileURLToPath(new URL("../../content", import.meta.url)));
    // Module packs (packs/<name>/) live outside this package root too — watch
    // them so a pack's scene/module add/edit hot-registers through the barrels'
    // packs/* globs (gitignored dir; absent until `pnpm pack:add`).
    server.watcher.add(fileURLToPath(new URL("../../packs", import.meta.url)));
  },
};

// content/CATALOG.md is the library's search surface, but a live session edits
// modules/scenes via HMR and never runs `pnpm typecheck` — so the dev server
// regenerates the catalog itself. Failures are logged and swallowed: a
// half-written module must never break the dev server (never-go-black's cousin).
const catalogScript = fileURLToPath(new URL("../../scripts/build-catalog.mjs", import.meta.url));
const buildCatalog: Plugin = {
  name: "loom:catalog",
  configureServer(server) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isCatalogSource = (file: string) => {
      const n = normalize(file);
      const inContent =
        n.includes(`${sep}content${sep}modules${sep}`) ||
        n.includes(`${sep}content${sep}scenes${sep}`);
      // Pack sources feed the catalog too (packs/<name>/{modules,scenes}/…).
      const inPack =
        n.includes(`${sep}packs${sep}`) &&
        (n.includes(`${sep}modules${sep}`) || n.includes(`${sep}scenes${sep}`));
      return (inContent || inPack) && n.endsWith(".ts");
    };
    const schedule = (file: string) => {
      if (!isCatalogSource(file)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        execFile(process.execPath, [catalogScript], (err) => {
          if (err) server.config.logger.warn(`loom:catalog regen failed: ${err.message}`);
          else server.config.logger.info("loom:catalog → content/CATALOG.md regenerated");
        });
      }, 300);
    };
    server.watcher.on("add", schedule);
    server.watcher.on("change", schedule);
    server.watcher.on("unlink", schedule);
  },
};

// Tuned-state persistence (R6.2): GET/POST /loom/state/<name> reads/writes
// content/state/<name>.json. Vite is LOOM's standing server, so the sidecar
// stays optional (R4.5) and state files are plain text in git (NFR-4).
const stateApi: Plugin = {
  name: "loom:state",
  configureServer(server) {
    const stateDir = fileURLToPath(new URL("../../content/state", import.meta.url));
    server.middlewares.use("/loom/state/", (req, res) => {
      const name = decodeURIComponent((req.url ?? "").replace(/^\//, "").split("?")[0]!);
      if (!/^[a-zA-Z0-9_\-/]+$/.test(name) || name.includes("..")) {
        res.statusCode = 400;
        res.end("bad state name");
        return;
      }
      const file = normalize(join(stateDir, `${name}.json`));
      if (!file.startsWith(normalize(stateDir))) {
        res.statusCode = 400;
        res.end("bad state name");
        return;
      }
      if (req.method === "GET") {
        try {
          const body = readFileSync(file, "utf8");
          res.setHeader("content-type", "application/json");
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.end("{}");
        }
        return;
      }
      if (req.method === "POST") {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
          try {
            JSON.parse(raw); // store JSON only — a corrupt write must never land
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, raw);
            res.statusCode = 204;
            res.end();
          } catch {
            res.statusCode = 400;
            res.end("body must be JSON");
          }
        });
        return;
      }
      res.statusCode = 405;
      res.end();
    });
  },
};

// External media (M9): GET /loom/media?p=<absolute path> streams a file that
// lives OUTSIDE the repo (a VJ-assets folder), with HTTP Range support —
// HTMLVideoElement seeks need 206 responses. Confined to the roots registered
// in content/state/media-roots.json (read per request, hot-editable); anything
// else is 403. M10's asset explorer grows on this same registration.
const MEDIA_TYPES = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const mediaApi: Plugin = {
  name: "loom:media",
  configureServer(server) {
    const rootsFile = fileURLToPath(new URL("../../content/state/media-roots.json", import.meta.url));
    const loadRoots = (): string[] => {
      try {
        return (JSON.parse(readFileSync(rootsFile, "utf8")) as { roots?: string[] }).roots ?? [];
      } catch {
        return []; // no registration file -> nothing is served
      }
    };
    const streamFile = (
      req: { headers: { range?: string | undefined } },
      res: import("node:http").ServerResponse,
      file: string,
    ) => {
      let st;
      try {
        st = statSync(file);
        if (!st.isFile()) throw new Error("not a file");
      } catch {
        res.statusCode = 404;
        res.end("no such file");
        return;
      }
      res.setHeader("accept-ranges", "bytes");
      res.setHeader(
        "content-type",
        MEDIA_TYPES[extname(file).toLowerCase() as keyof typeof MEDIA_TYPES] ?? "application/octet-stream",
      );
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
        if (Number.isNaN(start) || start > end || start >= st.size) {
          res.statusCode = 416;
          res.setHeader("content-range", `bytes */${st.size}`);
          res.end();
          return;
        }
        res.statusCode = 206;
        res.setHeader("content-range", `bytes ${start}-${end}/${st.size}`);
        res.setHeader("content-length", String(end - start + 1));
        createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.setHeader("content-length", String(st.size));
      createReadStream(file).pipe(res);
    };

    // Query style: /loom/media?p=<absolute path> (videos, single files).
    server.middlewares.use("/loom/media", (req, res, next) => {
      // Connect prefix-matching would also catch /loom/mediafs — hand that off.
      if ((req.originalUrl ?? req.url ?? "").includes("/loom/mediafs/")) return next();
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.end();
        return;
      }
      const p = new URL(req.url ?? "", "http://x").searchParams.get("p");
      if (!p) {
        res.statusCode = 400;
        res.end("missing ?p=<absolute path>");
        return;
      }
      const file = normalize(p);
      const fl = file.toLowerCase();
      const allowed = loadRoots().some((r) => {
        const n = normalize(r).toLowerCase().replace(/[\\/]+$/, "");
        return fl === n || fl.startsWith(n + sep);
      });
      if (!allowed) {
        res.statusCode = 403;
        res.end("path is not under a registered media root (content/state/media-roots.json)");
        return;
      }
      streamFile(req, res, file);
    });

    // Path style: /loom/mediafs/<rootIndex>/<relative path> (models — relative
    // texture references resolve naturally against the URL base).
    server.middlewares.use("/loom/mediafs/", (req, res) => {
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.end();
        return;
      }
      const path = decodeURIComponent((req.url ?? "").replace(/^\//, "").split("?")[0]!);
      const m = /^(\d+)\/(.+)$/.exec(path);
      if (!m) {
        res.statusCode = 400;
        res.end("expected /loom/mediafs/<rootIndex>/<relative path>");
        return;
      }
      const roots = loadRoots();
      const root = roots[Number(m[1])];
      if (root == null) {
        res.statusCode = 403;
        res.end(`no media root #${m[1]} (content/state/media-roots.json has ${roots.length})`);
        return;
      }
      const base = normalize(root).replace(/[\\/]+$/, "");
      const file = normalize(join(base, m[2]!));
      if (!file.toLowerCase().startsWith(base.toLowerCase() + sep)) {
        res.statusCode = 400;
        res.end("path escapes the media root");
        return;
      }
      streamFile(req, res, file);
    });
  },
};

// State directory listing (Projects): GET /loom/state-list/<dir> returns the
// JSON basenames under content/state/<dir>/ — the project switcher's source of
// truth, so a project file dropped in via git shows up too.
const stateListApi: Plugin = {
  name: "loom:state-list",
  configureServer(server) {
    const stateDir = fileURLToPath(new URL("../../content/state", import.meta.url));
    server.middlewares.use("/loom/state-list/", (req, res) => {
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.end();
        return;
      }
      const dir = decodeURIComponent((req.url ?? "").replace(/^\//, "").split("?")[0]!);
      if (!/^[a-zA-Z0-9_-]+$/.test(dir)) {
        res.statusCode = 400;
        res.end("bad dir name");
        return;
      }
      const full = normalize(join(stateDir, dir));
      if (!full.startsWith(normalize(stateDir))) {
        res.statusCode = 400;
        res.end("bad dir name");
        return;
      }
      let names: string[] = [];
      try {
        names = readdirSync(full)
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.replace(/\.json$/, ""))
          .sort();
      } catch {
        // no such dir yet — an empty list, not an error
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(names));
    });
  },
};

// Saved chains (M6 "save chain as effect"): POST /loom/effects/<name> writes a
// data-only content/modules/effects/chains/<name>.chain.json that the effects
// barrel then offers as a composite. Same belt-and-braces as loom:state: JSON
// only, name validated, writes confined to the chains directory.
const effectsApi: Plugin = {
  name: "loom:effects",
  configureServer(server) {
    const chainsDir = fileURLToPath(
      new URL("../../content/modules/effects/chains", import.meta.url),
    );
    server.middlewares.use("/loom/effects/", (req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end();
        return;
      }
      const name = decodeURIComponent((req.url ?? "").replace(/^\//, "").split("?")[0]!);
      if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) {
        res.statusCode = 400;
        res.end("bad effect name");
        return;
      }
      const file = normalize(join(chainsDir, `${name}.chain.json`));
      if (!file.startsWith(normalize(chainsDir))) {
        res.statusCode = 400;
        res.end("bad effect name");
        return;
      }
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        try {
          JSON.parse(raw); // store JSON only — a corrupt write must never land
          mkdirSync(chainsDir, { recursive: true });
          writeFileSync(file, raw);
          res.statusCode = 204;
          res.end();
        } catch {
          res.statusCode = 400;
          res.end("body must be JSON");
        }
      });
    });
  },
};

export default defineConfig({
  plugins: [loopGuard, watchContent, buildCatalog, stateApi, stateListApi, mediaApi, effectsApi],
  // Multi-page production build for the static preview deploy (Cloudflare Pages):
  // the Output window (/), the Console cockpit (/console.html), and the staged
  // preview (/staged.html) all ship so the preview is "view + tweak", not just a
  // projector. The dev server is unaffected — it already serves every root HTML.
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        console: fileURLToPath(new URL("./console.html", import.meta.url)),
        staged: fileURLToPath(new URL("./staged.html", import.meta.url)),
      },
    },
  },
  resolve: {
    // A locally-linked module pack (packs/<name>/ → an out-of-tree dir via
    // `pnpm pack:add <path>`) must resolve the host's `three`/`three/tsl` from
    // node_modules. Keeping the symlinked path (not the real out-of-tree path)
    // makes bare specifiers walk up to the repo's node_modules like local
    // content. Cloned packs (in-tree) are unaffected.
    preserveSymlinks: true,
    alias: {
      // Single source of truth for runtime resolution so content/ scenes
      // (outside any package) resolve it too.
      "@loom/runtime": fileURLToPath(new URL("../runtime/src/index.ts", import.meta.url)),
      // The WS wire contract shared with the sidecar (browser-safe module).
      "@loom/sidecar/protocol": fileURLToPath(new URL("../sidecar/src/protocol.ts", import.meta.url)),
    },
  },
  server: {
    // Never-go-black: a compile error must not paint over the Output window.
    hmr: { overlay: false },
    fs: {
      allow: [fileURLToPath(new URL("../..", import.meta.url))],
    },
  },
});

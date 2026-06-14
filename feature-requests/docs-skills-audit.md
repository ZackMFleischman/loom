# Feature request: docs / CLAUDE.md / skills / plans audit

Status: proposed · Requested: 2026-06-13 · Owner: unassigned

## Summary

The doc tree has grown a second time since the 2026-06-11 docs refactor
(`docs/superpowers/specs/2026-06-11-docs-refactor-design.md`). That refactor did
its job — the `docs/` + slim-`CLAUDE.md` shape it proposed is the shape that
actually exists on disk — but five more milestones shipped on top of it
(M6-chains, Layers, Projects, M9, Fixtures, M7, M8, M11), each leaving a
`superpowers/plans/*` + `superpowers/specs/*` pair behind, and several docs now
describe a world that's already past. This is an **audit + proposed end-state**,
not the execution. It produces: (1) a real inventory of every doc/skill/plan with
purpose + freshness, (2) concrete archive/delete/consolidate/relocate candidates
each marked **act** or **verify before acting**, and (3) the target shape — a
light-weight root `CLAUDE.md` that points into `docs/` and pulls skills on demand,
with criteria for what belongs where.

The guiding principle is the one the last refactor already adopted and we want to
keep: **one source of truth per fact; one doc per audience; CLAUDE.md stays slim
and pulls skills/docs on demand rather than front-loading them.**

## Scope note — this interacts with two siblings

- [[loom-user-plugin]] — packaging the "using LOOM" agent context (visuals-agent
  `.claude/CLAUDE.md` + the four content skills) as an installable Claude Code
  plugin. **The using-vs-building split is the single biggest relocation
  decision in this audit**: if that plugin happens, `.claude/CLAUDE.md` and
  `.claude/skills/{library-use,module-authoring,scene-composition}` move out of
  the repo root into the plugin, and only `validator-authoring` (a *builder*
  skill) stays. This audit should **decide the target boundary** so the plugin
  work has a clean line to cut along, but should **not** pre-move anything —
  sequence the relocation under the plugin request.
- [[validator-test-consolidation]] — overlaps only at `validator-authoring`
  SKILL.md and the `validate:m*` command list in root `CLAUDE.md`. If that work
  collapses milestone validators into fewer suites, the command block in
  `CLAUDE.md` (currently 18 `validate:*` lines) shrinks with it. Note the
  dependency; don't rewrite the command list speculatively here.

## Audit method

For each artifact: record **size**, **stated purpose**, **freshness** (cross-check
against `docs/roadmap.md`'s Shipped table and what's on disk), and **overlap** with
other docs. Then classify into: **keep** (single source of truth, current),
**consolidate** (content duplicated elsewhere), **archive** (historical value, no
longer live guidance), **delete** (regenerable or fully superseded), **relocate**
(belongs to a different audience/owner — chiefly the plugin). Sizes below are from
`wc -l` on 2026-06-13; line numbers cited are load-bearing references.

## Inventory

### Root context files

| File | Size | Purpose | Freshness | Verdict |
|---|---|---|---|---|
| `CLAUDE.md` | 78 ln | Builder-agent front door: repo orientation, never-go-black, command block, conventions, PR screenshots | **Current.** Already slim post-refactor; doc map at lines 9–14 is accurate | **keep** — minor trims (below) |
| `.claude/CLAUDE.md` | 85 ln | Visuals-agent guide: MCP tools, rules, architecture-map summary, workflow | **Current** and dense | **keep**, but **relocate** target for [[loom-user-plugin]] |
| `README.md` | 45 ln | Project front door: what/status/quickstart/doc-map | **Status line stale** — line 9 says "M0–M6 (palette half) shipped … Remaining: M6 chains, M7, M8, M9"; roadmap shows M6-chains/M7/M8/M9/Layers/Projects/Fixtures/M11 all **shipped** | **keep**, fix status |
| `DECISIONS.md` | 1405 ln (~112 KB) | Append-only decision log + SHIPPED entries | Live and correctly role-scoped ("grep on demand", not "read first") | **keep** as-is; see size note below |

### `docs/` — durable references

| File | Size | Purpose | Freshness | Verdict |
|---|---|---|---|---|
| `architecture.md` | 336 ln | THE architecture doc — single source of truth for how it's built | Current; the deep-on-demand target both CLAUDE.mds point to | **keep** |
| `requirements-v1.md` | 168 ln | What LOOM is; §8 out-of-scope is load-bearing | Current (spec, not status) | **keep** |
| `roadmap.md` | 143 ln | What's shipped / what's next | **Freshest status doc in the repo** — use it as the cross-check oracle for everything else | **keep** |
| `ci-and-preview.md` | 145 ln | CI workflow + per-PR preview screenshots mechanics | Current; referenced from `CLAUDE.md:78` | **keep** |
| `stdlib-burndown.md` | 82 ln | M11 stdlib coverage checklist | **Marked COMPLETE 2026-06-12** (line 2); every box checked | **verify before acting → archive.** It's a finished checklist; its durable facts (the `mix`→`mixer` rename, the camera-ghost shoot caveat) should be confirmed present in `DECISIONS.md`/skill before moving it to `docs/history/` |

### `docs/history/` — already-archived originals

| File | Size | Purpose | Verdict |
|---|---|---|---|
| `implementation-plan-v1.md` | 170 ln | The original M0–M9 plan, kept verbatim; roadmap supersedes it (roadmap.md:3) | **keep archived** — DECISIONS entries reference it by name |
| `agent-updates-m0-m6.md` | 177 ln | M0–M6 build diary; explicitly retired (header line 1–5), superseded by DECISIONS SHIPPED entries | **keep archived** |

`docs/history/` is working exactly as intended — this is the model for where
finished `superpowers/` material should land.

### `docs/superpowers/` — per-feature plans & specs (the main cleanup target)

Ten plans (8733 ln total across plans+specs) and five specs, each the
work-artifact of a now-**shipped** milestone. Cross-checking each against the
roadmap Shipped table:

| Plan / spec | Size | Maps to (roadmap status) | Verdict |
|---|---|---|---|
| `plans/2026-06-10-param-modulators.md` | 1259 ln | Param modulators — **shipped** | **archive** |
| `plans/2026-06-11-console-react-mui.md` | 2204 ln | Console React+MUI rebuild — **shipped** | **archive** |
| `plans/2026-06-11-console-redesign.md` + `specs/…-console-redesign-design.md` | 333 + 116 ln | Console UI redesign — **shipped** | **archive** |
| `plans/2026-06-11-docs-refactor.md` + `specs/…-docs-refactor-design.md` | 762 + 128 ln | The docs refactor itself — **executed** (its target layout = current tree) | **archive** (this audit is the proof it shipped) |
| `plans/2026-06-11-housekeeping.md` | 158 ln | Housekeeping — **shipped** | **archive** |
| `plans/2026-06-11-m6-color-palettes.md` | 1363 ln | M6 palette half — **shipped** | **archive** |
| `plans/2026-06-11-mandelbloom.md` + `specs/…-mandelbloom-design.md` | 525 + 181 ln | mandelbloom scene — **verify** it's the shipped scene | **verify → archive** |
| `plans/2026-06-11-midi-button-bindings.md` + `specs/…-midi-button-bindings-design.md` | 1182 + 97 ln | MIDI button bindings — **shipped** (in `.claude/CLAUDE.md` tool docs) | **archive** |
| `plans/2026-06-11-stdlib-tests.md` + `specs/…-stdlib-tests-design.md` | 44 + 100 ln | Stdlib tests & robustness — **shipped** | **archive** |
| `plans/2026-06-12-console-ui-overhaul.md` | 281 ln | Console UI overhaul | **verify before acting** — overlaps the *open* [[console-ui-refactor]]; may still be a live reference, not dead |

**Finding:** with one exception, every `superpowers/` artifact corresponds to
shipped work. These are execution scratch (subagent-driven task lists with
checkboxes — see `docs-refactor.md:3`), not durable references. They are the
single largest pile of stale-but-not-worthless content in the tree.

**Recommendation (verify before acting):** introduce `docs/history/superpowers/`
(or `docs/superpowers/archive/`) and move every plan/spec whose milestone shows
shipped in the roadmap. **Do not delete** — they hold rationale that DECISIONS
sometimes only summarizes, and they're cheap on disk and zero-cost to agents
(nothing auto-loads them). The two to hold back: `console-ui-overhaul.md`
(check against [[console-ui-refactor]]) and anything an open feature-request
still cites. Confirm no validator, skill, or DECISIONS entry links a plan/spec
path before moving (`grep -rn 'superpowers/plans\|superpowers/specs'`).

### `.claude/skills/` — agent skills (pulled on demand)

| Skill | Size | Audience | Freshness | Verdict |
|---|---|---|---|---|
| `library-use/SKILL.md` | 61 ln | **Visuals** — search catalog before writing, register after | Current (M11) | **keep**; **relocate** → plugin |
| `module-authoring/SKILL.md` | 58 ln | **Visuals** — defineModule contract, shader gotchas | Current | **keep**; **relocate** → plugin |
| `scene-composition/SKILL.md` | 110 ln | **Visuals** — defineScene, InputBus, params | Current | **keep**; **relocate** → plugin |
| `validator-authoring/SKILL.md` | 68 ln | **Builder** — validator isolation contract | Current | **keep at root** (builder skill — stays even if plugin lands) |

The skills are healthy and correctly sized. The audit's job for them is **not**
trimming but **classifying by audience** so [[loom-user-plugin]] knows the cut:
three visuals skills go to the plugin, `validator-authoring` stays. The roadmap
also forward-references skills that **don't exist yet** — *panel-authoring*
(roadmap.md:95) and a perf-check step in a "commit skill" (roadmap.md:108). Those
are future, not gaps to fill now; note them so the plugin boundary anticipates them.

### `feature-requests/` — proposal backlog

14 files (398 ln). Two gold-standard fleshed-out proposals (`console-screenshot.md`
152 ln, `module-packs.md` 54 ln, `multi-input-chain-steps.md` 41 ln) plus this
batch of 2026-06-13 one-liner stubs (this file's siblings). **Verdict: keep, do
not touch.** The prior refactor explicitly ruled `feature-requests/` out of scope
(docs-refactor-design.md:128) and it's serving its purpose. One stub —
`panic-safe-scene-redesign.md` — overlaps the roadmap's post-v1 "PANIC safe-scene
mode" (roadmap.md:142, which points at a non-existent `feature-requests/panic-scene.md`);
**verify before acting:** reconcile the dangling roadmap link to the real file.

### Regenerated / not docs (leave alone)

- `content/CATALOG.md` — generated; never hand-edit (already auto-regens via the
  `loom:catalog` Vite plugin the refactor added).
- `preview/screenshots/README.md` (16 ln) — explains a tracked asset dir; keep.

## Proposed end-state (target shape)

```
CLAUDE.md            builder front door, ~stays 78 ln: orientation, never-go-black,
                     commands, conventions, PR screenshots, doc map. Pulls docs/ on
                     demand; pulls validator-authoring skill on demand. NEVER grows
                     an architecture section back (single source = docs/architecture.md).
README.md            human front door — status line corrected to match roadmap.
DECISIONS.md         append-only memory, greppable on demand (unchanged).
docs/
  architecture.md    how it's built (single source of truth)
  requirements-v1.md what it is
  roadmap.md         what's shipped / next  ← the freshness oracle
  ci-and-preview.md  CI + preview mechanics
  history/
    implementation-plan-v1.md, agent-updates-m0-m6.md   (as today)
    stdlib-burndown.md            ← moved (completed checklist)
    superpowers/                  ← shipped plans+specs moved here
  superpowers/                    ← ONLY in-flight plans/specs remain
.claude/
  CLAUDE.md          visuals-agent guide        ┐ relocate to loom-user-plugin
  skills/library-use, module-authoring,         │ (the "using LOOM" bundle)
         scene-composition                      ┘
  skills/validator-authoring                    ← stays (builder skill)
```

**What belongs where — the criteria** (this is the durable output; apply it to
future docs too):

- **Root `CLAUDE.md`:** only what *every builder agent* needs in *every* session
  and that changes rarely — orientation, the one inviolable invariant
  (never-go-black), the command surface, conventions. Everything deeper is a
  pointer. If a fact lives in `docs/`, CLAUDE.md links it, never restates it.
- **`docs/`:** durable references with a single owner each. Status → roadmap;
  how-built → architecture; what-it-is → requirements; CI → ci-and-preview.
- **`docs/history/` (+ `superpowers/` subfolder):** anything finished — build
  diaries, superseded plans, executed specs, completed checklists. Verbatim,
  never auto-loaded.
- **`docs/superpowers/`:** **only in-flight** plan/spec pairs. A plan graduates
  to `history/` the moment its milestone hits the roadmap Shipped table.
- **`.claude/` (→ plugin):** session-time agent context. Visuals skills + guide
  go to the plugin; builder skills stay at root.
- **`DECISIONS.md`:** the *why*; rationale and ≤6-line SHIPPED entries. Grepped,
  not read front-to-back.
- **`feature-requests/`:** proposals only. Out of scope for restructuring.

## Concrete action list (proposed — none executed here)

1. **act** — README status line (line 9) → match roadmap (M0–M11 + Layers/
   Projects/Fixtures shipped; remaining = M10 asset-explorer, panels/save-as,
   M12 gig-hardening = v1).
2. **act** — Add a one-line note to `docs/superpowers/` (a README, or the
   roadmap's logging section) defining the graduate-to-`history/` rule, so this
   pile doesn't re-accumulate.
3. **verify → archive** — `docs/stdlib-burndown.md` → `docs/history/`, after
   confirming its durable caveats live in DECISIONS/skill.
4. **verify → archive** — all `superpowers/` plan+spec pairs whose milestone is
   shipped (the table above), into `docs/history/superpowers/`. Grep for inbound
   links first. Hold back `console-ui-overhaul.md` pending [[console-ui-refactor]].
5. **verify** — reconcile roadmap.md:142's dead `feature-requests/panic-scene.md`
   link with the real `panic-safe-scene-redesign.md`.
6. **decide (don't move)** — ratify the plugin boundary: 3 visuals skills +
   `.claude/CLAUDE.md` → [[loom-user-plugin]]; `validator-authoring` stays.
   Sequence the actual move under that request.
7. **defer** — root `CLAUDE.md` command-block trimming until
   [[validator-test-consolidation]] settles the validator count.

## Recommendations & rationale

- **Archive, don't delete, the `superpowers/` material.** It's rationale-bearing
  and costs nothing (no agent auto-loads it). Deletion risks losing the only
  long-form record of a decision DECISIONS only summarizes. The reversible move
  is archive.
- **Make "where does this go" a rule, not a cleanup.** The reason this audit
  exists one milestone-cluster after the last refactor is that nothing told the
  next agent to retire its plan. Action #2 (the graduation rule) is the fix that
  prevents a third audit.
- **Don't pre-empt the plugin or the validator work.** The two highest-value
  relocations (visuals context → plugin; command block ← validator count) are
  owned by sibling requests. This audit's job is to draw the lines and sequence
  them, not to cut.
- **Leave the slim CLAUDE.md slim.** It's already at the target the user wants.
  The audit's main CLAUDE.md recommendation is *defensive*: a one-line "never
  restate architecture here" guard so it can't regrow the section the last
  refactor removed.

## Open questions

- **Archive location:** `docs/history/superpowers/` vs. `docs/superpowers/archive/`
  vs. a flat `docs/history/` with date-prefixed names. History-subfolder keeps the
  existing `docs/history/` convention; verify which the team prefers.
- **Plugin vs. monorepo for the visuals bundle:** does [[loom-user-plugin]]
  *move* `.claude/CLAUDE.md` + skills out, or *mirror* them (plugin packages a
  copy, repo keeps originals for in-repo dev sessions)? Mirroring avoids breaking
  the dogfooding session that builds LOOM in the same repo. This audit can't
  resolve it — flag it for the plugin design.
- **DECISIONS.md size (1405 ln / 112 KB):** correctly grep-on-demand today, but
  is it approaching the point where splitting by subsystem or year helps? Likely
  not yet (it's not auto-loaded), but worth a sentinel — revisit if it doubles.
- **`console-ui-overhaul.md` (2026-06-12):** shipped-and-archivable, or the live
  reference for the open [[console-ui-refactor]]? Resolve before moving.

## Out of scope

- Executing any move/delete/rewrite — this is the audit, not the action.
- Restructuring `feature-requests/` (ruled out by the prior refactor; still apt).
- Rewriting `requirements-v1.md` or `architecture.md` content (both current).
- The plugin extraction itself ([[loom-user-plugin]]) and the validator collapse
  ([[validator-test-consolidation]]) — this audit feeds them, doesn't do them.

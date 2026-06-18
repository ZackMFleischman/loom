# LOOM vs Resolume — feature comparison, gaps, and opportunities

A comparison of LOOM against **Resolume Arena/Avenue 7**, the industry-standard
VJ instrument, to surface (a) genuine capability gaps, (b) what could be
simplified, and (c) what could be made better.

> **Framing first — these are different instruments.** Resolume is a
> **clip-playback** instrument: you arrange pre-made media into a grid of
> layers × columns and *perform by triggering and mixing* it. LOOM is a
> **generative-code** instrument: you *author looks in natural language*, the
> engine hot-renders typed TypeScript, and you tweak/stage/commit. Many
> "gaps" below are deliberate scope decisions (`requirements-v1.md` §8) with
> designed seams, not oversights — but they still define what LOOM can't do
> in a room today, so they're ranked by performance impact, not by blame.

---

## 1. Side-by-side feature map

| Capability | Resolume Arena/Avenue 7 | LOOM (today) |
|---|---|---|
| **Content authoring** | Import pre-rendered media; light generators; FFGL/ISF shader plugins; Wire node patcher | **Natural-language → typed TS, hot-rendered live.** ~48 scenes, ~40 modules shipped |
| **Content nature** | Baked video clips (fixed res/length, large files) | Generative, parametric, audio-reactive at the structural level; tiny, git-versioned |
| **Performance surface** | Clip/column launch grid, layer faders, blend modes, deck crossfader, autopilot | Stage → commit crossfade (one instance at a time), projects (set lists), PANIC |
| **Layer compositing** | Many stacked layers, per-layer opacity + blend + masks, live mixing | `ctx.layer` named nodes w/ rigs; per-node + root FX chains; compositing authored **inside** a scene |
| **Effects** | Large drag-drop FX library (video + audio FX) on clip/layer/comp | ~30 effect modules; per-instance & per-node chains via `set_chain`; saved composite chains |
| **Parameter automation** | Dashboard + modifiers (LFO/audio/MIDI/OSC/envelope) on most params | `modulate_param` (sine/tri/ramp/square/random/drift/cycle/audio) on any non-color param; `set_color_space` splits colors into modulatable H/S/V·R/G/B |
| **Audio reactivity** | FFT bands → modifiers; per-param audio link | Named **input rack** (`kick`, `hats`, tuned variants), globally tuned, per-consumer trim |
| **Clock / BPM** | **Auto BPM detect, tap, Ableton Link, SMPTE timecode**, beat-quantized launch | **Manual BPM only** (tap `t` / `?bpm=`); beat tracking + look-ahead quantization are post-v1 |
| **MIDI** | MIDI map + learn, clock | MIDI-learn, CC channels, hot-plug (human-only binding in Console) |
| **OSC / DMX / Art-Net** | **OSC bidirectional, DMX/Art-Net out** | OSC post-v1; no DMX |
| **Live inputs** | Cameras, **capture cards, NDI in, Syphon/Spout in** | Webcam + video files; no capture-card / NDI / screen-capture ingest |
| **Output / mapping** | **Advanced Output: slices, warp, edge-blend, multi-projector soft-edge, LED fixture mapping, multi-display** | Single chrome-free fullscreen window, fixed 1080p, cover-scaled. Mapping/multi-out & NDI/Syphon/Spout **out of scope (§8)** |
| **Color** | Per-clip/layer color, palettes via effects | Two global 5-stop **palettes**, live source-switch with no rebuild, ramp/own helpers |
| **Recording** | Records program output to file | None (fixtures replay *inputs*; screenshots only) |
| **Text** | Text source + animators | No first-class text source |
| **Timeline** | Clip + composition timelines | None — everything is live/generative |
| **Project file** | Opaque binary `.avc` | **Plain text in git** — diffable, reproducible, no corruption |
| **Failure safety** | Can drop frames / crash on bad GPU state | **Never-go-black** as an architected 3-layer invariant |
| **Determinism/testing** | None | **Fixtures**: record input traces → byte-identical offline replay |
| **Use without the operator's core skill** | Fully usable by a non-coder VJ | Library scenes/params/MIDI/commit run offline, but *creating new looks* needs the agent or TS |

---

## 2. Where LOOM already leads Resolume

These are real, structural advantages — not catch-up items.

1. **Natural-language authoring.** Describe → it appears and self-corrects.
   Resolume has no equivalent; new content there means a separate
   AE/TouchDesigner/shader pipeline → export → import. LOOM collapses that
   into a sentence.
2. **Generative > baked.** A LOOM scene has infinite resolution, lives in a
   few KB, and is reactive at the structural level — "make the tunnel breathe
   harder with the bass" is a param tweak. A Resolume clip is a fixed video;
   you can color/effect it but you can't change what it *is*.
3. **A library that compounds.** The catalog + module packs + marketplace mean
   generated content is typed and composable, and the agent reuses *your*
   accumulated vocabulary. A Resolume clip folder is inert.
4. **Everything is text in git.** Reproducible from a clone, diffable,
   branchable, no binary-project corruption.
5. **Never-go-black is architected, not hoped-for.** Withheld HMR + `trySwap`
   (build before dispose) + per-instance freeze make content errors non-fatal
   *by design* — a stronger guarantee than Resolume's runtime.
6. **Deterministic replay (fixtures).** Recording the input rack and getting
   byte-identical frames back is a dev-grade capability Resolume lacks.
7. **Typed, parallel composition.** Signatures-first lets multiple agents build
   modules concurrently with `tsc` as the coordination protocol.

Roughly at parity: **parameter modulators** (LOOM's `modulate_param` ≈
Resolume's Dashboard modifiers — Resolume's is more visual/mature; LOOM's
color-channel decomposition is a nice touch) and **MIDI-learn**.

---

## 3. Gaps that matter (ranked by impact on real gigs)

1. **Output / projection mapping & multi-display (biggest).** Resolume Arena's
   Advanced Output — slices, warping, soft-edge blending, multi-projector, LED
   fixture mapping — is *the* feature that lets it drive real installations.
   LOOM is one rectangular fullscreen window. Anyone projecting onto a
   non-rectangular surface, blending projectors, or feeding an LED processor
   cannot run the gig on LOOM today. NDI/Syphon/Spout **out** also blocks the
   common "LOOM as a source into a Resolume/TouchDesigner master" topology.
   *(Explicitly §8; NDI is flagged as the thing that forces the native-shell
   decision.)*
2. **Clock sync — Ableton Link + auto beat detection.** Manual-tap-only BPM
   means the operator babysits tempo all night, and beat-quantized launches
   aren't possible. Playing alongside a DJ/Ableton rig, Link is table stakes.
   This also caps audio-reactivity quality (everything beat-derived inherits
   the manual error). *(On the roadmap, post-v1.)*
3. **A live launch/cue surface.** Resolume's whole performance model — a grid
   of columns you punch (beat-quantized), an autopilot that auto-advances,
   ride-the-faders layer mixing, a deck crossfader — has no LOOM analog.
   Stage→commit is one-instance-at-a-time; projects are set lists, not a
   tactile cue grid. LOOM is excellent at *building and tweaking*, thinner at
   *rapid-fire live triggering*.
4. **Live multi-layer mixing.** Resolume lets you ride N independent layers
   with blend modes onto the program in real time. In LOOM you composite
   *inside* a scene (code), and only one instance is routed to output — there's
   no live mixing desk of independent layers with blend modes.
5. **Live capture inputs (NDI/Syphon/Spout/capture-card/screen-grab in).**
   LOOM can't currently react to or composite a live camera/stage/desktop feed
   beyond webcam + files.
6. **OSC / DMX / Art-Net.** Blocks integration with lighting desks (GrandMA)
   and show-control rigs. *(OSC post-v1.)*
7. **Output recording.** No way to capture the show to a video file for
   archive/social.
8. **Text source.** No first-class branding/lyric/title animator.
9. **Non-operator authoring path.** LOOM's headline capability (AI authoring)
   is currently **terminal-gated** — a VJ without Claude Code in a terminal
   can play the library but can't *generate*. The embedded perform-mode chat
   pane is post-v1; until then the instrument's whole value prop has a high
   floor.

> Items 1, 5, 6, 7 are deliberately scoped out for v1 with designed seams
> (InputBus, source-module kind, Pane abstraction, MCP boundary). The point
> here isn't that they're missing by mistake — it's that they're what stands
> between LOOM and "trust it in a dark room" (the M12 goal).

---

## 4. What could be simplified

LOOM's conceptual surface is **large** compared to Resolume's "layers × clips +
effects." Newcomers must hold: instances, scenes, modules, layer-nodes,
root-vs-node chains, modulators, palettes, the input rack, projects, fixtures,
stage/commit, panic (hold/scene), the `globals` pseudo-instance, and the `live`
alias. Resolume's model is learnable in an hour. Candidates to collapse:

1. **Unify the four "compositing" mechanisms.** `ctx.layer` nodes, per-node
   chains, root chains, and the crossfade compositor are four overlapping ways
   to combine pixels. A single layer-stack abstraction that subsumes
   node-layers *and* a live program mixer would shrink the model **and** close
   gap #4 at the same time.
2. **Unify "what's on output."** LIVE vs STAGED vs sandbox tiles vs project
   instances vs the panic target is an intricate state space. Worth asking
   whether projects + stage + panic-scene can share one "cue" primitive.
3. **Thin the param-mutation tool surface.** `set_param`, `set_params`,
   `modulate_param`, `clear_modulation`, `set_modulation_enabled`,
   `set_color_space` are six verbs over "change a param." `batch`/`set_params`
   already generalize; the modulation verbs could collapse toward
   "set a param's *source*" (constant | modulator | binding) as one concept.
4. **Split the `globals` overload.** One pseudo-instance serving both rack
   tunings *and* palette stops (routed by path prefix) is clever but muddy —
   two unrelated subsystems behind one id.
5. **Smooth the solo-session loop.** "Stage, then ask the human to commit" is
   right for a show but ceremonious for solo dev; `agentCommit` arming helps,
   but the default solo flow could be one step shorter.

---

## 5. What could be made better (prioritized recommendations)

In rough order of leverage:

1. **Ship a basic Advanced-Output / mapping + NDI-out layer.** Even slices +
   warp + a second display, plus NDI/Syphon/Spout out, unlocks venue use and
   the "LOOM as a source" topology. Highest leverage for real-world adoption;
   accept that NDI forces the native-shell decision.
2. **Auto clock: Ableton Link + onset/BPM tracking (AudioWorklet).** Removes a
   whole class of manual upkeep and raises every beat-derived signal's quality.
   Already a contained InputBus upgrade per the roadmap.
3. **A live layer-mixer + beat-quantized cue grid in the Console.** Bring
   Resolume's ride-the-faders + punch-the-grid performance model on top of the
   existing `ctx.layer` infra and projects. Pairs with #2 for quantized
   launches. Closes gaps #3 and #4 and adds the tactile dimension LOOM lacks.
4. **Embedded perform-mode generate box (Agent SDK client on the MCP/WS
   boundary).** Make AI authoring reachable without a terminal — this is
   LOOM's whole differentiator and it shouldn't require Claude Code CLI.
5. **Live capture sources** (NDI/Syphon/Spout/capture-card in) as new
   source-kind modules — lets generative content react to and composite live
   feeds.
6. **Output recording** for archive/social capture.
7. **OSC in/out + a DMX/Art-Net bridge** for lighting/show-control integration.
8. **A text source module** with simple animators for branding/lyrics.
9. **Conceptual consolidation** per §4 — the model's breadth is a real
   onboarding tax; collapsing the compositing and output-state concepts pays
   off in both UX and code.

---

## 6. Bottom line

LOOM and Resolume optimize different halves of the VJ workflow. **Resolume wins
the live-performance surface** (mapping, multi-output, clip launching, layer
mixing, clock sync, hardware integration) — the mature, tactile, road-tested
instrument. **LOOM wins content creation** (natural-language generative
authoring, parametric reactivity, a compounding typed library, git-native
reproducibility, never-go-black safety) — things Resolume structurally cannot
do.

The strategic read: LOOM doesn't need to *become* Resolume. Its authoring
advantage is durable and unique. But to be trusted in a dark room (the M12
bar), the **performance and output layer** is where the gaps concentrate —
clock sync, a tactile cue/mixer surface, and output/mapping are the three
highest-leverage additions. And the conceptual surface, while powerful, is the
one place LOOM is *more* complex than Resolume; consolidating the compositing
and output-state concepts would make the instrument easier to hold without
losing any power.

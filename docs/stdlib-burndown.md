# Stdlib burndown — TD-inspired module coverage (M11 §6)

**COMPLETE (2026-06-12)** — all 33 modules + 8 showcase scenes shipped on the
`m11-stdlib` branch. Naming deviation: the burndown's `mix` landed as **`mixer`**
(the TSL `mix` import would shadow it in every file that composes both). The
shoot harness lacks a fake camera, so `camera-ghost`'s still shows the wash
without the keyed cam — the webcam path is proven by the stdlib smoke (which
runs Chromium's synthetic camera).

The agreed expansion list (2026-06-11), drawn from TouchDesigner's CHOP/TOP/SOP
families and filtered against what already exists (modulators cover LFO/Noise/
Pattern-CHOP attachment; the input rack IS the audio-analysis CHOP; `paletteMap`
= Lookup, `feedback` = Trail). Work the list top to bottom inside each kind —
the first five effects are dependency-ordered (`blur` → `threshold` → `bloom` →
`mix` → `displace` unlocks the most looks per module).

Every module merges with: `cases.ts` entry (tier-1/2 ride free), `chainParams`
on every effect (FX-picker eligible), `pnpm validate:stdlib` green. Every
showcase scene wraps its grabbables in `ctx.layer(...)` and consumes named rack
channels. Check items off as they merge.

## Effects (TOP filters)

- [x] **blur** — separable gaussian, `radius` Signal (Blur TOP). Stateful RT ping-pong. → *neon-bloom*
- [x] **threshold** — luma cutoff + softness (Threshold TOP); mask-maker, bloom ingredient. → *neon-bloom*
- [x] **bloom** — threshold → blur → add, tuned as one primitive (Bloom TOP). → *neon-bloom*
- [x] **mix** — blend TWO TexNodes: crossfade/add/multiply/screen/difference, `mix` Signal (Cross/Composite TOP). The A/B deck mixer. → *deck-mixer*
- [x] **displace** — warp input UVs by a second TexNode's luminance/RG (Displace TOP). RT-resample pattern, `glitch` is the reference. → *warp-room*
- [x] **hsv** — hue rotate / saturation / value as Signals (HSV Adjust TOP). → *deck-mixer*
- [x] **mirror** — axis reflect with offset/angle, pure UV (Mirror TOP). → *warp-room*
- [x] **tile** — UV repeat with per-tile flip (Tile TOP). → *warp-room*, *plasma-wall*
- [x] **echo** — N-frame ring buffer, `delay` + `mix` Signals (Time Machine/Cache TOP). Replays, where `feedback` accumulates. → *deck-mixer*, *camera-ghost*
- [x] **key** — chroma + luma keying to alpha, mode opt (Chroma Key TOP); makes any clip an `over` layer. → *camera-ghost*
- [x] **posterize** — color step count as Signal (Quantize). → *camera-ghost*
- [x] **invert** — trivial, conspicuous by absence. → *camera-ghost*
- [x] **rgbSplit** — chromatic aberration solo, angle/amount Signals. → *deck-mixer*
- [x] **vignette** — finishing-touch chain step. → *plasma-wall*
- [x] **crt** — scanlines/curvature/aberration bundle. → *plasma-wall*

## Sources (TOP generators)

- [x] **shape** — parametric circle/ring/rect/polygon, soft edge, premultiplied alpha (Circle/Rectangle TOP). → *neon-bloom*
- [x] **gradient** — linear/radial/angular ramp through `ctx.palette.ramp` (Ramp TOP); the gradient *scene* exists, this is the composable module. → *neon-bloom*
- [x] **solid** — flat color/palette stop (Constant TOP). Degenerate but load-bearing. → *type-strobe*
- [x] **checker** — checker/grid, counts + line width as Signals (Checkerboard/Grid TOP). → *plasma-wall*
- [x] **voronoi** — animated cellular noise (Voronoi TOP). → *warp-room*
- [x] **plasma** — classic sin-field interference. → *plasma-wall*
- [x] **text** — string → canvas-to-texture, font/size/weight opts (Text TOP). Re-render on string change; highest-value non-trivial source. → *type-strobe*
- [x] **webcam** — `getUserMedia` live camera, device picker opt, image/video placement contract (Video Device In TOP). → *camera-ghost*

## Control (CHOPs)

- [x] **envelope** — attack/release follower (Envelope/Slope CHOP); promotes the runtime's `envelopeSignal` to the catalog. → *spring-rave*
- [x] **remap** — in-range → out-range with curve lin/exp/smoothstep (Math/Range CHOP); kills `new Signal((f)=>…)` boilerplate. → *spring-rave*
- [x] **spring** — second-order bouncy follower, stiffness/damping (Spring CHOP). → *spring-rave*
- [x] **sampleHold** — sample on a trigger channel, hold (S+H CHOP); "new value per kick". → *type-strobe*
- [x] **gate** — threshold a signal to 0/1 with hysteresis (Logic CHOP). → *type-strobe*
- [x] **counter** — count onsets, wrap at N (Count CHOP); beat-stepped scene logic. → *type-strobe*

## Geo (SOP-ish)

- [x] **plane** — subdivided grid plane; the displacement substrate. → *rutt-etra*
- [x] **tube** — extruded path/cylinder; beams and tunnels. → *spring-rave*
- [x] **pointCloud** — render any GeoNode's vertices as instanced points (rides the M8 instancing machinery). → *rutt-etra*
- [x] **displaceGeo** — vertex displacement by noise on any GeoNode, amount as Signal (Noise SOP); the 3D sibling of `displace`. → *rutt-etra*

## Showcase scenes (each lands WITH the last module it needs)

- [x] **neon-bloom** — `shape` rings + `gradient` backdrop, kick-driven `threshold` → `blur` → `bloom` glow. *(blur, threshold, bloom, shape, gradient)*
- [x] **deck-mixer** — two `video` decks through `mix` on a crossfader param, `hsv` hue ride, `rgbSplit` + `echo` on the drop. *(mix, hsv, rgbSplit, echo)*
- [x] **warp-room** — `voronoi` displacing a video/noise bed via `displace`, folded by `mirror` + `tile`. *(displace, voronoi, mirror, tile)*
- [x] **camera-ghost** — `webcam` keyed by `key`, ghosted with `echo`, crushed by `posterize`/`invert` on the kick. *(webcam, key, echo, posterize, invert)*
- [x] **type-strobe** — `text` titles over `solid` flashes; `counter` steps lines per N beats, `sampleHold` re-rolls placement per kick, `gate` strobes. *(text, solid, counter, sampleHold, gate)*
- [x] **plasma-wall** — `plasma` + `checker` tiled into an arcade wall, finished with `crt` + `vignette`. *(plasma, checker, tile, crt, vignette)*
- [x] **rutt-etra** — `plane` displaced by `displaceGeo`, drawn as `pointCloud` scanlines under `orbitCam`; hippo-as-points cameo. *(plane, displaceGeo, pointCloud)*
- [x] **spring-rave** — `tube` beams scaled by `spring`-physics kicks, `envelope` + `remap` shaping every drive signal. *(spring, envelope, remap, tube)*

## Coverage check

Every module above appears in at least one scene; a scene merges only when its
modules render in it live (eyes-on screenshot) with the knobs that matter
surfaced as params.

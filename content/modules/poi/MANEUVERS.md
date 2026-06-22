# Poi maneuver catalog & transition graph

> Generated from `content/modules/poi/maneuvers.ts` — do not hand-edit.
> 44 maneuvers. Every move is one parametrization of the shared
> motion model (`motion.ts`): two heads, each a point on a string whose hand
> orbits a shoulder point. Arm/poi angles are *integrated from rates* and every
> target is *eased*, so any move flows smoothly into any other — the `flowsTo`
> edges below just say which transitions read as natural for the auto-sequencer.

## Basic spins

- **Forward Spin** `forward-spin` — Both poi wheel forward together — the home position.
  - flows to: `split-time`, `reverse-spin`, `3-beat-weave`, `windmill`, `extension`
- **Reverse Spin** `reverse-spin` — Both poi wheel backward together.
  - flows to: `forward-spin`, `split-time`, `2-beat-weave`, `windmill`
- **Split-Time Spin** `split-time` — The two poi run a half-beat apart — one up while one's down.
  - flows to: `forward-spin`, `together-time`, `butterfly`, `stall-switch`, `4-petal-antispin`
- **Same-Time Spin** `together-time` — Both heads locked in phase, sweeping as one.
  - flows to: `split-time`, `butterfly`, `wall-plane-spin`, `windmill`
- **Extension** `extension` — Long strings, slow wheel — wide arcs that fill the frame.
  - flows to: `forward-spin`, `comet`, `windmill`, `5-beat-weave`
- **Wall-Plane Spin** `wall-plane-spin` — Flat to the audience, two clean discs side by side.
  - flows to: `windmill`, `fountain`, `together-time`, `turning-spin`
- **Turning Spin** `turning-spin` — The whole pattern slowly turns as if the spinner pivots.
  - flows to: `forward-spin`, `windmill`, `cat-eye`, `comet`
- **Butterfly** `butterfly` — Both poi out front mirrored — the classic crossing wings.
  - flows to: `split-butterfly`, `buzzsaw`, `forward-spin`, `wall-plane-spin`, `flower-butterfly`
- **Split-Time Butterfly** `split-butterfly` — Mirrored wings half a beat apart — they kiss and part.
  - flows to: `butterfly`, `buzzsaw`, `flower-butterfly`, `stall-switch`

## Flowers

- **Flower Butterfly** `flower-butterfly` — A butterfly bent into antispin petals — a blooming wing.
  - flows to: `butterfly`, `4-petal-antispin`, `6-petal-inspin`, `split-butterfly`
- **3-Petal Antispin** `3-petal-antispin` — A trefoil of three crisp scalloped petals.
  - flows to: `4-petal-antispin`, `3-petal-inspin`, `isolation`, `split-time`
- **4-Petal Antispin** `4-petal-antispin` — Four petals, the signature antispin flower.
  - flows to: `5-petal-antispin`, `4-petal-inspin`, `flower-butterfly`, `cat-eye`
- **5-Petal Antispin** `5-petal-antispin` — Five-pointed star bloom — dense and hypnotic.
  - flows to: `4-petal-antispin`, `6-petal-inspin`, `isolation`
- **6-Petal Antispin** `6-petal-antispin` — Six petals — a fast, lacy rosette.
  - flows to: `5-petal-antispin`, `5-petal-inspin`, `cat-eye`
- **3-Petal Inspin** `3-petal-inspin` — Three rounded inspin lobes curling outward.
  - flows to: `4-petal-inspin`, `3-petal-antispin`, `isolation`
- **4-Petal Inspin** `4-petal-inspin` — Four inspin lobes — a soft pinwheel.
  - flows to: `5-petal-inspin`, `4-petal-antispin`, `flower-butterfly`
- **5-Petal Inspin** `5-petal-inspin` — Five inspin lobes spiralling round the center.
  - flows to: `6-petal-inspin`, `5-petal-antispin`
- **6-Petal Inspin** `6-petal-inspin` — Six inspin lobes — a tight churning daisy.
  - flows to: `5-petal-inspin`, `6-petal-antispin`, `isolation`

## Weaves

- **2-Beat Weave** `2-beat-weave` — The simplest weave — two beats across the body.
  - flows to: `3-beat-weave`, `forward-spin`, `windmill`
- **3-Beat Weave** `3-beat-weave` — The bread-and-butter weave — three beats woven side to side.
  - flows to: `5-beat-weave`, `2-beat-weave`, `windmill`, `turning-weave`, `forward-spin`
- **5-Beat Weave** `5-beat-weave` — A long luxurious weave — five beats of looping arcs.
  - flows to: `3-beat-weave`, `turning-weave`, `extension`
- **Turning Weave** `turning-weave` — A weave that rotates the whole body as it travels.
  - flows to: `3-beat-weave`, `turning-spin`, `thread-the-needle`
- **Thread the Needle** `thread-the-needle` — Tight crossed weave — the strings thread through a gap.
  - flows to: `3-beat-weave`, `tractor`, `windmill`

## Windmills / wheel-plane

- **Windmill** `windmill` — Wheel plane, split-time — the textbook windmill turning over.
  - flows to: `fountain`, `forward-spin`, `3-beat-weave`, `tractor`, `wall-plane-spin`
- **Fountain** `fountain` — Same as a windmill but same-time — water arcing up and out.
  - flows to: `windmill`, `wall-plane-spin`, `butterfly`, `tractor`
- **Tractor** `tractor` — Both poi on one side, stacked wheels grinding together.
  - flows to: `windmill`, `fountain`, `barrel-roll`, `thread-the-needle`
- **Barrel Roll** `barrel-roll` — Wheel plane tumbling forward, strings long and lazy.
  - flows to: `windmill`, `comet`, `tractor`, `extension`

## Stalls & redirects

- **Stall & Switch** `stall-switch` — One beat of stall, then the poi reverse and flow on.
  - flows to: `forward-spin`, `split-time`, `pendulum`, `comet`
- **Pendulum** `pendulum` — Both poi swing like a clock, never closing the circle.
  - flows to: `stall-switch`, `buzzsaw`, `forward-spin`
- **Buzzsaw** `buzzsaw` — A tight pendulum in front — the poi saw back and forth fast.
  - flows to: `butterfly`, `pendulum`, `split-butterfly`
- **Point Stall** `point-stall` — The poi freeze at the top, hang, then drop back — a held beat.
  - flows to: `stall-switch`, `extension`, `forward-spin`

## Wraps, binds & air wraps

- **Spiral Wrap** `spiral-bind` — The strings spiral inward and snap back out — a wind-up bind.
  - flows to: `air-wrap`, `4-petal-antispin`, `isolation`, `comet`
- **Air Wrap** `air-wrap` — A poi wraps the empty air and unspools — a whipping coil.
  - flows to: `spiral-bind`, `comet`, `windmill`
- **Body Wrap** `body-wrap` — The strings coil close to the center then bloom open.
  - flows to: `spiral-bind`, `tractor`, `isolation`

## Hybrids & advanced

- **CAP** `cap` — Center-axis point — a four-petal antispin orbiting one fixed point.
  - flows to: `4-petal-antispin`, `isolated-triquetra`, `hybrid-thread`, `isolation`
- **Hybrid Thread** `hybrid-thread` — One poi inspins while the other antispins — woven asymmetry.
  - flows to: `cap`, `flower-butterfly`, `3-petal-antispin`
- **Triquetra** `triquetra` — A three-cornered woven knot that keeps folding through itself.
  - flows to: `isolated-triquetra`, `cap`, `5-petal-antispin`

## Isolations & CATs

- **Isolation** `isolation` — Two heads hang dead still while the strings sweep haloes around them.
  - flows to: `cat-eye`, `3-petal-antispin`, `two-bean`, `isolated-triquetra`
- **Cat-Eye** `cat-eye` — A pinched almond orbit — the isolation loosened into an eye.
  - flows to: `isolation`, `two-bean`, `4-petal-antispin`
- **Two-Bean** `two-bean` — Two kidney-bean isolations chasing nose to tail.
  - flows to: `isolation`, `cat-eye`, `isolated-triquetra`
- **Isolated Triquetra** `isolated-triquetra` — A three-lobed knot of isolations woven into a trinity.
  - flows to: `isolation`, `two-bean`, `5-petal-antispin`

## Showpieces

- **Comet** `comet` — A single slow heavy sweep with a long burning tail.
  - flows to: `extension`, `stall-switch`, `forward-spin`, `spiral-bind`, `barrel-roll`
- **Flower Comet** `flower-comet` — An antispin flower drawn huge and slow — petals as comet tails.
  - flows to: `comet`, `4-petal-antispin`, `isolation`
- **Supernova** `supernova` — Everything wide open, fast and mirrored — a blazing bloom.
  - flows to: `flower-comet`, `supernova`, `flower-butterfly`, `triquetra`

## Transition graph (adjacency)

```
forward-spin
  → split-time, reverse-spin, 3-beat-weave, windmill, extension
reverse-spin
  → forward-spin, split-time, 2-beat-weave, windmill
split-time
  → forward-spin, together-time, butterfly, stall-switch, 4-petal-antispin
together-time
  → split-time, butterfly, wall-plane-spin, windmill
extension
  → forward-spin, comet, windmill, 5-beat-weave
wall-plane-spin
  → windmill, fountain, together-time, turning-spin
turning-spin
  → forward-spin, windmill, cat-eye, comet
windmill
  → fountain, forward-spin, 3-beat-weave, tractor, wall-plane-spin
fountain
  → windmill, wall-plane-spin, butterfly, tractor
tractor
  → windmill, fountain, barrel-roll, thread-the-needle
barrel-roll
  → windmill, comet, tractor, extension
butterfly
  → split-butterfly, buzzsaw, forward-spin, wall-plane-spin, flower-butterfly
split-butterfly
  → butterfly, buzzsaw, flower-butterfly, stall-switch
flower-butterfly
  → butterfly, 4-petal-antispin, 6-petal-inspin, split-butterfly
3-petal-antispin
  → 4-petal-antispin, 3-petal-inspin, isolation, split-time
4-petal-antispin
  → 5-petal-antispin, 4-petal-inspin, flower-butterfly, cat-eye
5-petal-antispin
  → 4-petal-antispin, 6-petal-inspin, isolation
6-petal-antispin
  → 5-petal-antispin, 5-petal-inspin, cat-eye
3-petal-inspin
  → 4-petal-inspin, 3-petal-antispin, isolation
4-petal-inspin
  → 5-petal-inspin, 4-petal-antispin, flower-butterfly
5-petal-inspin
  → 6-petal-inspin, 5-petal-antispin
6-petal-inspin
  → 5-petal-inspin, 6-petal-antispin, isolation
isolation
  → cat-eye, 3-petal-antispin, two-bean, isolated-triquetra
cat-eye
  → isolation, two-bean, 4-petal-antispin
two-bean
  → isolation, cat-eye, isolated-triquetra
isolated-triquetra
  → isolation, two-bean, 5-petal-antispin
2-beat-weave
  → 3-beat-weave, forward-spin, windmill
3-beat-weave
  → 5-beat-weave, 2-beat-weave, windmill, turning-weave, forward-spin
5-beat-weave
  → 3-beat-weave, turning-weave, extension
turning-weave
  → 3-beat-weave, turning-spin, thread-the-needle
thread-the-needle
  → 3-beat-weave, tractor, windmill
stall-switch
  → forward-spin, split-time, pendulum, comet
pendulum
  → stall-switch, buzzsaw, forward-spin
buzzsaw
  → butterfly, pendulum, split-butterfly
point-stall
  → stall-switch, extension, forward-spin
spiral-bind
  → air-wrap, 4-petal-antispin, isolation, comet
air-wrap
  → spiral-bind, comet, windmill
body-wrap
  → spiral-bind, tractor, isolation
cap
  → 4-petal-antispin, isolated-triquetra, hybrid-thread, isolation
hybrid-thread
  → cap, flower-butterfly, 3-petal-antispin
triquetra
  → isolated-triquetra, cap, 5-petal-antispin
comet
  → extension, stall-switch, forward-spin, spiral-bind, barrel-roll
flower-comet
  → comet, 4-petal-antispin, isolation
supernova
  → flower-comet, supernova, flower-butterfly, triquetra
```

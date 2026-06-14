# Streaming live audio into LOOM (SonoBus & friends)

How to drive LOOM's audio-reactive rack from a **network audio stream** —
e.g. a bandmate sending Ableton out over [SonoBus](https://sonobus.net) — instead
of (or in addition to) a local microphone. The same recipe works for any source
that can reach a system audio device: SonoBus, Dante/Dante Via, a hardware
interface return, ReaStream, etc.

## How LOOM hears audio

LOOM's Output window is a **plain browser tab**. It has no native audio access and
cannot speak SonoBus's protocol directly. All audio enters through one chokepoint —
`AudioBus.startMic(deviceId)` in `packages/runtime/src/inputbus/audio.ts` — which
calls `getUserMedia` and connects the resulting `MediaStream` into a single
`AnalyserNode`. From there `update()` computes the FFT bands the input rack
(`content/inputs.ts`: `kick`, `bass`, `hats`, …) reads every frame.

The consequence: **anything that appears as an audio *input device* on your OS can
feed LOOM.** So the job is simply to land the network stream onto a virtual input
device, then pick that device in the Console's audio picker.

```
remote Ableton ──SonoBus──▶ SonoBus standalone (receiver, your machine)
                                   │ output →
                                   ▼
                          virtual audio device (loopback)
                                   │ getUserMedia(deviceId)
                                   ▼
                 LOOM AudioBus → AnalyserNode → input rack (kick/bass/hats)
```

> **The sender never changes anything.** Your friend keeps sending from Ableton
> over SonoBus exactly as before. Every step below is on the *receiving* machine —
> it just replaces whatever was consuming the stream previously (TouchDesigner,
> a DAW, etc.).

### Music, not voice — the constraints matter

LOOM requests its input stream with `echoCancellation`, `noiseSuppression`, and
`autoGainControl` **disabled** (and stereo), because those browser voice-DSP
features pump levels and gouge holes in the spectrum — they destroy beat and onset
detection on music. This is handled for you in `startMic`; you don't need to
configure anything. It's noted here so the behaviour isn't surprising: LOOM
deliberately takes the raw signal.

## Setup per OS

The pattern is identical everywhere — **route SonoBus's output to a virtual audio
device, then choose that device in LOOM** — only the loopback tool differs.

### macOS — BlackHole (free) or Loopback

1. Install a virtual device:
   - [BlackHole](https://existential.audio/blackhole/) (free, 2ch is plenty), or
   - [Rogue Amoeba Loopback](https://rogueamoeba.com/loopback/) (paid, friendlier routing + you can monitor).
2. Open **SonoBus** (standalone) and connect to your friend's group/session as you
   do today.
3. In SonoBus, set the **output device to BlackHole 2ch** (SonoBus ▸ Options ▸
   audio output). If you also want to *hear* it, use Loopback (which can fan out to
   BlackHole **and** your speakers) or create a macOS **Aggregate/Multi-Output
   Device** in *Audio MIDI Setup*.
4. In LOOM's Console audio picker, select **BlackHole 2ch**. Done.

### Windows — VB-CABLE

1. Install [VB-CABLE](https://vb-audio.com/Cable/) (donationware). It creates
   *CABLE Input* (a playback device) and *CABLE Output* (a recording device).
2. In **SonoBus**, set the **output device to "CABLE Input"**.
3. In LOOM's audio picker, select **"CABLE Output"** (the recording side of the
   cable).
4. To also monitor the audio, install **VB-CABLE A+B** or **VoiceMeeter** (same
   vendor) and route the cable to both your headphones and LOOM, or enable
   *Listen to this device* on CABLE Output in Windows Sound settings.

> Prefer ASIO-low-latency? SonoBus speaks ASIO; pair it with VoiceMeeter's virtual
> ASIO device. For most visual work the plain VB-CABLE path is robust enough.

### Linux — PipeWire (or JACK)

Modern distros run **PipeWire**, which makes this the cleanest of the three.

1. Create a virtual sink:
   ```sh
   pactl load-module module-null-sink \
     media.class=Audio/Sink sink_name=loom_in \
     channel_map=stereo
   ```
2. Run **SonoBus** and connect to the session.
3. Point SonoBus's output at the `loom_in` sink — either in SonoBus's audio prefs
   or with a patchbay (`qpwgraph` / `Helvum`), wiring SonoBus → `loom_in`.
4. In LOOM's audio picker, select the **"Monitor of loom_in"** input.

On a JACK setup, run SonoBus under JACK and connect its output ports to the LOOM
browser's capture ports with `qjackctl`/`Carla`.

## Verify it's working

1. Start the engine (`pnpm dev`) and open the Console.
2. Pick the virtual device in the audio picker (top of the Console header).
3. Watch the input meters: `get_session` returns live channel values under
   `inputs`, and the rack tunings live on the `"globals"` manifest. With music
   flowing you should see `kick`/`bass`/`hats` move.
4. Nothing moving? Tune the rack on `"globals"` — raise `inputs.<name>.gain`, lower
   `inputs.kick.threshold` — with `set_param`/`set_params`. Confirm SonoBus is
   actually outputting to the virtual device (its level meters), and that the
   stream isn't silent at the source.

## Why not a native SonoBus client in LOOM?

SonoBus uses a proprietary AOO/UDP protocol with no browser/JS client, and LOOM's
engine is a sandboxed browser tab with no socket access. A direct client would
mean reimplementing that protocol in the Node sidecar (large, fragile, no latency
win over a loopback device) or building a native audio shell (out of scope per
`docs/requirements-v1.md`). SonoBus's own jitter buffer already handles network
resilience, so the virtual-device route is both the simplest and the most robust.
WebRTC would give the lowest browser-native latency but requires the *sender* to
change his setup — which defeats the goal.

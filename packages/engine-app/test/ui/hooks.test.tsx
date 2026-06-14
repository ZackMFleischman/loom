import type { ReactNode } from "react";
import type { PreviewFrame, SessionSnapshot } from "@loom/sidecar/protocol";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useEngine, useEngineState, usePreviewFrame, useThumb } from "../../src/ui/hooks";
import { FakeEngineLink, withEngine } from "./fake-engine-link";

const SESS = { live: "boot", staged: null } as unknown as SessionSnapshot;
const wrapper = (link: FakeEngineLink) => (props: { children: ReactNode }) =>
  withEngine(link, props.children);

describe("useEngine", () => {
  it("throws when no EngineProvider is mounted", () => {
    expect(() => renderHook(() => useEngine())).toThrow(/EngineProvider missing/);
  });

  it("returns the provided link", () => {
    const link = new FakeEngineLink();
    const { result } = renderHook(() => useEngine(), { wrapper: wrapper(link) });
    expect(result.current).toBe(link.asLink());
  });
});

describe("useEngineState", () => {
  it("starts from the link's initial snapshot (disconnected)", () => {
    const link = new FakeEngineLink();
    const { result } = renderHook(() => useEngineState(), { wrapper: wrapper(link) });
    expect(result.current).toEqual({ session: null, manifests: {}, connected: false });
  });

  it("re-renders with a new snapshot when the engine pushes state", () => {
    const link = new FakeEngineLink();
    const { result } = renderHook(() => useEngineState(), { wrapper: wrapper(link) });

    act(() => link.pushState(SESS, { boot: {} }));

    expect(result.current.connected).toBe(true);
    expect(result.current.session).toBe(SESS);
    expect(result.current.manifests).toEqual({ boot: {} });
  });

  it("reflects connection flips without losing session", () => {
    const link = new FakeEngineLink();
    const { result } = renderHook(() => useEngineState(), { wrapper: wrapper(link) });
    act(() => link.pushState(SESS));
    expect(result.current.connected).toBe(true);

    act(() => link.setConnected(false));
    expect(result.current.connected).toBe(false);
    expect(result.current.session).toBe(SESS);
  });
});

describe("useThumb", () => {
  it("returns undefined for a null id and never subscribes spuriously", () => {
    const link = new FakeEngineLink();
    const { result } = renderHook(() => useThumb(null), { wrapper: wrapper(link) });
    expect(result.current).toBeUndefined();
  });

  it("returns the latest thumb for an id and updates on push", () => {
    const link = new FakeEngineLink();
    const { result } = renderHook(() => useThumb("boot"), { wrapper: wrapper(link) });
    expect(result.current).toBeUndefined();

    act(() => link.pushThumb("boot", "data:image/png;base64,AAA"));
    expect(result.current).toBe("data:image/png;base64,AAA");

    act(() => link.pushThumb("boot", "data:image/png;base64,BBB"));
    expect(result.current).toBe("data:image/png;base64,BBB");
  });

  it("ignores thumbs pushed for other instances", () => {
    const link = new FakeEngineLink();
    const { result } = renderHook(() => useThumb("boot"), { wrapper: wrapper(link) });
    act(() => link.pushThumb("other", "data:image/png;base64,ZZZ"));
    expect(result.current).toBeUndefined();
  });
});

describe("usePreviewFrame", () => {
  it("starts null and updates when a frame is pushed", () => {
    const link = new FakeEngineLink();
    const { result } = renderHook(() => usePreviewFrame(), { wrapper: wrapper(link) });
    expect(result.current).toBeNull();

    const frame = { instance: "boot", width: 2, height: 2, data: "x" } as unknown as PreviewFrame;
    act(() => link.pushPreview(frame));
    expect(result.current).toBe(frame);
  });
});

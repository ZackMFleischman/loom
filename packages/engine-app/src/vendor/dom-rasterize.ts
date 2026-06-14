/**
 * dom-rasterize — a minimal, vendored SVG-`foreignObject` DOM rasterizer.
 *
 * Why vendored instead of `html-to-image` (NFR-1): this code runs inside the
 * PERFORMANCE browser, the same process driving the live Output. A pinned npm
 * rasterizer is ~1–2k lines of transitive surface we'd have to trust on that
 * machine; the slice LOOM's Console actually needs (vanilla DOM + already-
 * dataURL `<img>` thumbnails + `<canvas>` tiles, all same-origin) is ~120 lines.
 * Vendoring it keeps the audit in-repo and removes a supply-chain dep from the
 * performance path. The technique is the well-known one html-to-image uses:
 * clone the subtree → inline computed styles → serialize to XHTML → wrap in an
 * SVG `<foreignObject>` → draw that SVG to a `<canvas>` → export.
 *
 * SAME-ORIGIN ONLY (feature constraint): we never fetch external resources. An
 * external <img> would taint the canvas and make `toDataURL` throw — the
 * Console deliberately loads none (thumbnails are dataURLs), and inlined
 * <canvas> snapshots are same-origin bitmaps. Keep it that way or capture breaks.
 *
 * The SVG image draw is asynchronous and can reject (oversized canvas, malformed
 * markup); callers map that to a structured error rather than a hung request.
 */

export type RasterizeOptions = {
  /** Cap the output width in px; the height scales to preserve aspect. 0 = native. */
  maxWidth?: number;
  /** Background painted under the DOM (foreignObject backgrounds can be transparent). */
  background?: string;
  /** Device pixel ratio to render at (defaults to the live window's). */
  pixelRatio?: number;
};

export type RasterizeResult = { dataUrl: string; width: number; height: number };

/** Attributes the SVG XML parser rejects if they hold raw `&`/`<`; escape them. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Copy the *computed* style of `src` onto `dst` inline. foreignObject renders
 * from inline styles only — external stylesheets and class rules don't apply —
 * so every visible property must be flattened onto the element itself.
 */
function inlineStyles(src: Element, dst: Element): void {
  const computed = window.getComputedStyle(src);
  const style = (dst as HTMLElement).style;
  for (let i = 0; i < computed.length; i++) {
    const prop = computed.item(i);
    style.setProperty(prop, computed.getPropertyValue(prop), computed.getPropertyPriority(prop));
  }
}

/**
 * Deep-clone `node` with styles inlined at every level, snapshotting any
 * <canvas> into an <img> (a clone of a canvas is blank — its bitmap doesn't
 * copy). Returns null for nodes that can't/shouldn't serialize (e.g. a tainted
 * canvas), so the rest of the tree still captures.
 */
function cloneInlined(node: Element): Element | null {
  if (node instanceof HTMLCanvasElement) {
    const img = document.createElement("img");
    try {
      img.src = node.toDataURL(); // same-origin canvas → dataURL; tainted → throws
    } catch {
      return null; // drop a tainted tile rather than fail the whole capture
    }
    inlineStyles(node, img);
    img.width = node.width;
    img.height = node.height;
    return img;
  }

  const clone = node.cloneNode(false) as Element;
  if (node instanceof HTMLElement) inlineStyles(node, clone);

  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      clone.appendChild(child.cloneNode(true));
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const childClone = cloneInlined(child as Element);
      if (childClone != null) clone.appendChild(childClone);
    }
  }
  return clone;
}

/** Serialize a cloned, style-inlined element to an SVG-embeddable XHTML string. */
function serializeToXhtml(el: Element): string {
  // The clone must be XHTML-namespaced inside foreignObject, and serialized with
  // XMLSerializer (not innerHTML) so void elements close and attributes escape.
  el.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  return new XMLSerializer().serializeToString(el);
}

/**
 * Rasterize a live DOM element to a PNG data URL via the SVG-foreignObject
 * technique. Async (the SVG-as-image decode is async) and rejects on a failed
 * decode/oversized canvas so the caller can surface a clean error.
 */
export async function rasterize(target: HTMLElement, opts: RasterizeOptions = {}): Promise<RasterizeResult> {
  const rect = target.getBoundingClientRect();
  const srcW = Math.max(1, Math.ceil(rect.width));
  const srcH = Math.max(1, Math.ceil(rect.height));
  const ratio = opts.pixelRatio ?? window.devicePixelRatio ?? 1;

  // Output cap: scale DOWN to maxWidth (never up); 0/undefined = native * ratio.
  const cap = opts.maxWidth && opts.maxWidth > 0 ? opts.maxWidth : srcW * ratio;
  const scale = Math.min(cap / srcW, ratio);
  const outW = Math.max(1, Math.round(srcW * scale));
  const outH = Math.max(1, Math.round(srcH * scale));

  const clone = cloneInlined(target);
  if (clone == null) throw new Error("nothing to rasterize");
  // Pin the clone's box to the measured size so foreignObject lays it out the
  // same way the live element is laid out.
  const cloneStyle = (clone as HTMLElement).style;
  cloneStyle.width = `${srcW}px`;
  cloneStyle.height = `${srcH}px`;
  cloneStyle.margin = "0";

  const xhtml = serializeToXhtml(clone);
  const bg = opts.background != null ? `<rect width="100%" height="100%" fill="${escapeAttr(opts.background)}"/>` : "";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${srcW}" height="${srcH}" viewBox="0 0 ${srcW} ${srcH}">` +
    bg +
    `<foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject>` +
    `</svg>`;

  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = await loadImage(url);

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (ctx == null) throw new Error("2d context unavailable for rasterize");
  if (opts.background != null) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, outW, outH);
  }
  ctx.drawImage(image, 0, 0, outW, outH);

  // toDataURL throws on a tainted or oversized canvas — let it propagate.
  return { dataUrl: canvas.toDataURL("image/png"), width: outW, height: outH };
}

/** Load a data-URL SVG into an <img>, rejecting (never hanging) on decode failure. */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("SVG rasterization failed to decode (markup or size)"));
    img.src = url;
  });
}

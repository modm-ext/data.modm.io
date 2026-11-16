// Copyright 2026, Niklas Hauser
// SPDX-License-Identifier: MPL-2.0
// @ts-check
// The register map of a peripheral variant on a zoomable canvas: one row per register, its bit
// fields coloured by the feature they belong to, bits that no field covers hatched. It takes the
// variant data and draws into a container, nothing else, so other pages and the MCP server can
// show it too. Colours come from the CSS variables of ../shared/theme.css and variant-view.css.

import {clamp, el} from "../shared/util.js";
import {accessTag, describe, hue, label, layout, matches, offset} from "./model.js";

/** @typedef {import("./model.js").Variant} Variant */
/** @typedef {import("./model.js").Row} Row */
/** @typedef {import("./model.js").Target} Target */
/** @typedef {{k: number, ox: number, oy: number}} View pixels per bit and the offset of bit 31 of the first register */
/**
 * @typedef {{select: (target: Target | null) => void, setFeature: (index: number | null) => void,
 *            setFilter: (pattern: RegExp | null) => void, destroy: () => void}} MapControl
 */

const GUTTER = 150;            // fixed left column with the register names
const ROW_RATIO = 2;           // a bit is this many times taller than it is wide
const K_MIN = 1, K_MAX = 90;   // pixels per bit
const FONT_MONO = '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace';
const FONT_SANS = '"IBM Plex Sans", system-ui, -apple-system, sans-serif';

/** @type {Map<string, number>} */
const widths = new Map();

/** @param {CanvasRenderingContext2D} ctx @param {string} text */
function textWidth(ctx, text) {
  const key = `${ctx.font}|${text}`;
  let width = widths.get(key);
  if (width === undefined) {
    width = ctx.measureText(text).width;
    widths.set(key, width);
  }
  return width;
}

/** @param {CanvasRenderingContext2D} ctx @param {string} text @param {number} x @param {number} y @param {number} maxWidth */
function fitText(ctx, text, x, y, maxWidth) {
  if (textWidth(ctx, text) > maxWidth) return false;
  ctx.fillText(text, x, y);
  return true;
}

/** @param {CanvasRenderingContext2D} ctx @param {string} text @param {number} cx @param {number} cy @param {number} maxLength */
function fitTextRotated(ctx, text, cx, cy, maxLength) {
  if (textWidth(ctx, text) > maxLength) return false;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(text, 0, 0);
  ctx.restore();
  return true;
}

/** @param {Target | null} a @param {Target | null} b */
function same(a, b) {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind || a.kind === "feature" || b.kind === "feature" || a.row !== b.row) return false;
  return a.kind === "register" || (b.kind === "field" && a.item === b.item);
}

/**
 * Draws the register map of a variant into the container and makes it zoomable, pannable and
 * clickable. The container gets the class "regmap" and should have a height.
 * @param {HTMLElement} container
 * @param {Variant} variant
 * @param {{feature?: number | null, filter?: RegExp | null, view?: View,
 *          onSelect?: (target: Target | null) => void, onView?: (view: View) => void}} [options]
 *   feature: fades all other fields, filter: marks matching fields and fades other registers,
 *   view: the zoom to start with instead of fitting the width, onSelect: a click into the map,
 *   onView: the zoom or offset changed
 * @returns {MapControl}
 */
export function renderMap(container, variant, {feature = null, filter = null, view, onSelect, onView} = {}) {
  const canvas = /** @type {HTMLCanvasElement} */ (el("canvas"));
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "Zoomable register map, drag to pan and ctrl+scroll to zoom");
  const tip = el("div", "tip");
  tip.hidden = true;
  const zoom = el("div", "zoom");
  for (const [text, factor] of /** @type {const} */ ([["−", 1 / 1.6], ["+", 1.6]])) {
    const button = el("button", "", text);
    button.setAttribute("type", "button");
    button.title = text === "+" ? "Zoom in" : "Zoom out";
    button.addEventListener("click", () => zoomAt(GUTTER + (map.width - GUTTER) / 2, map.height / 2, factor));
    zoom.append(button);
  }
  container.classList.add("regmap");
  container.replaceChildren(canvas, tip, zoom, el("span", "hint", "drag to pan · ctrl+scroll to zoom · click for details"));

  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  const L = layout(variant);
  const map = {
    k: 8, ox: GUTTER, oy: 0, width: 0, height: 0, dpr: 1, frame: 0,
    /** @type {Target | null} */ hover: null,
    /** @type {Target | null} */ selected: null,
    /** @type {Record<string, string> | null} */ colors: null,
    /** @type {CanvasPattern | null} */ hatch: null,
  };

  function readColors() {
    const style = getComputedStyle(canvas);
    const value = (/** @type {string} */ name) => style.getPropertyValue(name).trim();
    map.colors = {
      surface: value("--surface"), band: value("--band"), ink: value("--ink"),
      muted: value("--muted"), faint: value("--faint"), rule: value("--rule"),
      ruleStrong: value("--rule-strong"), accent: value("--accent"), mark: value("--mark"),
      coreBg: value("--core-bg"), coreLine: value("--core-line"),
      s: value("--feat-s"), lineL: value("--feat-line-l"), bgL: value("--feat-bg-l"), inkL: value("--feat-ink-l"),
    };
    const tile = document.createElement("canvas");
    tile.width = tile.height = 6;
    const t = /** @type {CanvasRenderingContext2D} */ (tile.getContext("2d"));
    t.strokeStyle = value("--hatch");
    t.lineWidth = 1;
    t.beginPath();
    t.moveTo(-1, 5); t.lineTo(5, -1);
    t.moveTo(1, 7); t.lineTo(7, 1);
    t.stroke();
    map.hatch = ctx.createPattern(tile, "repeat");
  }

  const color = (/** @type {number} */ index, /** @type {string} */ lightness) =>
    `hsl(${hue(index)} ${map.colors?.s} ${lightness})`;
  const featureFill = (/** @type {number} */ index) => color(index, map.colors?.bgL ?? "");
  const featureLine = (/** @type {number} */ index) => color(index, map.colors?.lineL ?? "");
  const featureInk = (/** @type {number} */ index) => color(index, map.colors?.inkL ?? "");

  const rowHeight = () => map.k * ROW_RATIO;
  const sx = (/** @type {number} */ bit) => map.ox + bit * map.k;
  const sy = (/** @type {number} */ row) => map.oy + row * rowHeight();

  function resize() {
    const rect = canvas.getBoundingClientRect();
    map.dpr = window.devicePixelRatio || 1;
    map.width = rect.width;
    map.height = rect.height;
    canvas.width = Math.round(rect.width * map.dpr);
    canvas.height = Math.round(rect.height * map.dpr);
    readColors();
    draw();
  }

  function fitView() {
    map.k = clamp((map.width - GUTTER - 24) / 32, K_MIN, 56);
    map.ox = GUTTER + 12;
    map.oy = 10;
    clampView();
    draw();
  }

  function clampView() {
    const width = map.width - GUTTER, height = map.height;
    const contentW = 32 * map.k, contentH = L.rowCount * rowHeight();
    map.ox = clamp(map.ox, GUTTER + Math.min(12, width - contentW), GUTTER + Math.max(12, width - contentW));
    map.oy = clamp(map.oy, Math.min(10, height - contentH - 10), 10);
    onView?.({k: map.k, ox: map.ox, oy: map.oy});
  }

  /** @param {number} px @param {number} py @param {number} factor */
  function zoomAt(px, py, factor) {
    const k = clamp(map.k * factor, K_MIN, K_MAX), f = k / map.k;
    map.ox = px - (px - map.ox) * f;
    map.oy = py - (py - map.oy) * f;
    map.k = k;
    clampView();
    draw();
  }

  /** @param {Target} target */
  function zoomTo(target) {
    if (target.kind === "feature") return;
    const width = target.kind === "field" ? target.item.field.width : target.row.bits;
    const k = clamp(((map.width - GUTTER) * 0.7) / width, K_MIN, K_MAX);
    const bit = target.kind === "field"
      ? 32 - target.row.bits + target.item.start + width / 2 : 32 - target.row.bits / 2;
    const row = target.row.y + (target.kind === "field" ? target.item.lane + 0.5 : target.row.height / 2);
    map.k = k;
    map.ox = GUTTER + (map.width - GUTTER) / 2 - bit * k;
    map.oy = map.height / 2 - row * rowHeight();
    clampView();
    draw();
  }

  function draw() {
    if (!map.frame) map.frame = requestAnimationFrame(() => { map.frame = 0; paint(); });
  }

  /* ------------------------------------------------------------- drawing */

  function paint() {
    const C = map.colors, W = map.width, H = map.height;
    if (!C || !W) return;
    const pattern = filter;
    const rowH = rowHeight();

    ctx.setTransform(map.dpr, 0, 0, map.dpr, 0, 0);
    ctx.fillStyle = C.surface;
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = "middle";

    const first = Math.max(0, Math.floor((-map.oy) / rowH) - 2);
    const last = Math.min(L.rowCount, Math.ceil((H - map.oy) / rowH) + 2);

    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, 0, W - GUTTER, H);
    ctx.clip();
    for (const row of L.rows) {
      if (row.y + row.height < first || row.y > last) continue;
      drawRegister(row, pattern);
    }
    if (map.hover && map.hover !== map.selected) outline(map.hover, C.accent, 1.5);
    if (map.selected && map.selected.kind !== "feature") outline(map.selected, C.ink, 2);
    ctx.restore();

    // Gutter with the register names
    ctx.fillStyle = C.surface;
    ctx.fillRect(0, 0, GUTTER, H);
    ctx.fillStyle = C.rule;
    ctx.fillRect(GUTTER - 1, 0, 1, H);
    // Zoomed out, the rows are thinner than a label, so only label as many as fit
    let lastLabel = -Infinity;
    const selectedRow = map.selected && map.selected.kind !== "feature" ? map.selected.row : null;
    for (const row of L.rows) {
      if (row.y + row.height < first || row.y > last) continue;
      const top = sy(row.y), height = row.height * rowH;
      if (top > H || top + height < 0) continue;
      const y = top + Math.min(height, 20) / 2;
      const dimmed = pattern && !matches(pattern, row);
      if (y - lastLabel < 14 && row !== selectedRow) continue;
      lastLabel = y;
      ctx.font = `10.5px ${FONT_MONO}`;
      ctx.textAlign = "left";
      ctx.fillStyle = dimmed ? C.faint : C.muted;
      ctx.fillText((row.register.offsets ? "~" : "") + offset(row.register.offset), 10, y);
      ctx.font = `600 11.5px ${FONT_SANS}`;
      ctx.fillStyle = dimmed ? C.faint : row.register.feature < 0 ? C.ink : featureLine(row.register.feature);
      let name = row.register.names[0] || "?";
      const tag = accessTag(row.register);
      const room = GUTTER - 68 - (tag ? 18 : 0);
      while (name.length > 3 && textWidth(ctx, name) > room) name = name.slice(0, -2) + "…";
      ctx.fillText(name, 58, y);
      if (tag) {
        ctx.font = `600 9px ${FONT_MONO}`;
        ctx.fillStyle = C.faint;
        ctx.textAlign = "right";
        ctx.fillText(tag, GUTTER - 8, y);
      }
    }
  }

  /** @param {Row} row @param {RegExp | null} pattern */
  function drawRegister(row, pattern) {
    const C = /** @type {Record<string, string>} */ (map.colors), rowH = rowHeight();
    const x = sx(32 - row.bits), y = sy(row.y);
    const w = row.bits * map.k, h = row.height * rowH;
    if (y > map.height || y + h < 0) return;
    const dimmed = pattern && !matches(pattern, row);
    ctx.globalAlpha = dimmed ? 0.25 : 1;

    // The register itself, with the bits that no field covers left hatched. Too small for the
    // hatching and the outline, the register is filled solid so that its extent stays visible.
    const outlined = h >= 4;
    ctx.fillStyle = outlined ? C.band : C.rule;
    ctx.fillRect(x, y, w, h);
    if (map.hatch && outlined) { ctx.fillStyle = map.hatch; ctx.fillRect(x, y, w, h); }

    const showText = rowH >= 13;
    for (const {field, lane, start} of row.items) {
      const fx = sx(32 - row.bits + start), fy = y + lane * rowH;
      const fw = field.width * map.k, fh = rowH;
      const hit = pattern && field.names.some((n) => pattern.test(n));
      if (feature !== null && field.feature !== feature) {
        ctx.globalAlpha = dimmed ? 0.12 : 0.28;
      }
      ctx.fillStyle = hit ? C.mark : field.feature < 0 ? C.coreBg : featureFill(field.feature);
      ctx.fillRect(fx, fy, fw, fh);
      ctx.strokeStyle = field.feature < 0 ? C.coreLine : featureLine(field.feature);
      ctx.lineWidth = 1;
      // A field that moved inside its register is drawn at every position it takes, dashed apart
      if (field.relocated) ctx.setLineDash([3, 2]);
      if (fw >= 3 && fh >= 4) ctx.strokeRect(fx + 0.5, fy + 0.5, fw - 1, fh - 1);
      ctx.setLineDash([]);
      if (showText) {
        ctx.fillStyle = field.feature < 0 ? C.ink : featureInk(field.feature);
        const name = field.names[0] || "";
        ctx.textAlign = "center";
        const size = clamp(Math.min(fw, fh) * 0.62, 7.5, 12);
        ctx.font = `${size.toFixed(1)}px ${FONT_MONO}`;
        // Bit fields are taller than they are wide, so their names read vertically
        if (fh >= fw) {
          if (fw >= 8 && !fitTextRotated(ctx, name, fx + fw / 2 + size / 3, fy + fh / 2, fh - 6)) {
            fitText(ctx, name, fx + fw / 2, fy + fh / 2, fw - 4);
          }
        } else if (!fitText(ctx, name, fx + fw / 2, fy + fh / 2, fw - 5)) {
          if (fw >= 8) fitTextRotated(ctx, name, fx + fw / 2 + size / 3, fy + fh / 2, fh - 6);
        }
      }
      ctx.globalAlpha = dimmed ? 0.25 : 1;
    }

    if (outlined) {
      ctx.strokeStyle = row.register.feature < 0 ? C.ruleStrong : featureLine(row.register.feature);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
    }

    // Bit numbers below the register once there is room for them
    if (map.k >= 15 && rowH >= 56) {
      ctx.font = `9.5px ${FONT_MONO}`;
      ctx.fillStyle = C.faint;
      ctx.textAlign = "center";
      ctx.globalAlpha = dimmed ? 0.25 : 0.8;
      for (let bit = 0; bit < row.bits; bit++) {
        ctx.fillText(String(bit), sx(32 - 1 - bit) + map.k / 2, y + h - 7);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** @param {Target} target @param {string} stroke @param {number} width */
  function outline(target, stroke, width) {
    if (target.kind === "feature") return;
    const rowH = rowHeight(), row = target.row;
    const [x, y, w, h] = target.kind === "register"
      ? [sx(32 - row.bits), sy(row.y), row.bits * map.k, row.height * rowH]
      : [sx(32 - row.bits + target.item.start), sy(row.y) + target.item.lane * rowH, target.item.field.width * map.k, rowH];
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.strokeRect(x, y, w, h);
  }

  /**
   * @param {number} px @param {number} py
   * @returns {Target | null}
   */
  function hitTest(px, py) {
    if (px < GUTTER) return null;
    const rowIndex = (py - map.oy) / rowHeight();
    const row = L.rows.find((r) => rowIndex >= r.y && rowIndex < r.y + r.height);
    if (!row) return null;
    const bit = (px - map.ox) / map.k;
    if (bit < 32 - row.bits || bit > 32) return null;
    const start = bit - (32 - row.bits);
    const lane = Math.floor(rowIndex - row.y);
    const item = row.items.find((i) => i.lane === lane && start >= i.start && start < i.start + i.field.width);
    return item ? {kind: "field", row, item} : {kind: "register", row};
  }

  /** @param {Target | null} target */
  function select(target) {
    map.selected = target;
    onSelect?.(target);
    draw();
  }

  /* -------------------------------------------------------- interactions */

  /** @type {Map<number, {x: number, y: number}>} */
  const pointers = new Map();
  /** @type {{x: number, y: number, ox: number, oy: number, moved: boolean} | null} */
  let drag = null;
  /** @type {{distance: number} | null} */
  let pinch = null;

  canvas.addEventListener("pointerdown", (event) => {
    canvas.focus({preventScroll: true});
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, {x: event.offsetX, y: event.offsetY});
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = {distance: Math.hypot(a.x - b.x, a.y - b.y)};
      drag = null;
    } else {
      drag = {x: event.offsetX, y: event.offsetY, ox: map.ox, oy: map.oy, moved: false};
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, {x: event.offsetX, y: event.offsetY});
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.distance > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, distance / pinch.distance);
      pinch.distance = distance;
      return;
    }
    if (drag && pointers.has(event.pointerId)) {
      const dx = event.offsetX - drag.x, dy = event.offsetY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 3) {
        drag.moved = true;
        canvas.classList.add("dragging");
        tip.hidden = true;
      }
      if (drag.moved) {
        map.ox = drag.ox + dx;
        map.oy = drag.oy + dy;
        clampView();
        draw();
      }
      return;
    }
    const hit = hitTest(event.offsetX, event.offsetY);
    if (!same(hit, map.hover)) { map.hover = hit; draw(); }
    if (!hit) { tip.hidden = true; return; }
    tip.replaceChildren(el("strong", "", label(hit)), el("span", "", describe(hit, variant)));
    tip.hidden = false;
    tip.style.left = `${Math.min(event.offsetX + 14, map.width - tip.offsetWidth - 8)}px`;
    tip.style.top = `${event.offsetY + 18 + tip.offsetHeight > map.height
      ? event.offsetY - tip.offsetHeight - 10 : event.offsetY + 18}px`;
  });

  const end = (/** @type {PointerEvent} */ event) => {
    const wasClick = drag && !drag.moved && pointers.size === 1 && event.type === "pointerup";
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    canvas.classList.remove("dragging");
    if (wasClick) select(hitTest(event.offsetX, event.offsetY));
    drag = null;
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", () => {
    if (drag) return;
    tip.hidden = true;
    if (map.hover) { map.hover = null; draw(); }
  });

  canvas.addEventListener("dblclick", (event) => {
    const hit = hitTest(event.offsetX, event.offsetY);
    if (hit) { select(hit); zoomTo(hit); } else { zoomAt(event.offsetX, event.offsetY, 2); }
  });

  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? map.height : 1;
    if (event.ctrlKey || event.metaKey) {
      zoomAt(event.offsetX, event.offsetY, Math.exp(-event.deltaY * scale * 0.0025));
    } else {
      map.ox -= (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * scale;
      map.oy -= (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * scale;
      clampView();
      draw();
    }
  }, {passive: false});

  canvas.addEventListener("keydown", (event) => {
    const cx = GUTTER + (map.width - GUTTER) / 2, cy = map.height / 2;
    switch (event.key) {
      case "ArrowUp": map.oy += 80; break;
      case "ArrowDown": map.oy -= 80; break;
      case "ArrowLeft": map.ox += 80; break;
      case "ArrowRight": map.ox -= 80; break;
      case "PageUp": map.oy += map.height * 0.9; break;
      case "PageDown": map.oy -= map.height * 0.9; break;
      case "+": case "=": zoomAt(cx, cy, 1.5); break;
      case "-": case "_": zoomAt(cx, cy, 1 / 1.5); break;
      case "0": fitView(); return;
      case "Escape": select(null); return;
      default: return;
    }
    event.preventDefault();
    clampView();
    draw();
  });

  const observer = new ResizeObserver(() => resize());
  observer.observe(canvas);
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  const recolor = () => { readColors(); draw(); };
  scheme.addEventListener("change", recolor);

  // The size is known once the container is laid out
  requestAnimationFrame(() => {
    resize();
    if (view) {
      map.k = view.k;
      map.ox = view.ox;
      map.oy = view.oy;
      clampView();
      draw();
    } else {
      fitView();
    }
  });

  return {
    select,
    setFeature(index) { feature = index; draw(); },
    setFilter(pattern) { filter = pattern; draw(); },
    destroy() {
      observer.disconnect();
      scheme.removeEventListener("change", recolor);
      if (map.frame) cancelAnimationFrame(map.frame);
    },
  };
}

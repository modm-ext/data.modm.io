// Copyright 2026, Niklas Hauser
// SPDX-License-Identifier: MPL-2.0
// @ts-check
// The address space of a device on a canvas: peripherals with their unused space, registers and
// their bit fields, zoomable and pannable, with an overview strip and hover tips. renderMap draws
// into a container and returns a controller, renderDetails describes one node for a side card.
// Neither knows about the page around them. Styles: ../shared/theme.css, register-view.css
// (access colours) and map-view.css.

import {clamp, el, esc, hexBits, plural} from "../shared/util.js";
import {ACCESS, WRITES, bitRange, bitsValue, countOf, offsetText, sizeText} from "./parse.js";
import {renderRegister} from "./register-view.js";

/** @typedef {import("./parse.js").Device} Device */
/** @typedef {import("./parse.js").Node} Node */
/** @typedef {import("./parse.js").Filter} Filter */
/**
 * @typedef {{node: Node, start: number, end: number, registersEnd: number, regs: Node[], inferred: boolean,
 *            v: number, vend: number, r0: number, r1: number, drawn: boolean}} Extent a peripheral on the map
 * @typedef {{node: Node, v: number, bytes: number, per: Extent}} Item a register on the map
 * @typedef {{v: number, y: number, rows: number}} Segment consecutive rows from address v at row y
 * @typedef {{y: number, rows: number, from: number, to: number, hidden?: boolean}} Fold folded address space
 * @typedef {{R: number, pers: Extent[], regs: Item[], segs: Segment[], folds: Fold[], byNode: Map<number, Extent | Item>,
 *            dense: boolean, rows: number, maxBytes: number}} Layout
 * @typedef {{row: number, col: number, rows: number, cols: number}} Rect
 * @typedef {{v: number, len: number, item?: any, field?: Node}} Span
 */

const GUTTER = 168;          // address labels on the left
const OVERVIEW = 56;         // overview strip on the right
const ROW_UNITS = 1;         // row height in bytes, so a 32-bit register is 4:1 and a bit 8:1
const headerHeight = (/** @type {number} */ h) => (h >= 44 ? 16 : 0);        // register name above the bit fields
const bitNumbersHeight = (/** @type {number} */ h, /** @type {number} */ bitW) => (bitW >= 15 && h >= 90 ? 14 : 0);
const MAX_GAP_BYTES = 0x800; // larger gaps between peripherals are folded
const FOLD_ROWS = 1.5;
const HIDDEN_ROWS = 0.5;     // marker height for hidden empty rows
const BLOCK = 0x400;         // assumed address block size without addressBlock
const K_MAX = 360;
const FONT_MONO = '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace';
const FONT_SANS = '"IBM Plex Sans", system-ui, -apple-system, sans-serif';

const registerBytes = (/** @type {Node} */ node) => {
  const bytes = Math.max(1, Math.ceil((node.size || 32) / 8));
  return node.dim ? (node.dim - 1) * Math.max(node.increment || 0, bytes) + bytes : bytes;
};
/** The last index of a sorted list whose key is at most value. */
const lastIndex = (/** @type {any[]} */ list, /** @type {string} */ key, /** @type {number} */ value) => {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid][key] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
};

/**
 * The address space map of a device.
 * @param {HTMLElement} container gets the canvases, keeps its other children (e.g. a details card)
 * @param {Device | null} device
 * @param {{filter?: Filter | null, rowBytes?: number, dense?: boolean, visible?: boolean,
 *          onSelect?: (node: Node | null) => void}} [options]
 *   rowBytes: bytes per row, dense: hide rows without registers, visible: false while the container is
 *   hidden (nothing is laid out or drawn until setVisible(true)), onSelect: after the selection changed
 */
export function renderMap(container, device, {filter = null, rowBytes = 64, dense = false, visible = true, onSelect = () => {}} = {}) {
  container.classList.add("map-frame");
  const canvas = /** @type {HTMLCanvasElement} */ (el("canvas", "map-canvas"));
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "Address space map. Arrow keys move, plus and minus zoom, Escape clears the selection.");
  const overview = /** @type {HTMLCanvasElement} */ (el("canvas", "map-overview"));
  overview.setAttribute("aria-hidden", "true");
  const tip = el("div", "map-tip");
  tip.hidden = true;
  container.prepend(canvas, overview, tip);

  const map = {
    /** @type {Layout | null} */ layout: null, rowBytes, dense, k: 1, ox: GUTTER + 12, oy: 12, width: 0, height: 0, dpr: 1,
    /** @type {Node | null} */ selected: null, /** @type {Node | null} */ hover: null,
    /** @type {Record<string, any> | null} */ colors: null, /** @type {CanvasPattern | null} */ hatch: null, frame: 0, anim: 0,
  };
  const mapCtx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  const overviewCtx = /** @type {CanvasRenderingContext2D} */ (overview.getContext("2d"));

  function reset() {
    map.layout = null;
    map.selected = null;
    map.hover = null;
    tip.hidden = true;
    onSelect(null);
    if (visible) {
      ensureLayout();
      scheduleDraw();
    }
  }

  function readColors() {
    const style = getComputedStyle(container);
    const v = (/** @type {string} */ name) => style.getPropertyValue(name).trim();
    map.colors = {
      surface: v("--surface"), band: v("--band"), ink: v("--ink"), muted: v("--muted"), faint: v("--faint"),
      rule: v("--rule"), ruleStrong: v("--rule-strong"), accent: v("--accent"), accentSoft: v("--accent-soft"),
      mark: v("--mark"), periph: v("--periph"), hatch: v("--hatch"),
      rw: [v("--reg-rw"), v("--reg-rw-line")], ro: [v("--reg-ro"), v("--reg-ro-line")], wo: [v("--reg-wo"), v("--reg-wo-line")],
    };
    const tile = document.createElement("canvas");
    tile.width = tile.height = 8;
    const t = /** @type {CanvasRenderingContext2D} */ (tile.getContext("2d"));
    t.strokeStyle = map.colors.hatch;
    t.lineWidth = 1.2;
    t.beginPath();
    t.moveTo(-1, 9); t.lineTo(9, -1);
    t.moveTo(-1, 1); t.lineTo(1, -1);
    t.moveTo(7, 9); t.lineTo(9, 7);
    t.stroke();
    map.hatch = mapCtx.createPattern(tile, "repeat");
  }

  /** @returns {Layout} */
  function buildLayout() {
    const R = map.rowBytes;
    /** @type {Extent[]} */
    const pers = [];
    for (const node of /** @type {Device} */ (device).peripherals) {
      /** @type {Node[]} */
      const regs = [];
      const visit = (/** @type {Node} */ parent) => {
        for (const child of parent.children) {
          if (child.type === "register") regs.push(child);
          else if (child.type === "cluster") visit(child);
        }
      };
      visit(node);
      regs.sort((a, b) => /** @type {number} */ (a.address) - /** @type {number} */ (b.address));
      const start = /** @type {number} */ (node.address);
      let registersEnd = start;
      for (const r of regs) registersEnd = Math.max(registersEnd, /** @type {number} */ (r.address) + registerBytes(r));
      pers.push(/** @type {Extent} */ ({node, start, registersEnd, regs, inferred: !node.blockSize}));
    }
    pers.sort((a, b) => a.start - b.start || a.registersEnd - b.registersEnd);
    // The extent is the address block, or the registers rounded up to a block without overlapping the next peripheral
    pers.forEach((P, i) => {
      let end = P.node.blockSize ? P.start + P.node.blockSize : P.start + Math.ceil(Math.max(4, P.registersEnd - P.start) / BLOCK) * BLOCK;
      const next = pers.slice(i + 1).find((o) => o.start > P.start);
      if (P.inferred && next && next.start < end) end = Math.max(next.start, P.registersEnd);
      P.end = Math.max(end, P.registersEnd, P.start + 4);
    });

    /** @type {Segment[]} */ const segs = [];
    /** @type {Fold[]} */ const folds = [];
    /** @type {Item[]} */ const regs = [];
    const address = (/** @type {Node} */ r) => /** @type {number} */ (r.address);
    if (!map.dense) {
      /** @type {Segment | null} */
      let seg = null, segEnd = 0;
      for (const P of pers) {
        const rowAddress = Math.floor(P.start / R) * R;
        const endAddress = Math.ceil(P.end / R) * R;
        if (!seg) {
          seg = {v: rowAddress, y: 0, rows: 0};
          segs.push(seg);
          segEnd = endAddress;
        } else if (rowAddress > segEnd && rowAddress - segEnd > MAX_GAP_BYTES) {
          seg.rows = (segEnd - seg.v) / R;
          const y = seg.y + seg.rows;
          folds.push({y, rows: FOLD_ROWS, from: segEnd, to: rowAddress});
          seg = {v: rowAddress, y: y + FOLD_ROWS, rows: 0};
          segs.push(seg);
          segEnd = endAddress;
        } else {
          segEnd = Math.max(segEnd, endAddress);
        }
        P.v = P.start;
        P.vend = P.end;
        for (const r of P.regs) regs.push({node: r, v: address(r), bytes: registerBytes(r), per: P});
      }
      if (seg) seg.rows = (segEnd - seg.v) / R;
    } else {
      // Only rows without any register are hidden, the space between registers is kept
      const occupied = new Set();
      for (const P of pers) {
        P.v = P.start;
        P.vend = P.end;
        occupied.add(Math.floor(P.start / R) * R);
        for (const r of P.regs) {
          const bytes = registerBytes(r);
          regs.push({node: r, v: address(r), bytes, per: P});
          for (let row = Math.floor(address(r) / R) * R; row < address(r) + bytes; row += R) occupied.add(row);
        }
      }
      /** @type {Segment | null} */
      let seg = null;
      for (const row of [...occupied].sort((a, b) => a - b)) {
        if (seg && row === seg.v + seg.rows * R) {
          seg.rows++;
          continue;
        }
        if (seg) {
          const y = seg.y + seg.rows;
          folds.push({y, rows: HIDDEN_ROWS, from: seg.v + seg.rows * R, to: row, hidden: true});
          seg = {v: row, y: y + HIDDEN_ROWS, rows: 1};
        } else {
          seg = {v: row, y: 0, rows: 1};
        }
        segs.push(seg);
      }
    }
    regs.sort((a, b) => a.v - b.v || b.bytes - a.bytes);
    /** @type {Map<number, Extent | Item>} */
    const byNode = new Map();
    for (const P of pers) byNode.set(P.node.id, P);
    for (const r of regs) byNode.set(r.node.id, r);
    const last = segs[segs.length - 1];
    /** @type {Layout} */
    const layout = {
      R, pers, regs, segs, folds, byNode, dense: map.dense,
      rows: last ? last.y + last.rows : 0,
      maxBytes: regs.reduce((max, r) => Math.max(max, r.bytes), 4),
    };
    // Visible rows of each peripheral
    for (const P of pers) {
      const rects = spanRects(P.v, P.vend - P.v, layout);
      P.r0 = rects.length ? rects[0].row : 0;
      P.r1 = rects.length ? rects[rects.length - 1].row + rects[rects.length - 1].rows : 0;
      P.drawn = rects.length > 0;
    }
    return layout;
  }

  function ensureLayout() {
    if (!device || map.layout) return;
    map.layout = buildLayout();
    fitWidth();
  }

  /* Geometry: columns are bytes, rows are multiples of rowBytes */
  const sx = (/** @type {number} */ col) => map.ox + col * map.k;
  const sy = (/** @type {number} */ row) => map.oy + row * ROW_UNITS * map.k;
  /** @returns {Rect[]} */
  function spanRects(/** @type {number} */ v, /** @type {number} */ len, L = /** @type {Layout} */ (map.layout)) {
    const R = L.R, rects = [];
    const end = v + len;
    let a = v;
    while (a < end) {
      const index = Math.max(0, lastIndex(L.segs, "v", a));
      const s = L.segs[index];
      if (a < s.v) {
        a = s.v;
        continue;
      }
      const d = a - s.v, rowIndex = Math.floor(d / R), row = s.y + rowIndex, col = d % R;
      // Continue with the next segment after folded or hidden rows
      if (rowIndex >= s.rows) {
        const next = L.segs[index + 1];
        if (!next || next.v >= end) break;
        a = next.v;
        continue;
      }
      if (col === 0 && end - a >= 2 * R) {
        const full = Math.min(Math.floor((end - a) / R), s.rows - rowIndex);
        rects.push({row, col: 0, rows: full, cols: R});
        a += full * R;
      } else {
        const n = Math.min(end - a, R - col);
        rects.push({row, col, rows: 1, cols: n});
        a += n;
      }
    }
    return rects;
  }

  /* Outline of an address span, e.g. a peripheral that starts and ends within a row */
  function spanPath(/** @type {CanvasRenderingContext2D} */ ctx, /** @type {number} */ v, /** @type {number} */ len) {
    const rects = spanRects(v, len), R = /** @type {Layout} */ (map.layout).R;
    ctx.beginPath();
    const contiguous = rects.every((r, i) => !i || Math.abs(r.row - (rects[i - 1].row + rects[i - 1].rows)) < 1e-6);
    if (rects.length === 1 || rects.length > 3 || !contiguous) {
      for (const r of rects) ctx.rect(sx(r.col), sy(r.row), r.cols * map.k, r.rows * ROW_UNITS * map.k);
      return rects;
    }
    const first = rects[0], last = rects[rects.length - 1];
    const top = first.row, bottom = last.row + last.rows, startCol = first.col, endCol = last.col + last.cols;
    ctx.moveTo(sx(startCol), sy(top));
    ctx.lineTo(sx(R), sy(top));
    if (endCol < R) {
      ctx.lineTo(sx(R), sy(bottom - 1));
      ctx.lineTo(sx(endCol), sy(bottom - 1));
      ctx.lineTo(sx(endCol), sy(bottom));
    } else {
      ctx.lineTo(sx(R), sy(bottom));
    }
    ctx.lineTo(sx(0), sy(bottom));
    if (startCol > 0) {
      ctx.lineTo(sx(0), sy(top + 1));
      ctx.lineTo(sx(startCol), sy(top + 1));
    } else {
      ctx.lineTo(sx(0), sy(top));
    }
    ctx.closePath();
    return rects;
  }

  /** @returns {Span | null} */
  function spanOf(/** @type {Node | null} */ node) {
    const L = map.layout;
    if (!L || !node) return null;
    if (node.type === "enum") node = /** @type {Node} */ (node.parent);
    if (node.type === "field") {
      const item = /** @type {Item | undefined} */ (L.byNode.get(/** @type {Node} */ (node.parent).id));
      return item ? {v: item.v, len: item.bytes, item, field: node} : null;
    }
    if (node.type === "cluster") {
      let lo = Infinity, hi = -Infinity;
      const visit = (/** @type {Node} */ parent) => {
        for (const child of parent.children) {
          const item = /** @type {Item | undefined} */ (L.byNode.get(child.id));
          if (child.type === "register" && item) {
            lo = Math.min(lo, item.v);
            hi = Math.max(hi, item.v + item.bytes);
          } else if (child.type === "cluster") visit(child);
        }
      };
      visit(node);
      return lo < hi ? {v: lo, len: hi - lo} : null;
    }
    const item = /** @type {any} */ (L.byNode.get(node.id));
    if (!item) return null;
    return node.type === "peripheral" ? {v: item.v, len: item.vend - item.v, item} : {v: item.v, len: item.bytes, item};
  }

  const colorsFor = (/** @type {string | null | undefined} */ access) => {
    const C = /** @type {Record<string, any>} */ (map.colors);
    const short = ACCESS[access ?? ""];
    return short === "ro" ? C.ro : short === "wo" ? C.wo : C.rw;
  };

  /** @type {Map<string, number>} */
  const widths = new Map();
  function fitText(/** @type {CanvasRenderingContext2D} */ ctx, /** @type {string} */ text, /** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ maxWidth) {
    const key = ctx.font + "|" + text;
    let width = widths.get(key);
    if (width === undefined) {
      width = ctx.measureText(text).width;
      if (widths.size > 50000) widths.clear();
      widths.set(key, width);
    }
    if (width > maxWidth) return false;
    ctx.fillText(text, x, y);
    return true;
  }

  function fitTextRotated(
    /** @type {CanvasRenderingContext2D} */ ctx, /** @type {string} */ text, /** @type {number} */ cx, /** @type {number} */ cy,
    /** @type {number} */ maxLength, /** @type {number} */ maxThickness, /** @type {number} */ fontSize,
  ) {
    if (fontSize > maxThickness) return false;
    const key = ctx.font + "|" + text;
    let width = widths.get(key);
    if (width === undefined) {
      width = ctx.measureText(text).width;
      widths.set(key, width);
    }
    if (width > maxLength) return false;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(text, 0, 0);
    ctx.restore();
    return true;
  }

  function drawRegister(/** @type {CanvasRenderingContext2D} */ ctx, /** @type {Item} */ item) {
    const C = /** @type {Record<string, any>} */ (map.colors), node = item.node, k = map.k, rowPx = ROW_UNITS * k;
    const rects = spanRects(item.v, item.bytes);
    const [fill, line] = colorsFor(node.access);
    const dimmed = filter && !filter.keep.has(node.id);
    const matched = filter && filter.matched.has(node.id);
    const r = rects[0];
    const x = sx(r.col), y = sy(r.row), w = r.cols * k, h = r.rows * rowPx;
    const bits = item.bytes * 8;
    const bitW = w / bits;
    const showFields = rects.length === 1 && !node.dim && bitW >= 2.5 && node.children.length > 0 && h >= 6;
    ctx.globalAlpha = dimmed ? 0.25 : 1;
    for (const piece of rects) {
      const px = sx(piece.col), py = sy(piece.row), pw = piece.cols * k, ph = piece.rows * rowPx;
      // With bit fields, the register shows its unused bits like unused address space
      ctx.fillStyle = showFields ? C.periph : matched ? C.mark : fill;
      ctx.fillRect(px, py, pw, ph);
      if (showFields && map.hatch) {
        ctx.fillStyle = map.hatch;
        ctx.fillRect(px, py, pw, ph);
      }
      if (rowPx >= 4 && pw >= 3) {
        ctx.strokeStyle = line;
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py + 0.5, Math.max(0, pw - 1), Math.max(0, ph - 1));
      }
    }
    if (y > map.height || y + h < 0) {
      ctx.globalAlpha = 1;
      return;
    }

    ctx.fillStyle = C.ink;
    ctx.textBaseline = "middle";
    if (showFields) {
      const top = headerHeight(h), bottom = bitNumbersHeight(h, bitW);
      const fy = y + top, fh = h - top;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      // The register name strip is not bit space
      if (top) {
        ctx.fillStyle = C.periph;
        ctx.fillRect(x, y, w, top);
      }
      for (const f of node.children) {
        const fx = x + (bits - 1 - /** @type {number} */ (f.msb)) * bitW, fw = /** @type {number} */ (f.width) * bitW;
        const fieldMatched = filter && filter.matched.has(f.id);
        ctx.globalAlpha = dimmed || (filter && !filter.keep.has(f.id) && !matched) ? 0.35 : 1;
        ctx.fillStyle = fieldMatched || matched ? C.mark : fill;
        ctx.fillRect(fx, fy, fw, fh);
        ctx.strokeStyle = line;
        ctx.strokeRect(fx + 0.5, fy + 0.5, Math.max(0, fw - 1), Math.max(0, fh - 1));
      }
      ctx.globalAlpha = dimmed ? 0.25 : 1;
      // The outline of the register stays on top of its bit fields
      ctx.strokeStyle = line;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 0.75, y + 0.75, Math.max(0, w - 1.5), Math.max(0, h - 1.5));
      if (top) {
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, Math.round(fy) + 0.5);
        ctx.lineTo(x + w, Math.round(fy) + 0.5);
        ctx.stroke();
      }
      ctx.fillStyle = C.ink;
      if (top) {
        ctx.textAlign = "left";
        ctx.font = `600 11px ${FONT_MONO}`;
        fitText(ctx, node.name, x + 5, y + top / 2 + 0.5, w - 10);
      }
      // Field names are horizontal when they fit, otherwise rotated along the bits
      const labelTop = fy, labelHeight = fh - bottom, mid = labelTop + labelHeight / 2;
      ctx.textAlign = "center";
      let labelled = false;
      for (const f of node.children) {
        const fx = x + (bits - 1 - /** @type {number} */ (f.msb)) * bitW, fw = /** @type {number} */ (f.width) * bitW, cx = fx + fw / 2;
        if (fw < 7 || labelHeight < 9) continue;
        ctx.font = `11px ${FONT_MONO}`;
        if (labelHeight >= 14 && fitText(ctx, f.name, cx, mid, fw - 6)) {
          labelled = true;
          continue;
        }
        if (fitTextRotated(ctx, f.name, cx, mid, labelHeight - 6, fw - 2, 11)) {
          labelled = true;
          continue;
        }
        ctx.font = `9px ${FONT_MONO}`;
        labelled = fitTextRotated(ctx, f.name, cx, mid, labelHeight - 4, fw - 1, 9) || labelled;
      }
      if (!top && !labelled && h >= 12) {
        ctx.font = `500 11px ${FONT_MONO}`;
        fitText(ctx, node.name, x + w / 2, y + h / 2, w - 4);
      }
      if (bottom) {
        ctx.font = `9.5px ${FONT_MONO}`;
        ctx.fillStyle = C.muted;
        for (let b = 0; b < bits; b++) ctx.fillText(String(b), x + (bits - 1 - b + 0.5) * bitW, y + h - bottom / 2);
      }
      ctx.restore();
    } else if (h >= 12 && w >= 16) {
      ctx.textAlign = "center";
      ctx.font = `${h >= 22 ? "500 11px" : "10px"} ${FONT_MONO}`;
      fitText(ctx, node.name, x + w / 2, y + Math.min(h, rowPx) / 2, w - 4);
    }
    ctx.globalAlpha = 1;
  }

  function outline(/** @type {CanvasRenderingContext2D} */ ctx, /** @type {Node} */ node, /** @type {string} */ color, /** @type {number} */ width) {
    const span = spanOf(node);
    if (!span) return;
    if (span.field) {
      const r = spanRects(span.v, span.len);
      const x = sx(r[0].col), y = sy(r[0].row), w = r[0].cols * map.k, h = ROW_UNITS * map.k;
      const bits = span.item.bytes * 8, bitW = w / bits, top = headerHeight(h);
      ctx.beginPath();
      if (r.length === 1 && bitW >= 2.5) {
        ctx.rect(x + (bits - 1 - /** @type {number} */ (span.field.msb)) * bitW, y + top, /** @type {number} */ (span.field.width) * bitW, h - top);
      } else ctx.rect(x, y, w, h);
    } else {
      spanPath(ctx, span.v, span.len);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  function drawMap() {
    map.frame = 0;
    const L = map.layout, C = map.colors, ctx = mapCtx;
    const W = map.width, H = map.height;
    if (!W || !H || !C) return;
    ctx.setTransform(map.dpr, 0, 0, map.dpr, 0, 0);
    ctx.fillStyle = C.surface;
    ctx.fillRect(0, 0, W, H);
    if (!L || !L.rows) {
      ctx.fillStyle = C.muted;
      ctx.font = `13px ${FONT_SANS}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(device ? "This file has no peripherals to draw." : "No file loaded.", 20, 28);
      drawOverview();
      return;
    }
    const k = map.k, rowPx = ROW_UNITS * k, R = L.R;
    const rowTop = -map.oy / rowPx - 1, rowBottom = (H - map.oy) / rowPx + 1;
    const visibleRows = (/** @type {number} */ row, /** @type {number} */ rows) => row + rows >= rowTop && row <= rowBottom;

    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, 0, W - GUTTER, H);
    ctx.clip();

    // Word grid of the address space
    if (rowPx >= 10) {
      ctx.strokeStyle = C.rule;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const s of L.segs) {
        if (!visibleRows(s.y, s.rows)) continue;
        const r0 = Math.max(0, Math.floor(rowTop - s.y)), r1 = Math.min(s.rows, Math.ceil(rowBottom - s.y));
        for (let r = r0; r <= r1; r++) {
          const y = Math.round(sy(s.y + r)) + 0.5;
          ctx.moveTo(sx(0), y);
          ctx.lineTo(sx(R), y);
        }
        const y0 = sy(s.y + r0), y1 = sy(s.y + r1);
        for (let c = 0; c <= R; c += 4) {
          const x = Math.round(sx(c)) + 0.5;
          ctx.moveTo(x, y0);
          ctx.lineTo(x, y1);
        }
      }
      ctx.stroke();
    }

    // Folded gaps between peripherals
    ctx.textBaseline = "middle";
    for (const f of L.folds) {
      if (!visibleRows(f.y, f.rows)) continue;
      const y0 = sy(f.y), y1 = sy(f.y + f.rows), mid = Math.round((y0 + y1) / 2) + 0.5;
      ctx.strokeStyle = C.ruleStrong;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(sx(0), mid);
      ctx.lineTo(sx(R), mid);
      ctx.stroke();
      ctx.setLineDash([]);
      if (y1 - y0 >= 12) {
        const label = f.hidden
          ? `${plural((f.to - f.from) / R, "empty row")} hidden · ${hexBits(f.from, 32)} – ${hexBits(f.to - 1, 32)}`
          : `unused ${hexBits(f.from, 32)} – ${hexBits(f.to - 1, 32)} · ${sizeText(f.to - f.from)}`;
        ctx.font = `11px ${FONT_MONO}`;
        ctx.textAlign = "center";
        const cx = clamp(sx(R / 2), GUTTER + 160, W - 160);
        const width = ctx.measureText(label).width + 12;
        ctx.fillStyle = C.surface;
        ctx.fillRect(cx - width / 2, mid - 8, width, 16);
        ctx.fillStyle = C.muted;
        ctx.fillText(label, cx, mid);
      }
    }

    // Peripherals with their unused space
    for (const P of L.pers) {
      if (!P.drawn || !visibleRows(P.r0, P.r1 - P.r0)) continue;
      spanPath(ctx, P.v, P.vend - P.v);
      ctx.globalAlpha = filter && !filter.keep.has(P.node.id) ? 0.45 : 1;
      ctx.fillStyle = C.periph;
      ctx.fill();
      if (rowPx >= 3 && map.hatch) {
        ctx.fillStyle = map.hatch;
        ctx.fill();
      }
      ctx.strokeStyle = C.ruleStrong;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Registers and bit fields
    for (const s of L.segs) {
      if (!visibleRows(s.y, s.rows)) continue;
      const vStart = s.v + Math.max(0, Math.floor(rowTop - s.y)) * R;
      const vEnd = s.v + Math.min(s.rows, Math.ceil(rowBottom - s.y) + 1) * R;
      for (let i = Math.max(0, lastIndex(L.regs, "v", vStart - L.maxBytes)); i < L.regs.length && L.regs[i].v < vEnd; i++) {
        const item = L.regs[i];
        if (item.v + item.bytes > vStart) drawRegister(ctx, item);
      }
    }

    if (map.hover && map.hover !== map.selected) outline(ctx, map.hover, C.accent, 1.5);
    if (map.selected) outline(ctx, map.selected, C.ink, 2);
    ctx.restore();

    // Gutter with peripheral names and row addresses
    ctx.fillStyle = C.surface;
    ctx.fillRect(0, 0, GUTTER, H);
    ctx.fillStyle = C.rule;
    ctx.fillRect(GUTTER - 1, 0, 1, H);
    ctx.textBaseline = "middle";
    const labelY = (/** @type {number} */ row) => sy(row) + Math.min(rowPx, 18) / 2;
    const step = rowPx >= 15 ? 1 : 2 ** Math.ceil(Math.log2(15 / rowPx));
    ctx.font = `10.5px ${FONT_MONO}`;
    ctx.textAlign = "right";
    ctx.fillStyle = C.faint;
    for (const s of L.segs) {
      if (!visibleRows(s.y, s.rows)) continue;
      const from = Math.max(0, Math.floor(rowTop - s.y)), to = Math.min(s.rows - 1, Math.ceil(rowBottom - s.y));
      for (let r = Math.ceil(from / step) * step; r <= to; r += step) {
        ctx.fillText(hexBits(s.v + r * R, 32), GUTTER - 10, labelY(s.y + r));
      }
    }
    for (const f of L.folds) {
      if (!visibleRows(f.y, f.rows)) continue;
      ctx.fillText("⋮", GUTTER - 40, (sy(f.y) + sy(f.y + f.rows)) / 2);
    }
    ctx.textAlign = "left";
    let lastLabel = -Infinity;
    const selectedSpan = map.selected ? spanOf(map.selected) : null;
    for (const P of L.pers) {
      if (!P.drawn) continue;
      const y = labelY(P.r0);
      if (y < -12 || y > H + 12) continue;
      const selected = selectedSpan?.item?.per === P || map.selected === P.node;
      if (y - lastLabel < 15 && !selected) continue;
      ctx.font = `600 11.5px ${FONT_SANS}`;
      ctx.fillStyle = selected ? C.accent : filter && !filter.keep.has(P.node.id) ? C.faint : C.ink;
      let name = P.node.name;
      while (name.length > 3 && ctx.measureText(name).width > 76) name = name.slice(0, -2) + "…";
      if (name !== P.node.name && !name.endsWith("…")) name += "…";
      ctx.fillText(name, 10, y);
      lastLabel = y;
    }
    drawOverview();
  }

  function drawOverview() {
    const ctx = overviewCtx, L = map.layout, C = map.colors, H = map.height;
    if (!H || !C) return;
    ctx.setTransform(map.dpr, 0, 0, map.dpr, 0, 0);
    ctx.fillStyle = C.band;
    ctx.fillRect(0, 0, OVERVIEW, H);
    if (!L || !L.rows) return;
    const scale = (H - 8) / L.rows;
    const selectedPeripheral = map.selected ? (spanOf(map.selected)?.item?.per ?? L.byNode.get(map.selected.id)) : null;
    for (const P of L.pers) {
      if (!P.drawn) continue;
      const kept = !filter || filter.keep.has(P.node.id);
      ctx.fillStyle = P === selectedPeripheral ? C.accent : filter && kept ? C.mark : kept ? C.ruleStrong : C.rule;
      ctx.fillRect(10, 4 + P.r0 * scale, OVERVIEW - 20, Math.max(1, (P.r1 - P.r0) * scale - 0.5));
    }
    ctx.fillStyle = C.faint;
    for (const f of L.folds) ctx.fillRect(18, 4 + (f.y + f.rows / 2) * scale, OVERVIEW - 36, 1);
    const rowPx = ROW_UNITS * map.k;
    const y0 = 4 + clamp(-map.oy / rowPx, 0, L.rows) * scale, y1 = 4 + clamp((H - map.oy) / rowPx, 0, L.rows) * scale;
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = C.accent;
    ctx.fillRect(3, y0, OVERVIEW - 6, Math.max(3, y1 - y0));
    ctx.globalAlpha = 1;
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(3.5, y0, OVERVIEW - 7, Math.max(3, y1 - y0));
  }

  function scheduleDraw() {
    if (!visible || map.frame || map.anim) return;
    map.frame = requestAnimationFrame(drawMap);
  }

  function resizeMap() {
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(0, Math.floor(rect.width - 2 - OVERVIEW)), H = Math.max(0, Math.floor(rect.height - 2));
    if (W === map.width && H === map.height && dpr === map.dpr) return false;
    map.width = W;
    map.height = H;
    map.dpr = dpr;
    for (const [target, width] of /** @type {[HTMLCanvasElement, number][]} */ ([[canvas, W], [overview, OVERVIEW]])) {
      target.width = Math.round(width * dpr);
      target.height = Math.round(H * dpr);
      target.style.width = `${width}px`;
      target.style.height = `${H}px`;
    }
    return true;
  }

  const minZoom = () => {
    const L = map.layout;
    if (!L || !L.rows) return 0.01;
    return Math.min((map.width - GUTTER - 24) / L.R, (map.height - 24) / (L.rows * ROW_UNITS)) * 0.9;
  };

  function fitTarget() {
    const L = map.layout;
    return {k: L ? clamp((map.width - GUTTER - 24) / L.R, minZoom(), K_MAX) : map.k, ox: GUTTER + 12, oy: 12};
  }

  function fitWidth() {
    if (map.layout) Object.assign(map, fitTarget());
  }

  function clampView() {
    const L = map.layout;
    if (!L) return;
    const W = map.width - GUTTER, H = map.height;
    const contentW = L.R * map.k, contentH = L.rows * ROW_UNITS * map.k;
    map.ox = clamp(map.ox, GUTTER + W / 2 - contentW, GUTTER + W / 2);
    map.oy = clamp(map.oy, H / 2 - contentH, H / 2);
  }

  function zoomAt(/** @type {number} */ px, /** @type {number} */ py, /** @type {number} */ factor) {
    cancelAnimationFrame(map.anim);
    map.anim = 0;
    const k = clamp(map.k * factor, minZoom(), K_MAX), f = k / map.k;
    map.ox = px - (px - map.ox) * f;
    map.oy = py - (py - map.oy) * f;
    map.k = k;
    clampView();
    scheduleDraw();
  }

  function animateTo(/** @type {{k: number, ox: number, oy: number}} */ target, animate = true) {
    cancelAnimationFrame(map.anim);
    map.anim = 0;
    const W = map.width - GUTTER, H = map.height;
    if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      Object.assign(map, target);
      clampView();
      scheduleDraw();
      return;
    }
    const center = (/** @type {{k: number, ox: number, oy: number}} */ s) => ({x: (GUTTER + W / 2 - s.ox) / s.k, y: (H / 2 - s.oy) / s.k});
    const from = {k: map.k, ...center(map)}, to = {k: target.k, ...center(target)};
    const start = performance.now(), duration = 320;
    const step = (/** @type {number} */ now) => {
      const t = Math.min(1, (now - start) / duration), e = 1 - Math.pow(1 - t, 3);
      const k = Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * e);
      map.k = k;
      map.ox = GUTTER + W / 2 - (from.x + (to.x - from.x) * e) * k;
      map.oy = H / 2 - (from.y + (to.y - from.y) * e) * k;
      drawMap();
      if (t < 1) {
        map.anim = requestAnimationFrame(step);
      } else {
        map.anim = 0;
        clampView();
        scheduleDraw();
      }
    };
    map.anim = requestAnimationFrame(step);
  }

  function zoomTo(/** @type {Node | null} */ node, animate = true) {
    const span = spanOf(node);
    if (!span) return;
    const rects = spanRects(span.v, span.len);
    let x0 = Math.min(...rects.map((r) => r.col)), x1 = Math.max(...rects.map((r) => r.col + r.cols));
    const y0 = rects[0].row, y1 = rects[rects.length - 1].row + rects[rects.length - 1].rows;
    if (span.field && rects.length === 1) {
      const bits = span.item.bytes * 8, byteW = (x1 - x0) / bits;
      x0 = rects[0].col + (bits - 1 - /** @type {number} */ (span.field.msb)) * byteW;
      x1 = x0 + /** @type {number} */ (span.field.width) * byteW;
    }
    const W = map.width - GUTTER, H = map.height;
    const k = clamp(Math.min((W * 0.86) / Math.max(x1 - x0, 1e-3), (H * 0.62) / ((y1 - y0) * ROW_UNITS)), minZoom(), K_MAX);
    const cx = (x0 + x1) / 2, cy = ((y0 + y1) / 2) * ROW_UNITS;
    animateTo({k, ox: GUTTER + W / 2 - cx * k, oy: H / 2 - cy * k}, animate);
  }

  /** @returns {Node | null} */
  function hitTest(/** @type {number} */ px, /** @type {number} */ py) {
    const L = map.layout;
    if (!L || px < GUTTER) return null;
    const k = map.k, rowPx = ROW_UNITS * k;
    const rowF = (py - map.oy) / rowPx, col = Math.floor((px - map.ox) / k);
    if (col < 0 || col >= L.R || rowF < 0) return null;
    const s = L.segs[lastIndex(L.segs, "y", rowF)];
    if (!s || rowF >= s.y + s.rows) return null;
    const v = s.v + Math.floor(rowF - s.y) * L.R + col;
    for (let i = lastIndex(L.regs, "v", v); i >= 0 && L.regs[i].v > v - L.maxBytes; i--) {
      const item = L.regs[i];
      if (v < item.v || v >= item.v + item.bytes) continue;
      const rects = spanRects(item.v, item.bytes);
      if (rects.length === 1 && !item.node.dim) {
        const bits = item.bytes * 8, bitW = (rects[0].cols * k) / bits;
        const inHeader = py - sy(rects[0].row) < headerHeight(rowPx);
        if (bitW >= 2.5 && !inHeader) {
          const bit = bits - 1 - Math.floor((px - sx(rects[0].col)) / bitW);
          const field = item.node.children.find((f) => bit >= /** @type {number} */ (f.lsb) && bit <= /** @type {number} */ (f.msb));
          if (field) return field;
        }
      }
      return item.node;
    }
    let peripheral = null;
    for (const P of L.pers) if (v >= P.v && v < P.vend) peripheral = P.node;
    return peripheral;
  }

  function describe(/** @type {Node} */ node) {
    const access = node.access ? ` · ${ACCESS[node.access] || node.access}` : "";
    switch (node.type) {
      case "peripheral": {
        const P = /** @type {Extent | undefined} */ (map.layout?.byNode.get(node.id));
        return P ? `${hexBits(P.start, 32)} – ${hexBits(P.end - 1, 32)} · ${sizeText(P.end - P.start)}` : hexBits(node.address ?? 0, 32);
      }
      case "cluster": return `${hexBits(node.address ?? 0, 32)} · cluster`;
      case "register": return `${hexBits(node.address ?? 0, 32)} · ${node.size} bits${access}`;
      case "field": return `${bitRange(node)} · ${plural(node.width ?? 1, "bit")}${access}`;
      default: return "";
    }
  }

  function select(/** @type {Node | null} */ node) {
    map.selected = node && node.type === "enum" ? node.parent : node;
    onSelect(map.selected);
    scheduleDraw();
  }

  function rebuild() {
    if (!device) return;
    map.layout = buildLayout();
    if (map.selected && spanOf(map.selected)) zoomTo(map.selected, false);
    else {
      fitWidth();
      scheduleDraw();
    }
  }

  const center = () => /** @type {[number, number]} */ ([GUTTER + (map.width - GUTTER) / 2, map.height / 2]);

  /* ---------------------------------------------------------------- Events */
  /** @type {Map<number, {x: number, y: number}>} */
  const pointers = new Map();
  /** @type {{x: number, y: number, ox: number, oy: number, moved: boolean} | null} */
  let drag = null;
  /** @type {{distance: number} | null} */
  let pinch = null;

  canvas.addEventListener("pointerdown", (e) => {
    cancelAnimationFrame(map.anim);
    map.anim = 0;
    canvas.focus({preventScroll: true});
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, {x: e.offsetX, y: e.offsetY});
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = {distance: Math.hypot(a.x - b.x, a.y - b.y)};
      drag = null;
    } else {
      drag = {x: e.offsetX, y: e.offsetY, ox: map.ox, oy: map.oy, moved: false};
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, {x: e.offsetX, y: e.offsetY});
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.distance > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, distance / pinch.distance);
      pinch.distance = distance;
      return;
    }
    if (drag && pointers.has(e.pointerId)) {
      const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 3) {
        drag.moved = true;
        canvas.classList.add("dragging");
        tip.hidden = true;
      }
      if (drag.moved) {
        map.ox = drag.ox + dx;
        map.oy = drag.oy + dy;
        clampView();
        scheduleDraw();
      }
      return;
    }
    const hit = hitTest(e.offsetX, e.offsetY);
    if (hit !== map.hover) {
      map.hover = hit;
      scheduleDraw();
    }
    if (!hit) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = `<strong>${esc(hit.path)}</strong><span>${esc(describe(hit))}</span>`;
    tip.hidden = false;
    const tipW = tip.offsetWidth, tipH = tip.offsetHeight;
    tip.style.left = `${Math.min(e.offsetX + 14, map.width - tipW - 8)}px`;
    tip.style.top = `${e.offsetY + 18 + tipH > map.height ? e.offsetY - tipH - 10 : e.offsetY + 18}px`;
  });
  const endPointer = (/** @type {PointerEvent} */ e) => {
    const wasClick = drag && !drag.moved && pointers.size === 1 && e.type === "pointerup";
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    canvas.classList.remove("dragging");
    if (wasClick) select(hitTest(e.offsetX, e.offsetY));
    drag = null;
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", () => {
    if (drag) return;
    tip.hidden = true;
    if (map.hover) {
      map.hover = null;
      scheduleDraw();
    }
  });
  canvas.addEventListener("dblclick", (e) => {
    const hit = hitTest(e.offsetX, e.offsetY);
    if (hit) {
      select(hit);
      zoomTo(hit);
    } else zoomAt(e.offsetX, e.offsetY, 2);
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? map.height : 1;
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * scale * 0.0025));
    } else {
      cancelAnimationFrame(map.anim);
      map.anim = 0;
      map.ox -= (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * scale;
      map.oy -= (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * scale;
      clampView();
      scheduleDraw();
    }
  }, {passive: false});
  canvas.addEventListener("keydown", (e) => {
    const [cx, cy] = center();
    switch (e.key) {
      case "ArrowUp": map.oy += 80; break;
      case "ArrowDown": map.oy -= 80; break;
      case "ArrowLeft": map.ox += 80; break;
      case "ArrowRight": map.ox -= 80; break;
      case "PageUp": map.oy += map.height * 0.9; break;
      case "PageDown": map.oy -= map.height * 0.9; break;
      case "+": case "=": zoomAt(cx, cy, 1.5); break;
      case "-": case "_": zoomAt(cx, cy, 1 / 1.5); break;
      case "0": fitWidth(); break;
      case "Enter": if (map.selected) zoomTo(map.selected); break;
      case "Escape": select(null); break;
      default: return;
    }
    e.preventDefault();
    clampView();
    scheduleDraw();
  });

  let overviewDrag = false;
  const jump = (/** @type {number} */ y) => {
    const L = map.layout;
    if (!L || !L.rows) return;
    const row = clamp((y - 4) / (map.height - 8), 0, 1) * L.rows;
    map.oy = map.height / 2 - row * ROW_UNITS * map.k;
    clampView();
    scheduleDraw();
  };
  overview.addEventListener("pointerdown", (e) => {
    overview.setPointerCapture(e.pointerId);
    overviewDrag = true;
    jump(e.offsetY);
  });
  overview.addEventListener("pointermove", (e) => {
    if (overviewDrag) jump(e.offsetY);
  });
  overview.addEventListener("pointerup", () => {
    overviewDrag = false;
  });
  overview.addEventListener("wheel", (e) => {
    e.preventDefault();
    map.oy -= e.deltaY * (e.deltaMode === 1 ? 16 : 1);
    clampView();
    scheduleDraw();
  }, {passive: false});

  new ResizeObserver(() => {
    if (!visible) return;
    if (resizeMap()) {
      if (!map.layout) ensureLayout();
      clampView();
      drawMap();
    }
  }).observe(container);

  const refreshColors = () => {
    readColors();
    scheduleDraw();
  };
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", refreshColors);
  new MutationObserver(refreshColors).observe(document.documentElement, {attributes: true, attributeFilter: ["data-theme"]});
  document.fonts?.ready.then(() => {
    widths.clear();
    scheduleDraw();
  });

  readColors();
  if (visible) {
    resizeMap();
    ensureLayout();
    scheduleDraw();
  }

  return {
    canvas,
    get selected() { return map.selected; },
    get layout() { return map.layout; },
    /** Shows another device, clears the selection. */
    setDevice(/** @type {Device | null} */ value) {
      device = value;
      reset();
    },
    setFilter(/** @type {Filter | null} */ value) {
      filter = value;
      scheduleDraw();
    },
    /** Lays the map out again with other rows, keeps the selection in view. */
    setRows(/** @type {{rowBytes?: number, dense?: boolean}} */ {rowBytes = map.rowBytes, dense = map.dense}) {
      map.rowBytes = rowBytes;
      map.dense = dense;
      rebuild();
    },
    /** Call with true after the container was shown, the map is laid out and drawn then. */
    setVisible(/** @type {boolean} */ value) {
      visible = value;
      if (!visible) return;
      resizeMap();
      ensureLayout();
      scheduleDraw();
    },
    select,
    zoomTo,
    /** Zooms around the centre of the view. */
    zoomBy(/** @type {number} */ factor) {
      zoomAt(...center(), factor);
    },
    /** Fits the width of the rows, keeps the row at the top of the view. */
    fitWidth() {
      const top = Math.max(0, -map.oy / (ROW_UNITS * map.k));
      const target = fitTarget();
      target.oy = 12 - top * ROW_UNITS * target.k;
      animateTo(target);
    },
    /** Clears the selection and shows the whole device. */
    showAll() {
      select(null);
      animateTo(fitTarget());
    },
  };
}

/**
 * The details of a peripheral, cluster, register or bit field, with the buttons
 * [data-action="close" | "zoom" | "table"] for the caller to handle.
 * @param {Node} node
 * @param {Layout | null} [layout] gives the address range of a peripheral as drawn on the map
 */
export function renderDetails(node, layout = null) {
  const rows = [];
  const add = (/** @type {string} */ label, /** @type {string | null | undefined} */ value, mono = true) => {
    if (value !== "" && value != null) rows.push(`<div><dt>${label}</dt><dd${mono ? ' class="num"' : ""}>${value}</dd></div>`);
  };
  const P = /** @type {Extent | undefined} */ (layout?.byNode.get(node.id));
  switch (node.type) {
    case "peripheral":
      if (P) {
        add("Address", `${hexBits(P.start, 32)} – ${hexBits(P.end - 1, 32)}`);
        add("Size", `${sizeText(P.end - P.start)}${P.inferred ? " (rounded up to 1 KiB, the file has no address block)" : ""}`, false);
      }
      add("Registers", countOf(node, "register").toLocaleString(), false);
      if (node.derivedFrom) add("Derived from", esc(node.derivedFrom));
      if (node.interrupts?.length) add("Interrupts", node.interrupts.map((i) => `${esc(i.name)} (${esc(i.value)})`).join(", "));
      break;
    case "cluster":
      add("Address", hexBits(node.address ?? 0, 32));
      add("Offset", offsetText(node.offset ?? 0));
      add("Registers", countOf(node, "register").toLocaleString(), false);
      break;
    case "register":
      add("Address", hexBits(node.address ?? 0, 32));
      add("Offset", offsetText(node.offset ?? 0));
      add("Size", node.dim ? `${node.dim} × ${node.size} bits` : `${node.size} bits`, false);
      add("Access", esc(ACCESS[node.access ?? ""] || node.access || ""));
      add("Reset", node.reset != null ? hexBits(node.reset, node.size ?? 32) : "");
      add("Bit fields", node.children.length ? node.children.length.toLocaleString() : "", false);
      break;
    case "field":
      add("Bits", bitRange(node));
      add("Width", plural(node.width ?? 1, "bit"), false);
      add("Access", esc([ACCESS[node.access ?? ""] || node.access, WRITES[node.writes ?? ""] || node.writes].filter(Boolean).join(" ")));
      add("Reset", node.reset != null ? bitsValue(node.reset, node.width ?? 1) : "");
      add("Values", node.children.map((v) => `${esc(v.name)} = ${v.value != null ? bitsValue(v.value, v.width ?? 1) : esc(v.raw)}`).join("<br>"));
      break;
  }
  const kind = {peripheral: "Peripheral", cluster: "Cluster", register: "Register", field: "Bit field", enum: ""}[node.type];
  const box = el("div", "details");
  box.innerHTML =
    `<div class="card-head"><span class="kind">${kind}</span>` +
    `<button class="card-close" type="button" data-action="close" aria-label="Close details">×</button></div>` +
    `<h3 class="card-name">${esc(node.path)}</h3>` +
    (rows.length ? `<dl>${rows.join("")}</dl>` : "") +
    (node.desc ? `<p class="card-desc">${esc(node.desc)}</p>` : "") +
    `<div class="card-actions"><button class="btn" type="button" data-action="zoom">Zoom to</button>` +
    `<button class="btn" type="button" data-action="table">Show in table</button></div>`;
  // The bit fields with their reset values below the buttons, the card already names the register
  if (node.type === "register" && node.children.length) box.append(renderRegister(node));
  return box;
}

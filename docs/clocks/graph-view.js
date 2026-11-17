// Copyright 2026, Niklas Hauser
// SPDX-License-Identifier: MPL-2.0
// @ts-check
// The clock graph of a device: every node with its frequency, setting, limits and violations, laid out
// left to right with dagre (window.dagre, loaded by the page), with pan and zoom. It shows all nodes or a
// chosen part like the active path to some targets, editable or read only. It knows nothing about the page:
// the page passes the evaluation result and its choices in, and gets the user's changes as callbacks.
// Styles: graph-view.css.

import {clamp, h as el} from "../shared/util.js";
import {
  KIND, fmtHz, fold, humanError, inputValue, inUnit, isVariable, factorsOf, label, limitText, settingOf, unitOf,
} from "./model.js";

/** @typedef {import("./model.js").Tree} Tree */
/** @typedef {import("./model.js").Node} Node */
/** @typedef {import("./model.js").Result} Result */
/** @typedef {import("./model.js").NodeResult} NodeResult */

/**
 * @typedef {object} Callbacks
 * @property {(id: string, value: any) => void} [onChoose] a mux input or factor was picked
 * @property {(id: string, locked: boolean) => void} [onLock]
 * @property {(id: string, hz: number | null) => void} [onTarget] the target field of a node changed, null when cleared
 * @property {(id: string, used: boolean) => void} [onUse] a peripheral was ticked or unticked
 *
 * @typedef {object} View
 * @property {Result} result the evaluation of the configuration
 * @property {Set<string>} [locked]
 * @property {Map<string, number>} [targets] node id -> Hz
 * @property {Set<string>} [use] peripherals in use
 * @property {Set<string> | null} [nodes] the nodes to show, all if null
 * @property {Set<string>} [alternatives] further nodes shown dimmed, e.g. the other inputs of muxes on a path
 */

/**
 * Creates the graph in the container (which needs a height) and returns its controller.
 * @param {HTMLElement} container
 * @param {Tree} tree
 * @param {Callbacks & {editable?: boolean}} [options]
 */
export function createClockGraph(container, tree, options = {}) {
  const editable = options.editable ?? true;
  container.classList.add("clock-graph");
  container.classList.toggle("editable", editable);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("cg-wires");
  const world = el("div", {className: "cg-world"}, svg);
  const pan = el("div", {className: "cg-pan"}, world);
  const hud = el("div", {className: "cg-hud"});
  container.replaceChildren(pan, hud);

  /** @type {View & {locked: Set<string>, targets: Map<string, number>, use: Set<string>, alternatives: Set<string>}} */
  let view = {result: {}, locked: new Set(), targets: new Map(), use: new Set(), nodes: null, alternatives: new Set()};
  /** @type {Map<string, HTMLElement>} */
  const boxes = new Map();
  /** @type {Record<string, {x?: number, y?: number, w: number, h: number}>} */
  const positions = {};
  let folded = fold(tree);
  let shown = "";

  const choice = (/** @type {string} */ id) => settingOf(tree, view.result, id);
  const visible = (/** @type {string} */ id) => !view.nodes || view.nodes.has(id) || view.alternatives.has(id);

  /** The boxes for the visible nodes that no other node hosts. */
  function build() {
    for (const box of boxes.values()) box.remove();
    boxes.clear();
    // A part of the graph has no cards below it: its few nodes are wired like any other
    folded = fold(tree, {cards: !view.nodes});
    for (const id of Object.keys(tree.nodes)) {
      if (folded.host[id] || !visible(id)) continue;
      const box = el("div", {className: "node"});
      box.dataset.id = id;
      world.append(box);
      boxes.set(id, box);
    }
  }

  /** @param {string} id */
  function paint(id) {
    const node = tree.nodes[id], box = /** @type {HTMLElement} */ (boxes.get(id)), r = view.result[id] ?? {};
    const periph = node.kind === "peripheral", alt = view.alternatives.has(id);
    box.className = "node" + (periph ? " periph" : "") + (folded.cards.has(id) ? " wide" : "") +
      (r.used ? " used" : "") + (alt ? " alt" : "") + (view.locked.has(id) ? " locked" : "") +
      (view.targets.has(id) ? " target" : "") + (r.errors?.length && r.used ? " bad" : "");
    box.textContent = "";

    const head = el("div", {className: "head"}, el("span", {className: "name", textContent: label(id), title: label(id)}));
    if (editable && isVariable(node)) {
      const locked = view.locked.has(id);
      head.append(el("button", {
        className: "lockbtn" + (locked ? " on" : ""), textContent: locked ? "🔒" : "🔓",
        title: locked ? "unlock, the solver may change it" : "lock, the solver keeps it",
        onclick: (/** @type {Event} */ e) => { e.stopPropagation(); options.onLock?.(id, !locked); },
      }));
    } else head.append(el("span", {className: "kind", textContent: /** @type {any} */ (KIND)[node.kind] ?? node.kind}));
    box.append(head);

    const hz = el("span", {className: "hz" + (r.freq === null || r.freq === undefined ? " none" : ""), textContent: fmtHz(r.freq)});
    const row = el("div", {className: "row", style: "justify-content:space-between"}, hz, el("span", {style: "flex:1"}));
    if (editable && !alt) {
      // The target sits on every node, a peripheral also says whether it is in use
      const [unit, scale] = unitOf(view.targets.get(id) ?? r.freq ?? node.max);
      const target = el("input", {className: "tgt" + (view.targets.has(id) ? " set" : ""), placeholder: `target ${unit}`,
        value: inUnit(view.targets.get(id), scale), title: `target frequency in ${unit}, Enter solves`});
      target.onchange = () => {
        const value = parseFloat(target.value);
        options.onTarget?.(id, Number.isFinite(value) ? value * scale : null);
      };
      row.append(target);
      if (periph) {
        const use = el("input", {type: "checkbox", checked: view.use.has(id) || view.targets.has(id),
          title: "in use: its limits and usage flags count"});
        use.onchange = () => options.onUse?.(id, use.checked);
        row.append(el("label", {className: "lbl"}, use, "use"));
      }
    } else if (view.targets.has(id)) {
      row.append(el("span", {className: "lbl", textContent: `target ${fmtHz(view.targets.get(id))}`}));
    }
    box.append(row);
    if (alt) return;
    const control = editable ? controlOf(id, node) : settingText(id, node);
    if (control) box.append(el("div", {className: "row"}, control));
    if (periph && node.bus) box.append(el("div", {className: "lim", textContent: `bus ${label(node.bus)} ${fmtHz(view.result[node.bus]?.freq)}`}));
    const limits = limitText(node, r);
    if (limits) box.append(el("div", {className: "lim", textContent: limits}));
    for (const error of r.used ? (r.errors ?? []) : []) box.append(el("div", {className: "lim bad", textContent: "✗ " + humanError(error)}));
    paintFeeds(id, box, r);
  }

  /** The peripherals a node clocks, through an output or directly: one line each. */
  function paintFeeds(/** @type {string} */ id, /** @type {HTMLElement} */ box, /** @type {NodeResult} */ r) {
    const list = (folded.feeds.get(id) ?? []).filter((p) => !view.nodes || view.nodes.has(p));
    if (!list.length) return;
    // A shared output breaking a limit shows once under its own name, not once per peripheral
    const nodes = tree.nodes, grid = el("div", {className: "feeds"}), bad = new Set();
    for (const p of list.sort()) {
      const rp = view.result[p] ?? {};
      if (nodes[p].kind === "output") {
        const errors = (rp.used ? (rp.errors ?? []) : []).map(humanError);
        grid.append(el("span", {className: "feed" + (errors.length ? " bad" : ""),
          title: [label(p), limitText(nodes[p], rp), ...errors].filter(Boolean).join("\n")}, "→ " + label(p)));
        for (const e of errors) bad.add(`${label(p)}: ${e}`);
        continue;
      }
      const via = nodes[p].inputs[0].from, rv = folded.host[via] ? (view.result[via] ?? {}) : {};
      const errors = [...(rv.used ? (rv.errors ?? []) : []), ...(rp.used ? (rp.errors ?? []) : [])].map(humanError);
      const limits = [folded.host[via] ? limitText(nodes[via], rv) : "", limitText(nodes[p], rp)].filter(Boolean).join(" · ");
      const inUse = view.use.has(p) || view.targets.has(p);
      const freq = rp.freq !== r.freq && rp.freq ? ` ${fmtHz(rp.freq)}` : "";
      const title = [`${label(p)}${editable ? ": in use, its limits and usage flags count" : ""}`,
        nodes[p].bus ? `bus ${label(nodes[p].bus)}` : "", limits, ...errors].filter(Boolean).join("\n");
      const line = el(editable ? "label" : "span", {className: "feed" + (inUse ? " on" : "") + (errors.length ? " bad" : ""), title});
      if (editable) {
        const use = el("input", {type: "checkbox", checked: inUse});
        use.onchange = () => options.onUse?.(p, use.checked);
        line.append(use);
      }
      line.append(label(p) + freq);
      grid.append(line);
      for (const e of rv.used ? (rv.errors ?? []) : []) bad.add(`${label(via)}: ${humanError(e)}`);
      for (const e of rp.used ? (rp.errors ?? []) : []) bad.add(`${label(p)}: ${humanError(e)}`);
    }
    box.append(grid);
    for (const e of bad) box.append(el("div", {className: "lim bad", textContent: "✗ " + e}));
  }

  /** The setting of a node as text, for the read only graph. */
  function settingText(/** @type {string} */ id, /** @type {Node} */ node) {
    const now = choice(id);
    if (node.kind === "mux") {
      const input = node.inputs.find((i) => inputValue(i) === now);
      return input ? el("span", {className: "setting", textContent: `← ${label(input.from)}`}) : null;
    }
    if (["div", "mul", "mulfrac", "frac"].includes(node.kind) && now !== undefined && now !== null) {
      const sign = node.kind === "div" ? "÷" : node.kind === "frac" ? "+" : "×";
      return el("span", {className: "setting", textContent: `${sign} ${now}${node.kind === "frac" ? "/8192" : ""}`});
    }
    return null;
  }

  /** The control that sets a node. */
  function controlOf(/** @type {string} */ id, /** @type {Node} */ node) {
    const now = choice(id);
    const choose = (/** @type {any} */ value) => options.onChoose?.(id, value);
    if (folded.cards.has(id)) {
      const chips = el("div", {className: "chips"});
      for (const input of node.inputs) {
        const value = inputValue(input), sel = now === value;
        chips.append(el("button", {
          className: "chip" + (sel ? " sel" : "") + (sel && view.result[id]?.used ? " ok" : ""), textContent: label(input.from),
          title: `${label(input.from)}${input.signal ? ` (${input.signal})` : ""}: ${fmtHz(view.result[input.from]?.freq)}`,
          onclick: () => choose(value),
        }));
      }
      return chips;
    }
    if (node.kind === "mux") {
      const select = el("select", {title: node.param ?? ""});
      for (const input of node.inputs) {
        select.append(el("option", {value: inputValue(input),
          textContent: label(input.from) + (input.signal && input.signal !== input.from ? ` (${input.signal})` : "")}));
      }
      select.value = now ?? "";
      select.onchange = () => choose(select.value);
      return select;
    }
    if (["div", "mul", "mulfrac", "frac"].includes(node.kind) && !node.rules) {
      const factors = factorsOf(node);
      const sign = node.kind === "div" ? "÷" : node.kind === "frac" ? "+" : "×";
      if (factors.length > 1 && (node.domain || factors.length <= 64)) {
        const select = el("select", {title: node.param ?? ""});
        for (const f of factors) select.append(el("option", {value: f, textContent: `${sign} ${f}${node.kind === "frac" ? "/8192" : ""}`}));
        select.value = now;
        select.onchange = () => choose(Number(select.value));
        return select;
      }
      if (factors.length > 64 && node.range) {
        const [lo, hi] = node.range;
        const input = el("input", {type: "number", min: lo, max: hi, value: now ?? "", title: `${sign} ${lo}…${hi}`});
        input.onchange = () => choose(clamp(Math.round(Number(input.value)), lo, hi));
        return el("span", {className: "row", style: "margin:0;flex:1"}, el("span", {className: "lbl", textContent: sign}), input);
      }
    }
    if (node.rules) {
      const from = view.result[node.inputs[0]?.from]?.freq, own = view.result[id]?.freq;
      const factor = own && from ? own / from : null;
      return el("span", {className: "lbl", textContent: `follows config${factor ? `: × ${Number(factor.toPrecision(4))}` : ""}`});
    }
    if (node.kind === "varied") {
      const [unit, scale] = unitOf(node.default ?? now);
      const input = el("input", {type: "number", step: "any", value: inUnit(now, scale), title: limitText(node, {})});
      input.onchange = () => choose(Number(input.value) * scale);
      return el("span", {className: "row", style: "margin:0;flex:1"}, input, el("span", {className: "lbl", textContent: unit}));
    }
    if (node.kind === "choice" && node.domain?.length) {
      const select = el("select");
      for (const o of node.domain) select.append(el("option", {value: o.value, textContent: fmtHz(o.value)}));
      select.value = now;
      select.onchange = () => choose(Number(select.value));
      return select;
    }
    return null;
  }

  /** The wires between the boxes: lines inside a box have none. */
  function edges() {
    const out = [];
    for (const [id, node] of Object.entries(tree.nodes)) {
      if (folded.host[id] || !boxes.has(id)) continue;
      for (const input of node.inputs) {
        const from = folded.owner(input.from);
        if (tree.nodes[input.from] && boxes.has(from)) out.push({from, to: id, input});
      }
    }
    return out;
  }

  function paintWires() {
    svg.textContent = "";
    for (const {from, to, input} of edges()) {
      const a = positions[from], b = positions[to];
      if (a?.x === undefined || b?.x === undefined || a.y === undefined || b.y === undefined) continue;
      if (folded.cards.has(to)) continue;
      // A mux carries only the input it has selected, everything else carries its input
      const selected = tree.nodes[to].kind !== "mux" || choice(to) === inputValue(input);
      const alt = view.alternatives.has(from);
      if (!selected && view.nodes && !alt) continue;
      const live = selected && view.result[to]?.used && view.result[from]?.used;
      const x1 = a.x + a.w, y1 = a.y + 14, x2 = b.x, y2 = b.y + 14, mid = Math.max(x1 + 20, (x1 + x2) / 2);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M${x1},${y1} C${mid},${y1} ${x2 - (mid - x1)},${y2} ${x2},${y2}`);
      path.setAttribute("class", live ? "live" : alt ? "alt" : selected ? "sel" : "");
      svg.append(path);
    }
  }

  /** Layered left to right with dagre; kernel clock cards wrap into rows below the graph. */
  function layout(auto = true) {
    // Measured at zoom 1 and then fixed: the browser's minimum font size makes boxes taller when zoomed out
    world.style.zoom = "1";
    for (const box of boxes.values()) box.style.height = "";
    for (const [id, box] of boxes) positions[id] = {...(positions[id] ?? {}), w: box.offsetWidth, h: box.offsetHeight};
    world.style.zoom = String(camera.k);
    if (auto) {
      const dagre = /** @type {any} */ (window).dagre;
      const g = new dagre.graphlib.Graph();
      g.setGraph({rankdir: "LR", nodesep: 10, ranksep: 46, marginx: 20, marginy: 20});
      g.setDefaultEdgeLabel(() => ({}));
      const rest = [...boxes.keys()].filter((id) => !folded.cards.has(id));
      for (const id of rest) g.setNode(id, {width: positions[id].w, height: positions[id].h});
      for (const {from, to} of edges()) if (!folded.cards.has(to)) g.setEdge(from, to);
      dagre.layout(g);
      for (const id of rest) {
        const n = g.node(id), p = positions[id];
        p.x = n.x - p.w / 2;
        p.y = n.y - p.h / 2;
      }
      const bottom = Math.max(0, ...rest.map((id) => (positions[id].y ?? 0) + positions[id].h)) + 40;
      const width = Math.max(1100, ...rest.map((id) => (positions[id].x ?? 0) + positions[id].w));
      let x = 20, y = bottom, row = 0;
      for (const id of [...folded.cards].sort()) {
        const p = positions[id];
        if (x + p.w > width && x > 20) { x = 20; y += row + 8; row = 0; }
        Object.assign(p, {x, y});
        x += p.w + 8;
        row = Math.max(row, p.h);
      }
    }
    place();
  }

  function place() {
    let w = 0, h = 0;
    for (const [id, box] of boxes) {
      const p = positions[id];
      if (p.x === undefined || p.y === undefined) continue;
      box.style.left = `${p.x}px`;
      box.style.top = `${p.y}px`;
      box.style.height = `${p.h}px`;
      w = Math.max(w, p.x + p.w);
      h = Math.max(h, p.y + p.h);
    }
    world.style.width = `${w + 40}px`;
    world.style.height = `${h + 40}px`;
    svg.setAttribute("width", String(w + 40));
    svg.setAttribute("height", String(h + 40));
    paintWires();
  }

  // Pan with a transform on the wrapper, zoom with CSS zoom on the world: scale() blurs in Safari
  const camera = {x: 0, y: 0, k: 0.8};
  // At most one style update per frame: wheel and pointer events come faster than the browser paints
  let frame = 0;
  const applyView = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      pan.style.transform = `translate(${camera.x}px, ${camera.y}px)`;
      world.style.zoom = String(camera.k);
    });
  };
  function zoomAt(/** @type {number} */ k, /** @type {number} */ px, /** @type {number} */ py) {
    k = clamp(k, 0.15, 2.5);
    camera.x = px - (px - camera.x) * (k / camera.k);
    camera.y = py - (py - camera.y) * (k / camera.k);
    camera.k = k;
    applyView();
  }
  function fit() {
    const stage = container.getBoundingClientRect();
    const w = parseFloat(world.style.width) || 1000, h = parseFloat(world.style.height) || 800;
    camera.k = clamp(Math.min(stage.width / w, stage.height / h), 0.15, 1.2);
    camera.x = (stage.width - w * camera.k) / 2;
    camera.y = Math.max(0, (stage.height - h * camera.k) / 2);
    applyView();
  }

  const onWheel = (/** @type {WheelEvent} */ e) => {
    e.preventDefault();
    const r = container.getBoundingClientRect();
    zoomAt(camera.k * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  };
  // Removed together by destroy(), the container may get the graph of another device next
  const events = new AbortController();
  const signal = events.signal;
  container.addEventListener("wheel", onWheel, {passive: false, signal});
  /** @type {any} */
  let drag = null;
  container.addEventListener("pointerdown", (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const head = target.closest(".head");
    if (target.closest(".cg-hud")) return;
    if (editable && head && !target.closest("button")) {
      const id = /** @type {string} */ (/** @type {HTMLElement} */ (head.parentElement).dataset.id);
      drag = {id, x: e.clientX, y: e.clientY, p: {...positions[id]}};
    } else if (!target.closest(".node") || !editable) {
      drag = {pan: true, x: e.clientX - camera.x, y: e.clientY - camera.y};
      container.classList.add("panning");
    } else return;
    container.setPointerCapture(e.pointerId);
  }, {signal});
  container.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (drag.pan) {
      camera.x = e.clientX - drag.x;
      camera.y = e.clientY - drag.y;
      applyView();
    } else {
      const p = positions[drag.id], box = /** @type {HTMLElement} */ (boxes.get(drag.id));
      p.x = drag.p.x + (e.clientX - drag.x) / camera.k;
      p.y = drag.p.y + (e.clientY - drag.y) / camera.k;
      box.style.left = `${p.x}px`;
      box.style.top = `${p.y}px`;
      paintWires();
    }
  }, {signal});
  const end = () => { drag = null; container.classList.remove("panning"); };
  container.addEventListener("pointerup", end, {signal});
  container.addEventListener("pointercancel", end, {signal});

  const center = () => { const r = container.getBoundingClientRect(); return /** @type {[number, number]} */ ([r.width / 2, r.height / 2]); };
  const button = (/** @type {string} */ text, /** @type {string} */ title, /** @type {() => void} */ action) =>
    el("button", {type: "button", textContent: text, title, onclick: action});
  hud.append(
    button("−", "zoom out", () => zoomAt(camera.k / 1.25, ...center())),
    button("+", "zoom in", () => zoomAt(camera.k * 1.25, ...center())),
    button("fit", "show the whole graph", fit),
    button("layout", "arrange the nodes again", () => { layout(true); fit(); }),
  );
  applyView();

  return {
    /** The hud, for buttons of the page. */
    hud,
    fit,
    /** Arranges the nodes again, automatically or keeping where they are. */
    layout,
    /**
     * Shows a new evaluation and the page's choices. A different set of nodes builds and arranges the graph anew.
     * @param {View} next
     */
    update(next) {
      view = {...view, ...next, alternatives: next.alternatives ?? new Set()};
      const key = view.nodes ? [...view.nodes, "|", ...view.alternatives].sort().join(",") : "*";
      const rebuild = key !== shown;
      if (rebuild) { shown = key; build(); }
      for (const id of boxes.keys()) paint(id);
      layout(rebuild);
      if (rebuild) requestAnimationFrame(fit);
    },
    destroy() {
      events.abort();
      cancelAnimationFrame(frame);
      container.replaceChildren();
      container.classList.remove("clock-graph", "editable");
    },
  };
}

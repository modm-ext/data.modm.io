// Copyright 2026, Niklas Hauser
// SPDX-License-Identifier: MPL-2.0
// @ts-check
// The clock solver page: one graph per device, every node live at its setting. The clock logic is the Python of
// modm_data.clocks and modm_data_tools.clocks in a Pyodide worker (py.js), the graph is graph-view.js.

import "../shared/site.js";
import {$ as byId, clamp, h as el} from "../shared/util.js";
import * as py from "./py.js";
import {activePath, focusOf, fmtHz, humanError, label, short} from "./model.js";
import {createClockGraph} from "./graph-view.js";

/** @typedef {import("./model.js").Tree} Tree */
/** @typedef {import("./model.js").Result} Result */

// The page reads and sets the values of its inputs directly
const $ = /** @type {(id: string) => any} */ (byId);

const state = {
  /** @type {string | null} */ device: null,
  /** @type {Tree} */ tree: {nodes: {}},
  /** @type {any} */ api: null,
  /** @type {Record<string, any>} */ config: {}, // current choices by node id, options and modes by name
  /** @type {Set<string>} */ locked: new Set(), // nodes the solver must not move
  /** @type {Map<string, number>} */ targets: new Map(), // node id -> Hz
  /** @type {Set<string>} */ use: new Set(), // peripherals in use
  tolerance: 0,
  /** @type {Result} */ result: {},
  /** @type {any} */ solved: null,
  /** Only the active path to the targets and the peripherals in use */
  path: false,
};
/** @type {Record<string, string>} */
let devices = {};
/** @type {ReturnType<typeof createClockGraph> | null} */
let graph = null;

/** @type {Record<string, string> | null} */
let apiIndex = null;
async function loadApi(/** @type {string} */ device) {
  apiIndex ??= await fetch("data/rcc.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return apiIndex?.[device] ? fetch(`data/rcc/${apiIndex[device]}.json`).then((r) => r.json()) : null;
}

/** Max performance per clock tree at its default HSE, computed by the export: Pyodide is too slow for the search */
let maxIndex = null;
async function precomputedMax() {
  maxIndex ??= await fetch("data/max.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return maxIndex[devices[state.device]] ?? null;
}

async function start() {
  devices = await (await fetch("data/devices.json")).json();
  $("devices").append(...Object.keys(devices).map((d) => el("option", {value: d})));
  $("device").onchange = () => {
    const name = matchDevice($("device").value);
    if (name) load(name, {});
    else status("err", `no clock tree for ${$("device").value.trim()}`);
  };
  $("solve").onclick = solve;
  $("unlock").onclick = () => { state.locked.clear(); refresh(); };
  $("reset").onclick = () => {
    Object.assign(state, {config: {}, locked: new Set(), targets: new Map(), use: new Set(), solved: null});
    refresh();
  };
  $("maxperf").onclick = async () => { await maxPerf(); refresh(); };
  $("export").onclick = () => {
    const blob = new Blob([JSON.stringify(snapshot(), null, 1)], {type: "application/json"});
    const a = el("a", {href: URL.createObjectURL(blob), download: `${state.device}-clock.json`});
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $("import").onclick = () => $("importFile").click();
  $("importFile").onchange = async () => {
    const file = $("importFile").files[0];
    $("importFile").value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!devices[data.device]) throw new Error(`unknown device ${data.device}`);
      await load(data.device, data);
    } catch (error) { status("err", `import: ${/** @type {Error} */ (error).message}`); }
  };
  $("tolerance").onchange = () => { state.tolerance = Number($("tolerance").value) || 0; save(); };
  const side = (/** @type {boolean} */ hide) => {
    document.body.classList.toggle("noside", hide);
    $("sidebtn").textContent = hide ? "Show panel" : "Hide panel";
    try { localStorage.setItem("noside", hide ? "1" : ""); } catch {}
  };
  $("sidebtn").onclick = () => side(!document.body.classList.contains("noside"));
  // Drag the grip to resize the panel, the width is remembered like the panel itself
  const width = (/** @type {number} */ px) => {
    document.body.style.setProperty("--side", `${Math.round(clamp(px, 240, innerWidth - 200))}px`);
  };
  $("grip").onpointerdown = (/** @type {PointerEvent} */ e) => {
    const grip = $("grip");
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("drag");
    grip.onpointermove = (/** @type {PointerEvent} */ m) => width(innerWidth - m.clientX);
    grip.onpointerup = () => {
      grip.onpointermove = grip.onpointerup = null;
      grip.classList.remove("drag");
      try { localStorage.setItem("side", document.body.style.getPropertyValue("--side")); } catch {}
    };
  };
  try { const saved = parseInt(localStorage.getItem("side") ?? ""); if (saved) width(saved); } catch {}
  try { side(Boolean(localStorage.getItem("noside"))); } catch {}
  const saved = await readHash();
  await load(saved?.device && devices[saved.device] ? saved.device : "STM32G071RBTx", saved ?? {});
}

function status(/** @type {string} */ cls, /** @type {string} */ text) {
  $("status").replaceChildren(text ? el("span", {className: cls, textContent: text}) : "");
}

function matchDevice(/** @type {string} */ text) {
  const key = text.trim().toUpperCase().replace(/^(?!STM32)/, "STM32");
  // Device names end in mixed case (STM32H743ZITx), compare without case
  return Object.keys(devices).find((d) => d.toUpperCase() === key) ??
    Object.keys(devices).find((d) => d.toUpperCase().startsWith(key)) ?? null;
}

async function load(/** @type {string} */ device, /** @type {any} */ saved) {
  status("sub", `loading ${device}…`);
  const text = await (await fetch(`data/tree/${devices[device]}.json`)).text();
  const tree = JSON.parse(text);
  state.api = await loadApi(device);
  await py.load(device, text, state.api);
  Object.assign(state, {
    device, tree, solved: null,
    config: saved.config ?? {}, locked: new Set(saved.locked ?? []),
    targets: new Map(Object.entries(saved.targets ?? {}).map(([k, v]) => [k, Number(v)])),
    use: new Set(saved.use ?? []), tolerance: Number(saved.tolerance ?? 0), path: Boolean(saved.path),
  });
  $("device").value = device;
  $("tolerance").value = state.tolerance;
  graph?.destroy();
  graph = createClockGraph($("stage"), tree, {
    onChoose: (id, value) => {
      // A choice made by hand stays put: the solver may not move it until it is unlocked
      state.config[id] = value;
      state.locked.add(id);
      state.solved = null;
      refresh();
    },
    onLock: (id, locked) => { locked ? state.locked.add(id) : state.locked.delete(id); refresh(); },
    onTarget: setTarget,
    onUse: (id, used) => { used ? state.use.add(id) : state.use.delete(id); refresh(); },
  });
  const pathButton = el("button", {type: "button", textContent: "path",
    title: "only the active path to the targets and the peripherals in use"});
  pathButton.setAttribute("aria-pressed", String(state.path));
  pathButton.onclick = () => {
    state.path = !state.path;
    pathButton.setAttribute("aria-pressed", String(state.path));
    paint();
    save();
  };
  graph.hud.prepend(pathButton);
  // A device opened fresh starts at its highest performance, a saved one (boot config included) stays as saved
  if (!saved.config) await maxPerf();
  await refresh();
}

/* ------------------------------------------------------------------ state */

const useSet = () => new Set([...state.use, ...[...state.targets.keys()].filter((id) => state.tree.nodes[id]?.kind === "peripheral")]);

let generation = 0;
async function refresh() {
  // Only the latest of overlapping refreshes paints
  const mine = ++generation;
  let result, code;
  try {
    result = await py.evaluate(state.config, useSet());
    code = await py.generate(state.config, useSet()).catch((error) => `// code generation failed: ${error.message}`);
  } catch (error) {
    if (mine === generation) status("err", /** @type {Error} */ (error).message);
    return;
  }
  if (mine !== generation) return;
  state.result = result;
  $("code").textContent = code;
  paint();
  sidePanel();
  save();
}

/** The graph at the current result: everything, or the active path with the other inputs of its muxes. */
function paint() {
  const path = state.path ? activePath(state.tree, state.result, focusOf(state.tree, state.result, state.targets.keys(), useSet()), {alternatives: true}) : null;
  graph?.update({result: state.result, locked: state.locked, targets: state.targets, use: state.use,
    nodes: path?.nodes ?? null, alternatives: path?.alternatives});
}

function snapshot() {
  return {device: state.device, config: state.config, locked: [...state.locked],
    targets: Object.fromEntries(state.targets), use: [...state.use], tolerance: state.tolerance,
    ...(state.path ? {path: true} : {})};
}

// The hash is base64url of the deflated JSON: a few hundred characters instead of kilobytes of %XX
async function pipe(/** @type {Uint8Array} */ bytes, /** @type {TransformStream} */ stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

let saving = 0;
async function save() {
  const mine = ++saving;
  const z = await pipe(new TextEncoder().encode(JSON.stringify(snapshot())), new CompressionStream("deflate-raw"));
  const b64 = btoa(String.fromCharCode(...z)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (mine === saving) history.replaceState(null, "", "#" + b64);
}

async function readHash() {
  const hash = location.hash.slice(1);
  try {
    if (!hash) return null;
    const bin = atob(hash.replace(/-/g, "+").replace(/_/g, "/"));
    const z = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(await pipe(z, new DecompressionStream("deflate-raw"))));
  } catch { return null; }
}

function setTarget(/** @type {string} */ id, /** @type {number | null} */ hz) {
  if (hz === null) state.targets.delete(id);
  else state.targets.set(id, hz);
  if (state.targets.size) solve(); else refresh();
}

/** The names of the core clocks that max performance raises */
const CORE = {SysCLKOutput: "SYSCLK", CpuClockOutput: "CPU clock", AHBOutput: "HCLK"};

/** Highest SYSCLK from the HSE, every peripheral in use if that works; everything else unlocked. */
async function maxPerf() {
  const t0 = performance.now();
  const hse = state.config.HSEOSC, pre = await precomputedMax();
  const r = pre && (hse === undefined || String(hse) === String(pre.config.HSEOSC)) ? pre
    : await py.maxPerformance(hse ? {HSEOSC: hse} : {});
  const ms = Math.round(performance.now() - t0);
  if (!r) {
    state.solved = {ok: false, ms, unmet: [{id: null, why: "no HSE or SYSCLK in this tree"}], problems: []};
    return;
  }
  // Every peripheral ticked when that works, each one can be unticked afterwards
  const all = Object.keys(state.tree.nodes).filter((id) => state.tree.nodes[id].kind === "peripheral");
  Object.assign(state, {config: r.config, locked: new Set(), targets: new Map(), use: new Set(r.use === null ? all : [])});
  state.solved = {ok: true, ms, changed: Object.keys(r.config),
    note: `max performance from HSE: ${CORE[r.core] ?? label(r.core)} ${fmtHz(r.result[r.core]?.freq)}, ${r.use === null ? "every peripheral ticked" : "not possible with every peripheral in use, none ticked"}`};
}

async function solve() {
  const t0 = performance.now();
  status("sub", "solving…");
  const r = await py.solve({config: state.config, locked: state.locked, targets: Object.fromEntries(state.targets),
    use: useSet(), tolerance: state.tolerance * 1e-6, budget: 3});
  const ms = Math.round(performance.now() - t0);
  if (r.ok) {
    const changed = Object.keys(r.config).filter((k) => String(r.config[k]) !== String(state.config[k] ?? ""));
    state.config = r.config;
    state.solved = {ok: true, ms, changed};
  } else {
    state.solved = {ok: false, ms, unmet: r.unmet, problems: r.problems, timeout: r.timeout};
  }
  refresh();
}

/* ------------------------------------------------------------------- side */

function sidePanel() {
  const r = state.result, s = state.solved;
  if (!s) status("sub", state.targets.size ? "targets set, press Solve" : "");
  else if (s.ok) status("ok", `${s.note ?? "solved"} (${s.ms} ms, ${s.changed.length} settings)`);
  else status("err", `no solution (${s.ms} ms)`);

  const box = $("result");
  box.textContent = "";
  const errors = Object.entries(r).filter(([, v]) => v.used && v.errors?.length);
  const fl = r.FLatency?.setting, opts = r.options?.setting ?? {};
  box.append(el("div", {className: "sub", textContent: [state.device, state.tree.tree, state.tree.rcc, `${Object.keys(state.tree.nodes).length} nodes`].filter(Boolean).join(" · ")}));
  const flash = el("div", {}, "flash: ", el("b", {textContent: fl ?? "—"}));
  if (opts.PWR_Regulator_Voltage_Scale) flash.append(" · scale ", el("b", {textContent: short(opts.PWR_Regulator_Voltage_Scale)}));
  if (opts.PWREXT_OverDrive) flash.append(" · over-drive ", el("b", {textContent: short(opts.PWREXT_OverDrive)}));
  box.append(flash);
  if (s && !s.ok) {
    const items = s.unmet.map((/** @type {any} */ u) => u.id ? `${label(u.id)} ${fmtHz(state.targets.get(u.id))}: ${u.why}${u.closest ? `, closest ${fmtHz(u.closest)}` : ""}` : u.why);
    box.append(el("div", {className: "err", textContent: "Targets not met:"}), el("ul", {className: "list err"}, ...items.map((/** @type {string} */ t) => el("li", {textContent: t}))));
    if (s.problems.length) box.append(el("div", {className: "sub", textContent: "best attempt breaks:"}),
      el("ul", {className: "list"}, ...s.problems.slice(0, 8).map((/** @type {string} */ t) => el("li", {textContent: humanError(t)}))));
  }
  if (errors.length) box.append(el("div", {className: "err", textContent: `${errors.length} nodes break a limit`}),
    el("ul", {className: "list err"}, ...errors.slice(0, 12).map(([id, v]) => el("li", {textContent: `${label(id)}: ${(v.errors ?? []).map(humanError).join(", ")}`}))));
  else box.append(el("div", {className: "ok", textContent: "all limits met"}));
  if (state.targets.size) box.append(el("div", {className: "sub", textContent: "targets: " +
    [...state.targets].map(([id, f]) => `${label(id)} ${fmtHz(f)} → ${fmtHz(r[id]?.freq)}`).join(", ")}));

  // Options that no node stands for and the oscillator modes; derived ones follow the clocks unless set
  const opt = $("options");
  opt.textContent = "";
  for (const [name, values] of Object.entries(state.tree.choices ?? {})) {
    const derived = name in (state.tree.derived ?? {});
    const select = el("select");
    select.append(el("option", {value: "", textContent: derived ? `auto: ${short(opts[name])}` : `default: ${short(state.tree.options?.[name])}`}));
    for (const v of values) select.append(el("option", {value: v, textContent: short(v)}));
    select.value = state.config[name] ?? "";
    select.onchange = () => { if (select.value) state.config[name] = select.value; else delete state.config[name]; state.solved = null; refresh(); };
    opt.append(el("div", {className: "opt"}, el("span", {textContent: name}), select));
  }
  for (const [name, modes] of Object.entries(state.tree.modes ?? {})) {
    const select = el("select");
    select.append(el("option", {value: "", textContent: "unset"}));
    for (const m of Object.keys(modes)) select.append(el("option", {value: m, textContent: m}));
    select.value = state.config[name] ?? "";
    select.onchange = () => { if (select.value) state.config[name] = select.value; else delete state.config[name]; refresh(); };
    opt.append(el("div", {className: "opt"}, el("span", {textContent: `${name} mode`}), select));
  }
}

start().catch((error) => {
  status("err", error.message);
  throw error;
});

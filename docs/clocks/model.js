// Copyright 2026, Niklas Hauser
// SPDX-License-Identifier: MPL-2.0
// @ts-check
// The clock trees of `python -m modm_data.clocks` and the results of modm_data.clocks.evaluate():
// what a node offers, how it is set, its limits, and which nodes form the active path to a target.
// No DOM access, so the MCP server and tests can use it too.

/**
 * @typedef {{from: string, macro?: string, signal?: string}} Input
 * @typedef {{kind: string, inputs: Input[], outputs?: string[], domain?: {factor?: number, value: any}[],
 *            range?: [number, number], rules?: any, param?: string, bus?: string, value?: any, default?: any,
 *            min?: number, max?: number, out_min?: number, out_max?: number, limits?: any[], out_limits?: any[]}} Node
 * @typedef {{nodes: Record<string, Node>, tree?: string, rcc?: string, choices?: Record<string, string[]>,
 *            derived?: Record<string, any>, options?: Record<string, string>, modes?: Record<string, any>}} Tree
 * @typedef {{freq?: number | null, setting?: any, used?: boolean, errors?: string[],
 *            bounds?: Record<string, [number | null, number | null]>}} NodeResult
 * @typedef {Record<string, NodeResult> & {options?: any, FLatency?: any}} Result
 */

/** Frequencies with a unit: 170 MHz, 32.768 kHz. */
export function fmtHz(/** @type {number | null | undefined} */ hz) {
  if (hz === null || hz === undefined || !Number.isFinite(hz)) return "—";
  for (const [unit, scale] of /** @type {[string, number][]} */ ([["GHz", 1e9], ["MHz", 1e6], ["kHz", 1e3]]))
    if (Math.abs(hz) >= scale) return `${Number((hz / scale).toPrecision(7))} ${unit}`;
  return `${Number(hz.toPrecision(7))} Hz`;
}

/** The unit of the input fields of a node around this frequency: kHz for the slow clocks (LSI, LSE, RTC), else MHz. */
export const unitOf = (/** @type {number | null | undefined} */ hz) =>
  /** @type {[string, number]} */ (hz && Math.abs(hz) < 1e6 ? ["kHz", 1e3] : ["MHz", 1e6]);

/** A frequency as a plain number in a unit of unitOf() for an input field. */
export const inUnit = (/** @type {number | null | undefined} */ hz, /** @type {number} */ scale) =>
  hz === null || hz === undefined ? "" : String(Number((hz / scale).toPrecision(9)));

/** CubeMX calls dividers devisors, the UI does not. */
export const label = (/** @type {any} */ text) => String(text).replace(/Devisor/g, "Divider").replace(/devisor/g, "divider");

/** A CubeMX macro without its prefix. */
export const short = (/** @type {any} */ macro) =>
  String(macro ?? "").replace(/^(PWR_REGULATOR_VOLTAGE_|PWREXT_OverDrive_|RCC_\w+?SOURCE_|RCC_)/, "");

export const KIND = {mux: "mux", div: "divider", mul: "multiplier", mulfrac: "multiplier", frac: "fraction",
  fixed: "fixed", varied: "source", choice: "source", output: "output", peripheral: "peripheral"};

/** The factors a divider or multiplier offers, like solver.py's factors_of(). */
export const factorsOf = (/** @type {Node} */ node) =>
  node.domain
    ? node.domain.map((d) => d.factor ?? d.value)
    : node.range
      ? Array.from({length: node.range[1] - node.range[0] + 1}, (_, i) => /** @type {[number, number]} */ (node.range)[0] + i)
      : [];

/** Whether a node can be set, like solver.py's is_variable(). */
export const isVariable = (/** @type {Node} */ node) =>
  node.kind === "mux"
    ? node.inputs.length > 1
    : ["div", "mul", "mulfrac", "frac"].includes(node.kind)
      ? !node.rules && factorsOf(node).length > 1
      : node.kind === "choice" && (node.domain?.length ?? 0) > 1;

/** The value a mux input stands for in a configuration. */
export const inputValue = (/** @type {Input} */ input) => input.macro || input.from;

/**
 * The setting a node stands at, as the evaluation saw it, else its own value or default.
 * @param {Tree} tree
 * @param {Result | null} result
 * @param {string} id
 */
export const settingOf = (tree, result, id) => result?.[id]?.setting ?? tree.nodes[id]?.value ?? tree.nodes[id]?.default;

/** Error texts with the frequencies in Hz written with a unit. */
export const humanError = (/** @type {string} */ text) =>
  text.replace(/\d+(?:\.\d+)?(?:e[+-]\d+)?/g, (m) => (Number(m) >= 1000 ? fmtHz(Number(m)) : m));

/**
 * The limits that apply in this configuration, from evaluate()'s bounds, else the static ones.
 * @param {Node} node
 * @param {NodeResult} r
 */
export function limitText(node, r) {
  const parts = [];
  const span = (/** @type {[number | null, number | null]} */ [lo, hi]) =>
    lo && hi ? `${fmtHz(lo)}…${fmtHz(hi)}` : hi ? `≤ ${fmtHz(hi)}` : lo ? `≥ ${fmtHz(lo)}` : "";
  for (const prefix of ["", "out_"]) {
    let b = r.bounds?.[prefix];
    if (!b && (prefix === "out_" || ["fixed", "varied", "output"].includes(node.kind)))
      b = [/** @type {any} */ (node)[`${prefix}min`] ?? null, /** @type {any} */ (node)[`${prefix}max`] ?? null];
    const text = b ? span(b) : "";
    if (text) parts.push(text);
  }
  const variants = (node.limits?.length ?? 0) + (node.out_limits?.length ?? 0);
  return parts.length ? parts.join(" · ") + (variants > 1 ? " (depends on config)" : "") : "";
}

/**
 * How the graph folds: outputs that only feed peripherals, and the peripherals, become lines inside the node
 * that feeds them (a box each makes the graph three times taller), and kernel clock muxes that only clock
 * peripherals become cards below the graph.
 * @param {Tree} tree
 * @param {{cards?: boolean}} [options]
 */
export function fold(tree, {cards = true} = {}) {
  const nodes = tree.nodes;
  /** @type {Record<string, string>} */
  const host = {};
  /** @type {Map<string, string[]>} */
  const feeds = new Map();
  const owner = (/** @type {string} */ id) => host[id] ?? id;
  const leafOut = (/** @type {Node} */ n) =>
    n.kind === "output" && n.inputs.length === 1 && nodes[n.inputs[0].from] &&
    (n.outputs ?? []).every((o) => nodes[o]?.kind === "peripheral");
  for (const [id, n] of Object.entries(nodes)) {
    if (!leafOut(n)) continue;
    host[id] = n.inputs[0].from;
    // An output that feeds nothing is a line of its own
    if (!n.outputs?.length) feeds.set(host[id], [...(feeds.get(host[id]) ?? []), id]);
  }
  for (const [id, n] of Object.entries(nodes)) {
    if (n.kind !== "peripheral" || n.inputs.length !== 1 || !nodes[n.inputs[0].from]) continue;
    host[id] = owner(n.inputs[0].from);
    feeds.set(host[id], [...(feeds.get(host[id]) ?? []), id]);
  }
  const wide = new Set(
    cards
      ? Object.keys(nodes).filter(
          (id) => !host[id] && nodes[id].kind === "mux" && nodes[id].inputs.length > 1 &&
            (nodes[id].outputs ?? []).every((o) => host[o]),
        )
      : [],
  );
  return {host, feeds, cards: wide, owner};
}

/**
 * The active path to some nodes: from each focus node upstream to the clock sources, through the selected input
 * of every mux. With alternatives, the other inputs of these muxes are added too (only them, not their sources),
 * so a view can show what else a mux could choose.
 * @param {Tree} tree
 * @param {Result} result
 * @param {Iterable<string>} focus node ids, e.g. the targets and the peripherals in use
 * @param {{alternatives?: boolean}} [options]
 * @returns {{nodes: Set<string>, alternatives: Set<string>}}
 */
export function activePath(tree, result, focus, {alternatives = false} = {}) {
  const nodes = new Set();
  const others = new Set();
  const stack = [...focus].filter((id) => tree.nodes[id]);
  while (stack.length) {
    const id = /** @type {string} */ (stack.pop());
    if (nodes.has(id)) continue;
    nodes.add(id);
    const node = tree.nodes[id];
    const selected = node.kind === "mux" ? settingOf(tree, result, id) : undefined;
    for (const input of node.inputs) {
      if (!tree.nodes[input.from]) continue;
      if (node.kind === "mux" && inputValue(input) !== selected) {
        if (alternatives) others.add(input.from);
        continue;
      }
      stack.push(input.from);
    }
  }
  for (const id of nodes) others.delete(id);
  return {nodes, alternatives: others};
}

/**
 * The nodes worth showing for a result: the targets and the peripherals in use, else everything in use.
 * @param {Tree} tree
 * @param {Result} result
 * @param {Iterable<string>} [targets]
 * @param {Iterable<string>} [use]
 */
export function focusOf(tree, result, targets = [], use = []) {
  const focus = new Set([...targets, ...use].filter((id) => tree.nodes[id]));
  if (focus.size) return focus;
  const used = Object.keys(tree.nodes).filter((id) => result[id]?.used);
  const peripherals = used.filter((id) => tree.nodes[id].kind === "peripheral");
  return new Set(peripherals.length ? peripherals : used);
}

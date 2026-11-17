// Copyright 2026, Niklas Hauser
// SPDX-License-Identifier: MPL-2.0
// @ts-check
// The board data of `python -m modm_data.html2pinout` (nucleo.json) and how pins match a filter.
// No DOM access, so the MCP server and tests can use it too.

/**
 * @typedef {{kind: string, signal: string, label?: string, net?: string, function?: string,
 *            bridge?: string, remark?: string, pin?: string}} Pin
 * @typedef {{type: string, side?: string, pins: Record<string, Pin>}} Connector
 * @typedef {{ids: string[], name?: string, gpios: string[], pins: Record<string, string[]>, source?: string,
 *            default_from?: string, states: {state: string, text: string, default?: boolean}[]}} Bridge
 * @typedef {{board: string, device?: string, document?: string, pinout?: string,
 *            connectors: Record<string, Connector>, uses?: Record<string, any>, bridges?: Bridge[],
 *            signals: Record<string, Record<string, number | null>>}} Board
 * @typedef {{side: string, row: number, reverse?: boolean, count?: number, morpho?: boolean}} Spot
 * @typedef {{names: string[], functions: string[]}} Hit
 * @typedef {{key: string, count: number, marks: Map<string, Hit>}} Result
 */

// These connectors count along one row and then along the other, instead of across
export const PAIRED = ["stmod", "pmod", "mikrobus"];

export const short = (/** @type {Board} */ board) => board.board.replace("NUCLEO-", "");

/**
 * The rows that the ARDUINO and Zio headers occupy next to the morpho headers. All boards use the
 * ARDUINO Uno footprint, where the right headers count from the bottom. Zio extends it downwards.
 * @param {Connector} connector
 * @param {() => number} nano
 * @returns {Spot | undefined}
 */
export function place(connector, nano) {
  const count = Math.max(...Object.keys(connector.pins).map(Number));
  const gpio = Object.values(connector.pins).some((pin) => pin.kind === "gpio");
  if (connector.type === "arduino") {
    if (count === 8 && !gpio) return {side: "left", row: 4};
    if (count === 6) return {side: "left", row: 13};
    if (count === 9 || count === 10) return {side: "right", row: 1, reverse: true, count: 10};
    if (count === 8) return {side: "right", row: 11, reverse: true};
    // The two ARDUINO Nano headers of the Nucleo-32 boards both count from the top
    if (count === 15) return {side: nano() ? "right" : "left", row: 0};
  }
  if (connector.type === "zio") {
    return /** @type {Record<number, Spot>} */ ({
      16: {side: "left", row: 4},
      30: {side: "left", row: 13},
      20: {side: "right", row: 1},
      34: {side: "right", row: 11},
    })[count];
  }
  return connector.side ? {side: connector.side, row: 0, morpho: true} : undefined;
}

/**
 * All connectors of a board with their place on it, which makes them comparable between boards.
 * @param {Board} board
 */
export function connectors(board) {
  let nano = 0;
  /** @type {Record<string, number>} */
  const counts = {};
  return Object.entries(board.connectors).map(([name, connector]) => {
    const spot = place(connector, () => nano++);
    // STMod+, Pmod and mikroBUS are standards too, but without a common place on the board
    const index = (counts[connector.type] = (counts[connector.type] || 0) + 1);
    const position = spot
      ? `${connector.type} ${spot.side} ${spot.row}`
      : PAIRED.includes(connector.type)
        ? `${connector.type} ${index}`
        : name;
    return {name, connector, spot, position};
  });
}

/** What the board itself connects to the pin: ST-LINK, Ethernet PHY, crystal, LED, button, ... */
export const used = (/** @type {Board} */ board, /** @type {Pin} */ pin) =>
  pin.kind === "gpio" ? (board.uses || {})[pin.signal] : undefined;

/** The solder bridges and jumpers whose description mentions the pin. */
export const bridges = (/** @type {Board} */ board, /** @type {Pin} */ pin) =>
  pin.kind === "gpio" ? (board.bridges || []).filter((b) => b.gpios.includes(pin.signal)) : [];

/** The bridges of a group that belong to this pin, if the manual tells them apart. */
export const own = (/** @type {Bridge} */ bridge, /** @type {Pin} */ pin) => {
  const ids = bridge.ids.filter((id) => (bridge.pins[id] || []).includes(pin.signal));
  return ids.length ? ids : bridge.ids;
};

/**
 * A used pin still counts as available if a solder bridge may free it.
 * @param {"" | "bridge" | "free"} free
 */
export const taken = (/** @type {Board} */ board, /** @type {Pin} */ pin, free) =>
  free && used(board, pin) && (free === "free" || !bridges(board, pin).length);

/**
 * The names of a pin that the filter matches: its signal, connector label, net and device functions.
 * @param {Board} board
 * @param {Pin} pin
 * @param {RegExp} pattern
 * @returns {Hit}
 */
export function hits(board, pin, pattern) {
  const use = used(board, pin) || {};
  const names = [
    pin.signal,
    ...(pin.label || "").split(" / "),
    pin.net,
    use.label,
    use.signal,
    use.use,
    ...bridges(board, pin).flatMap((b) => own(b, pin)),
  ].filter(Boolean);
  const functions = pin.kind === "gpio" ? Object.keys(board.signals[pin.signal] || {}) : [];
  return {
    names: [...new Set(names)].filter((name) => pattern.test(name)),
    functions: functions.filter((name) => pattern.test(name)),
  };
}

// USART2_TX and USART1_TX are the same function on a different instance
const generic = (/** @type {string} */ name) => name.replace(/^([A-Z]+)\d+_/, "$1_");

/**
 * The matching pins of a board, boards with the same key are position compatible.
 * @param {Board} board
 * @param {RegExp | null} pattern
 * @param {{compat?: "name" | "function" | "position", free?: "" | "bridge" | "free"}} [options]
 * @returns {Result}
 */
export function analyze(board, pattern, {compat = "name", free = ""} = {}) {
  const key = [];
  let count = 0;
  const marks = new Map();
  for (const {name, connector, position} of connectors(board)) {
    for (const [number, pin] of Object.entries(connector.pins)) {
      const occupied = taken(board, pin, free);
      if (!pattern) {
        key.push(`${position}.${number}=${occupied ? "used" : pin.signal}`);
        continue;
      }
      if (occupied) continue;
      const hit = hits(board, pin, pattern);
      if (!hit.names.length && !hit.functions.length) continue;
      count += 1;
      marks.set(`${name}.${number}`, hit);
      const what = {
        name: [...hit.names.filter((n) => n === pin.signal), ...hit.functions].join("+") || pin.signal,
        function: [...new Set(hit.functions.map(generic))].join("+") || pin.kind,
        position: "",
      }[compat];
      key.push(`${position}.${number}=${what}`);
    }
  }
  return {key: key.join("|"), count, marks};
}

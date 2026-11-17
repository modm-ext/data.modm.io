// Copyright 2026, Niklas Hauser
// SPDX-License-Identifier: MPL-2.0
// @ts-check
// Views of a board: its connectors laid out like on the PCB, and the details of one pin.
// They take the board data and draw into an element, nothing else, so other pages and the
// MCP server can show them too. Styles: ../shared/theme.css and board-view.css.

import {el, renderChips, renderFacts} from "../shared/util.js";
import {PAIRED, bridges, connectors, own, used} from "./model.js";

/** @typedef {import("./model.js").Board} Board */
/** @typedef {import("./model.js").Pin} Pin */
/** @typedef {import("./model.js").Connector} Connector */
/** @typedef {import("./model.js").Hit} Hit */
/** @typedef {import("./model.js").Spot} Spot */

/**
 * @param {Board} board
 * @param {string} name
 * @param {string} number
 * @param {Pin} pin
 * @param {Hit | undefined} hit
 * @param {string} side "l" or "r"
 * @param {string} id the board in data-pin="<id>|<connector>|<number>"
 */
function renderPin(board, name, number, pin, hit, side, id) {
  const node = el("div", `pin ${pin.kind} ${side}`, pin.signal);
  const use = used(board, pin);
  if (use) node.classList.add("used");
  const links = bridges(board, pin);
  if (links.length) {
    node.classList.add("sb");
    node.dataset.bridges = links.flatMap((b) => b.ids).join(" ");
  }
  // The pin name stays next to the pin number, everything else goes on the outer side
  const outside = (/** @type {string} */ text) =>
    side === "l" ? node.prepend(el("small", "", text), " ") : node.append(" ", el("small", "", text));
  if (hit) {
    node.classList.add("hit");
    const extra = [...hit.names.filter((n) => n !== pin.signal), ...hit.functions];
    if (extra.length) outside(extra.join(" "));
  } else if (use) {
    outside(use.label || use.signal);
  }
  node.dataset.pin = `${id}|${name}|${number}`;
  if (pin.kind === "gpio") node.dataset.signal = pin.signal;
  node.title = `${name}-${number}`;
  return node;
}

/**
 * @param {Board} board
 * @param {string} name
 * @param {Connector} connector
 * @param {Map<string, Hit>} marks
 * @param {string} id
 * @param {Partial<Spot>} [spot]
 */
function renderRows(board, name, connector, marks, id, spot = {}) {
  // ARDUINO Uno and Nano headers are a single row, morpho and Zio have an odd and an even row
  const single = connector.type === "arduino";
  const mirror = single && spot.side === "right";
  const rows = el("div", `rows${single ? " single" : ""}${mirror ? " mirror" : ""}`);
  const last = spot.count || Math.max(...Object.keys(connector.pins).map(Number));
  const cell = (/** @type {number} */ number, /** @type {string} */ side) => {
    const pin = connector.pins[number];
    const mark = marks.get(`${name}.${number}`);
    return pin ? renderPin(board, name, String(number), pin, mark, side, id) : el("div", "pin nc " + side, "?");
  };
  if (single) {
    for (let index = 1; index <= last; index++) {
      const number = spot.reverse ? last + 1 - index : index;
      const cells = [el("div", "num", String(number)), cell(number, mirror ? "l" : "r")];
      rows.append(...(mirror ? cells.reverse() : cells));
    }
  } else {
    const half = PAIRED.includes(connector.type) ? Math.ceil(last / 2) : 0;
    for (let number = 1; number <= (half || last); number += half ? 1 : 2) {
      const other = number + (half || 1);
      rows.append(cell(number, "l"), el("div", "num", String(number)), el("div", "num", String(other)), cell(other, "r"));
    }
  }
  return {rows, count: single ? last : Math.ceil(last / 2)};
}

/**
 * The connectors of a board, the morpho, ARDUINO and Zio headers in their place on the PCB.
 * @param {Board} board
 * @param {{marks?: Map<string, Hit>, id?: string, only?: string[]}} [options]
 *   marks: matching pins from analyze(), id: names the board in data-pin, only: connector names to show
 */
export function renderBoard(board, {marks = new Map(), id = "0", only} = {}) {
  const wrap = el("div", "board");
  const phys = el("div", "phys");
  const label = (/** @type {string} */ tag, /** @type {string} */ name, /** @type {Connector} */ connector) => {
    const node = el(tag, "", name);
    node.append(" ", el("span", "", [connector.type, connector.side].filter(Boolean).join(" ")));
    return node;
  };
  for (const {name, connector, spot} of connectors(board)) {
    if (only && !only.includes(name)) continue;
    const {rows, count} = renderRows(board, name, connector, marks, id, spot);
    if (!spot || only) {
      const block = el("div", "conn");
      block.append(label("b", name, connector), rows);
      wrap.append(block);
      continue;
    }
    // Columns: left morpho, left inner, right inner, right morpho
    const column = spot.morpho ? (spot.side === "left" ? 1 : 4) : spot.side === "left" ? 2 : 3;
    const node = spot.morpho ? rows : el("div", "slot");
    if (spot.morpho) {
      const title = label("b", name, connector);
      title.style.gridColumn = String(column);
      phys.append(title);
    } else {
      const tag = label("i", name, connector);
      node.append(...(spot.side === "left" ? [rows, tag] : [tag, rows]));
    }
    node.style.gridColumn = String(column);
    node.style.gridRow = `${spot.row + 2} / span ${count}`;
    phys.append(node);
  }
  if (phys.children.length) wrap.prepend(phys);
  return wrap;
}

/** The legend of the pin colours. */
export function renderLegend() {
  const legend = el("div", "legend");
  for (const kind of ["gpio", "power", "ground", "system", "nc"]) legend.append(el("span", `pin ${kind}`, kind));
  legend.append(
    el("span", "pin used r", "used on board"),
    el("span", "pin used sb r", "used, has bridge"),
    el("span", "pin sb r", "has bridge"),
    el("span", "pin hit", "match"),
  );
  return legend;
}

/**
 * The details of one connector pin: what the board uses it for, its solder bridges and the
 * alternate functions of the device, the ones that match the pattern are marked.
 * @param {Board} board
 * @param {string} name
 * @param {string} number
 * @param {RegExp | null} [pattern]
 */
export function renderPinDetails(board, name, number, pattern = null) {
  const pin = board.connectors[name].pins[number];
  const box = el("div", "pin-details");
  box.append(el("h3", "", `${pin.signal}`), el("div", "sub", `${board.board} ${name}-${number}`));
  const use = used(board, pin);
  box.append(renderFacts([
    ["kind", pin.kind],
    ["used for", use && [use.use, use.label].filter(Boolean).join(": ")],
    ["used as", use?.signal],
    ["wired to", use?.part],
    ["label", pin.label],
    ["net", pin.net],
    ["function", pin.function],
    ["bridge", pin.bridge],
    ["remark", pin.remark],
    ["manual", pin.pin],
    ["device", board.device],
    ["source", board.document],
  ]));
  for (const bridge of bridges(board, pin)) {
    box.append(el("hr"));
    const block = el("div", "bridge");
    const ids = own(bridge, pin);
    const title = el("b", "", ids.join(", "));
    const group = ids.length < bridge.ids.length ? `with ${bridge.ids.filter((id) => !ids.includes(id)).join(", ")}` : "";
    title.append(" ", el("span", "", [bridge.name, group].filter(Boolean).join(" · ")));
    title.title = bridge.source || "";
    block.append(title);
    for (const option of bridge.states) {
      const line = el("p", option.default ? "default" : "");
      const state = option.default ? (bridge.default_from ? ` default in ${bridge.default_from}` : " default") : "";
      line.append(el("code", "", option.state + state), el("span", "", option.text));
      block.append(line);
    }
    box.append(block);
  }
  const functions = board.signals[pin.signal] || {};
  if (Object.keys(functions).length) {
    const af = (/** @type {string} */ signal) => (functions[signal] === null ? signal : `AF${functions[signal]} ${signal}`);
    box.append(el("hr"), renderChips(Object.keys(functions), pattern, af));
  } else if (pin.kind === "gpio") {
    box.append(el("p", "", "No alternate function data for this device."));
  }
  return box;
}

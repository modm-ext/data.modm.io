// Copyright 2026, Niklas Hauser
// SPDX-License-Identifier: MPL-2.0
// @ts-check
// The board pinout page: filters in the URL hash, the compatible sets and the pin inspector.

import "../shared/site.js";
import {$, debounce, el, loadJSON, modes, regex, select} from "../shared/util.js";
import {analyze, short} from "./model.js";
import {renderBoard, renderLegend, renderPinDetails} from "./board-view.js";

/** @typedef {import("./model.js").Board} Board */
/** @typedef {import("./model.js").Result} Result */

const state = {
  /** @type {Board[]} */ boards: [],
  filter: "",
  board: "",
  /** @type {"name" | "function" | "position"} */ compat: "name",
  /** @type {"" | "bridge" | "free"} */ free: "",
  /** @type {Map<string, string>} */ shown: new Map(),
  /** @type {string | null} */ pinned: null,
};

function render() {
  const pattern = regex(state.filter);
  const boardPattern = regex(state.board);
  $("filter").classList.toggle("bad", pattern === undefined);
  $("board").classList.toggle("bad", boardPattern === undefined);
  if (pattern === undefined || boardPattern === undefined) return;

  /** @type {Map<string, {board: Board, result: Result}[]>} */
  const groups = new Map();
  const without = [];
  let pins = 0;
  for (const board of state.boards) {
    if (boardPattern && !boardPattern.test(board.board) && !boardPattern.test(board.device || "")) continue;
    const result = analyze(board, pattern, state);
    if (pattern && !result.count) {
      without.push(board);
      continue;
    }
    pins += result.count;
    if (!groups.has(result.key)) groups.set(result.key, []);
    groups.get(result.key)?.push({board, result});
  }
  const sorted = [...groups.values()].sort(
    (a, b) => b.length - a.length || a[0].board.board.localeCompare(b[0].board.board),
  );
  const total = sorted.reduce((sum, group) => sum + group.length, 0);

  $("t-boards").textContent = String(total);
  $("t-groups").textContent = String(sorted.length);
  $("t-pins").textContent = pattern ? String(pins) : "–";
  $("m-title").textContent = pattern ? `/${state.filter}/i` : "All pins";
  $("m-sub").textContent = pattern
    ? `${total} boards have matching pins, in ${sorted.length} position compatible sets.`
    : `${total} boards in ${sorted.length} sets with identical connectors.`;

  const list = $("list");
  const main = $("groups");
  list.textContent = "";
  main.textContent = "";
  sorted.forEach((group, index) => {
    const names = group.map(({board}) => short(board));
    const row = el("button", "row-button");
    row.setAttribute("type", "button");
    row.append(el("span", "count", String(group.length)), el("span", "name", names.join(" ")));
    if (pattern) row.append(el("span", "extra", `${group[0].result.count} pins`));
    row.title = names.join(", ");
    row.addEventListener("click", () => $(`g${index}`).scrollIntoView({behavior: "smooth", block: "start"}));
    list.append(row);

    const section = el("section", `group${pattern ? " filtered" : ""}${state.free ? ` free free-${state.free}` : ""}`);
    section.id = `g${index}`;
    const header = el("header");
    const title = el("h3", "", group.length === 1 ? "1 board" : `${group.length} compatible boards`);
    if (pattern) title.append(el("em", "", `${group[0].result.count} matching pins`));
    const chips = el("div", "chips");
    // One board stands for the whole set, the chips switch between them
    const current = group.find(({board}) => board.board === state.shown.get(group[0].board.board)) || group[0];
    for (const entry of group) {
      const chip = el("button", "chip", short(entry.board));
      chip.setAttribute("type", "button");
      chip.title = `${entry.board.device || "unknown device"}, ${entry.board.document}`;
      chip.setAttribute("aria-pressed", String(entry === current));
      chip.addEventListener("click", () => {
        state.shown.set(group[0].board.board, entry.board.board);
        render();
      });
      chips.append(chip);
    }
    header.append(title, chips);
    if (current.board.pinout) {
      // The pinout generator starts with what the board already uses its pins for
      const link = /** @type {HTMLAnchorElement} */ (el("a", "chip", "Pin mapping ↗"));
      link.href = `../pinout/${current.board.pinout}`;
      link.title = `Configure the ${current.board.device} of the ${current.board.board}`;
      chips.append(link);
    }
    const id = String(state.boards.indexOf(current.board));
    section.append(header, renderBoard(current.board, {marks: current.result.marks, id}));
    main.append(section);
  });

  if (!sorted.length) main.append(el("p", "empty", "No pin matches."));
  if (without.length) {
    const section = el("section", "group");
    const header = el("header");
    header.append(el("h3", "", `${without.length} boards without a matching pin`));
    const chips = el("div", "chips");
    for (const board of without) chips.append(el("span", "chip static", short(board)));
    header.append(chips);
    section.append(header);
    main.append(section);
  }

  const hash = new URLSearchParams();
  if (state.filter) hash.set("q", state.filter);
  if (state.board) hash.set("b", state.board);
  hash.set("m", state.compat);
  if (state.free) hash.set("f", state.free);
  history.replaceState(null, "", "#" + hash);
}

/** @param {string | null | undefined} id "<board index>|<connector>|<number>" */
function inspect(id) {
  const panel = $("inspect");
  if (!id) {
    panel.replaceChildren(
      el("h3", "", "Pin details"),
      el("p", "", "Hover a pin to see its alternate functions, click to keep it."),
      renderLegend(),
    );
    return;
  }
  const [index, name, number] = id.split("|");
  panel.replaceChildren(renderPinDetails(state.boards[Number(index)], name, number, regex(state.filter)));
}

async function start() {
  try {
    state.boards = (await loadJSON("nucleo.json")).boards;
  } catch (error) {
    $("m-title").textContent = "Could not load nucleo.json";
    $("m-sub").textContent = /** @type {Error} */ (error).message;
    return;
  }

  const hash = new URLSearchParams(location.hash.slice(1));
  state.filter = hash.get("q") || "";
  state.board = hash.get("b") || "";
  const compat = hash.get("m");
  if (compat === "name" || compat === "function" || compat === "position") state.compat = compat;
  const free = hash.get("f");
  state.free = free === "bridge" || free === "free" ? free : "";
  select($("free"), "free", state.free);
  select($("compat"), "compat", state.compat);
  /** @type {HTMLInputElement} */ ($("filter")).value = state.filter;
  /** @type {HTMLInputElement} */ ($("board")).value = state.board;

  const later = debounce(render);
  for (const key of /** @type {const} */ (["filter", "board"])) {
    $(key).addEventListener("input", (event) => {
      state[key] = /** @type {HTMLInputElement} */ (event.target).value.trim();
      later();
    });
  }
  modes($("compat"), "compat", (value) => {
    state.compat = /** @type {typeof state.compat} */ (value);
    render();
  });
  modes($("free"), "free", (value) => {
    state.free = /** @type {typeof state.free} */ (value);
    render();
  });

  const groups = $("groups");
  groups.addEventListener("mouseover", (event) => {
    const pin = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest("[data-pin]"));
    const board = pin?.closest(".board");
    // The same GPIO is often routed to several headers
    for (const old of groups.querySelectorAll(".pin.same")) old.classList.remove("same");
    if (pin && board && pin.dataset.signal) {
      for (const twin of board.querySelectorAll(`[data-signal="${pin.dataset.signal}"]`)) {
        if (twin !== pin) twin.classList.add("same");
      }
    }
    // A solder bridge often changes several pins at once
    for (const id of pin?.dataset.bridges ? pin.dataset.bridges.split(" ") : []) {
      for (const twin of board?.querySelectorAll(`[data-bridges~="${id}"]`) ?? []) {
        if (twin !== pin) twin.classList.add("same");
      }
    }
    if (pin && !state.pinned) inspect(pin.dataset.pin);
  });
  groups.addEventListener("click", (event) => {
    const pin = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest("[data-pin]"));
    for (const old of groups.querySelectorAll(".pin.sel")) old.classList.remove("sel");
    state.pinned = pin && pin.dataset.pin !== state.pinned ? (pin.dataset.pin ?? null) : null;
    if (state.pinned) pin?.classList.add("sel");
    inspect(state.pinned || pin?.dataset.pin);
  });

  inspect(null);
  render();
}

start();

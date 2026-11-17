// Copyright 2026, Niklas Hauser
// SPDX-License-Identifier: MPL-2.0
// @ts-check
// The peripheral variant page: the groups of a mode, the variant tabs, the register map and its
// details, with the selection in the URL hash.

import "../shared/site.js";
import {$, el, loadJSON, modes, num, plural, regex, select} from "../shared/util.js";
import {parseHash, sortGroups, usedBy} from "./model.js";
import {renderDetails, renderLegend, renderVariant} from "./variant-view.js";
import {renderMap} from "./map-view.js";

/** @typedef {import("./model.js").Index} Index */
/** @typedef {import("./model.js").ModeIndex} ModeIndex */
/** @typedef {import("./model.js").Group} Group */
/** @typedef {import("./model.js").Target} Target */

const state = {
  /** @type {Index | null} */ all: null,
  /** @type {ModeIndex | null} */ index: null,
  mode: "binary",
  /** @type {string | null} */ group: null,
  /** @type {Group | null} */ data: null,
  variant: 0,
  /** @type {number | null} */ feature: null,
  /** @type {Target | null} */ selected: null,
  device: "",
  filter: "",
  map: "",
};
// Keep the zoom everywhere, so that the shapes of peripherals and variants can be compared.
// Another peripheral starts at its first register, a variant of the same one where it was.
const view = {/** @type {string | null} */ group: null, k: 0, ox: 0, oy: 0, meta: 0};
/** @type {import("./map-view.js").MapControl | null} */
let regmap = null;

const device = () => regex(state.device) || null;
const setHash = () => history.replaceState(null, "", `#${state.mode}/${state.group}/${state.variant}`);

function renderGroups() {
  const list = $("groups");
  list.textContent = "";
  const pattern = regex(state.filter);
  $("filter").classList.toggle("bad", pattern === undefined);
  const groups = (state.index?.groups ?? []).filter((g) => !pattern || pattern.test(g.name));
  if (!groups.length) {
    list.append(el("p", "empty", "No peripheral group matches."));
    return;
  }
  for (const group of groups) {
    const row = el("button", "row-button");
    row.setAttribute("type", "button");
    row.setAttribute("aria-current", String(group.name === state.group));
    const count = el("span", "count", String(group.variants.length));
    count.title = `${group.variants.length} variants of ${group.shapes} distinct register maps`;
    row.append(count, el("span", "name", group.name), el("span", "extra", num(group.instances)));
    row.addEventListener("click", () => selectGroup(group.name));
    list.append(row);
  }
}

/** @param {string} name @param {number} [variant] */
async function selectGroup(name, variant = 0) {
  if (name !== state.group) view.meta = 0;
  state.group = name;
  state.variant = variant;
  state.feature = null;
  state.map = "";
  renderGroups();
  $("g-name").textContent = name;
  $("g-sub").textContent = "Loading…";
  $("tabs").textContent = "";
  $("detail").textContent = "";
  try {
    state.data = await loadJSON(`${state.mode}/${encodeURIComponent(name)}.json`);
  } catch (error) {
    $("g-sub").textContent = /** @type {Error} */ (error).message;
    return;
  }
  setHash();
  renderGroup();
}

function renderGroup() {
  const data = /** @type {Group} */ (state.data);
  const maps = data.variants.reduce((sum, v) => sum + v.members.length, 0);
  $("g-name").textContent = data.name;
  $("g-sub").textContent =
    `${num(data.instances)} instances on ${num(data.devices.length)} devices, ` +
    `${num(maps)} distinct register maps, ${plural(data.variants.length, "variant")}` +
    (data.ignored && data.ignored.length ? ` · not compared: ${data.ignored.join(", ")}` : "");

  const pattern = device();
  const tabs = $("tabs");
  tabs.textContent = "";
  data.variants.forEach((variant, index) => {
    const tab = el("button", "variant-tab");
    tab.setAttribute("type", "button");
    tab.setAttribute("aria-current", String(index === state.variant));
    if (pattern && usedBy(data, variant, pattern)) tab.classList.add("match");
    tab.append(
      el("b", "", `variant ${index}`),
      el("span", "", `${num(variant.instances)} inst · ${variant.devices.length} dev · ${variant.members.length} maps`),
    );
    tab.addEventListener("click", () => {
      state.variant = index;
      state.feature = null;
      setHash();
      renderGroup();
    });
    tabs.append(tab);
  });
  renderVariantBody();
}

function renderVariantBody() {
  const data = /** @type {Group} */ (state.data);
  const body = $("detail");
  const previous = body.querySelector(".variant");
  if (previous) view.meta = previous.scrollTop;
  regmap?.destroy();
  regmap = null;
  body.textContent = "";
  if (!data.variants[state.variant]) return;

  state.selected = null;
  const meta = renderVariant(data, state.variant, {feature: state.feature, device: device(), onFeature: setFeature});
  const input = /** @type {HTMLInputElement} */ (el("input"));
  input.type = "search";
  input.value = state.map;
  input.placeholder = "filter registers and bit fields, e.g. ^CCMR";
  input.setAttribute("aria-label", "Filter the register map by regular expression");
  input.autocomplete = "off";
  input.spellcheck = false;
  input.addEventListener("input", () => {
    state.map = input.value;
    const pattern = regex(state.map);
    input.classList.toggle("bad", pattern === undefined);
    regmap?.setFilter(pattern || null);
  });
  meta.append(input);

  const stage = el("div", "stage");
  const holder = el("div");
  const inspect = el("div", "inspect");
  inspect.id = "inspect";
  stage.append(holder, inspect);
  body.append(meta, stage);
  meta.scrollTop = view.meta;

  regmap = renderMap(holder, data.variants[state.variant], {
    feature: state.feature,
    filter: regex(state.map) || null,
    view: view.k ? {k: view.k, ox: view.ox, oy: view.group === state.group ? view.oy : 10} : undefined,
    onSelect: (target) => {
      state.selected = target;
      renderInspector();
    },
    onView: ({k, ox, oy}) => Object.assign(view, {group: state.group, k, ox, oy}),
  });
  renderInspector();
}

function renderInspector() {
  $("inspect").replaceChildren(
    renderDetails(/** @type {Group} */ (state.data), state.variant, state.selected, {device: device()}));
}

/** @param {number | null} index */
function setFeature(index) {
  const data = /** @type {Group} */ (state.data);
  state.feature = index;
  regmap?.setFeature(index);
  regmap?.select(index === null ? null : {kind: "feature", index});
  $("detail").querySelector(".legend")?.replaceWith(
    renderLegend(data.variants[state.variant], {feature: index, onFeature: setFeature}));
}

/** @param {string} mode */
function setMode(mode) {
  const all = /** @type {Index} */ (state.all);
  state.mode = mode;
  state.index = all.modes[mode];
  sortGroups(state.index.groups);
  select($("modes"), "mode", mode);
  $("t-instances").textContent = num(state.index.instances);
  $("t-shapes").textContent = num(state.index.shapes);
  $("t-variants").textContent = num(state.index.variants);
  renderGroups();
}

async function start() {
  try {
    state.all = await loadJSON("variants.json");
  } catch (error) {
    $("g-name").textContent = "Could not load variants.json";
    $("g-sub").textContent = /** @type {Error} */ (error).message;
    return;
  }
  const all = /** @type {Index} */ (state.all);

  $("filter").addEventListener("input", (event) => {
    state.filter = /** @type {HTMLInputElement} */ (event.target).value;
    renderGroups();
  });
  $("device").addEventListener("input", (event) => {
    state.device = /** @type {HTMLInputElement} */ (event.target).value;
    if (state.data) renderGroup();
  });
  modes($("modes"), "mode", (mode) => {
    if (mode === state.mode) return;
    setMode(mode);
    if (state.group) selectGroup(state.group);
  });

  const hash = parseHash(location.hash);
  setMode(all.modes[hash.mode] ? hash.mode : "binary");
  const groups = /** @type {ModeIndex} */ (state.index).groups;
  const known = groups.find((g) => g.name === hash.group);
  selectGroup(known ? known.name : groups[0].name, known ? hash.variant : 0);
}

start();

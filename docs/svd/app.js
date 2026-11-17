// Copyright 2026, Niklas Hauser
// SPDX-License-Identifier: MPL-2.0
// @ts-check
// The SVD register page: the menu of SVD files next to the page (svd-files.json), opening files by
// button or drag and drop, the file in the URL hash, the table and map tabs and the filter.

import "../shared/site.js";
import {$, debounce, esc, highlight, plural, regex} from "../shared/util.js";
import {filterDevice, parseSvd} from "./parse.js";
import {renderTable} from "./table-view.js";
import {renderDetails, renderMap} from "./map-view.js";

/** @typedef {import("./parse.js").Device} Device */
/** @typedef {import("./parse.js").Node} Node */
/** @typedef {import("./parse.js").Filter} Filter */

const ROW_LIMIT = 5000;
const VIEW_KEY = "svd-explorer:view";
const MANIFEST = "svd-files.json";
const EXAMPLE = "example";
/** @type {Device} */
const NO_DEVICE = {name: "", peripherals: [], nodes: [], stats: {peripheral: 0, cluster: 0, register: 0, field: 0, enum: 0}};

const query = /** @type {HTMLInputElement} */ ($("query"));
const menuQuery = /** @type {HTMLInputElement} */ ($("menu-query"));
const desc = /** @type {HTMLInputElement} */ ($("scope-desc"));
const cased = /** @type {HTMLInputElement} */ ($("match-case"));
const fileInput = /** @type {HTMLInputElement} */ ($("file-input"));
const tableWrap = $("table-wrap");
const message = $("message");
const card = $("map-card");

const state = {
  /** @type {Device | null} */ device: null,
  /** @type {Set<number>} open nodes without filter */ expanded: new Set(),
  /** @type {Map<number, boolean>} open state chosen by the user while filtering */ toggles: new Map(),
  /** @type {Filter | null} */ filter: null,
  view: "table",
  /** @type {{file: string, name: string, group: string}[]} */ files: [],
  menuNote: "<p>Looking for SVD files next to this page…</p>",
  /** @type {string | null} file shown, EXAMPLE, or null for opened files */ current: null,
  loading: 0,
};

const map = renderMap($("map-frame"), null, {
  visible: false,
  onSelect(node) {
    renderCard(node);
    renderCrumbs(node);
  },
});
map.canvas.setAttribute("aria-describedby", "map-hint");

/* ------------------------------------------------------------------- Filter */
function setStatus(/** @type {string} */ html, error = false) {
  const status = $("status");
  status.innerHTML = html;
  status.classList.toggle("error", error);
}

function markInvalid(/** @type {HTMLElement} */ box, /** @type {HTMLInputElement} */ input, /** @type {boolean} */ bad) {
  box.classList.toggle("invalid", bad);
  if (bad) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}

function applyQuery() {
  const text = query.value;
  $("flags").textContent = `/${cased.checked ? "" : "i"}`;
  state.toggles = new Map();
  if (!text) {
    state.filter = null;
    markInvalid($("search"), query, false);
    render();
    map.setFilter(null);
    return;
  }
  let filter = null;
  try {
    if (state.device) filter = filterDevice(state.device, text, {cased: cased.checked, desc: desc.checked});
    else new RegExp(text);
  } catch (error) {
    markInvalid($("search"), query, true);
    setStatus(`${esc(/** @type {Error} */ (error).message)}. Escape special characters like <code>\\.</code> or <code>\\[</code>.`, true);
    return;
  }
  markInvalid($("search"), query, false);
  state.filter = filter;
  render();
  map.setFilter(filter);
}

/* -------------------------------------------------------------------- Table */
function isOpen(/** @type {Node} */ node, /** @type {boolean} */ unfiltered) {
  const {filter, expanded, toggles} = state;
  if (!filter) return expanded.has(node.id);
  const toggled = toggles.get(node.id);
  if (toggled !== undefined) return toggled;
  return !unfiltered && filter.ancestors.has(node.id);
}

function render() {
  const {device, filter} = state;
  const table = renderTable(device ?? NO_DEVICE, {filter, isOpen, limit: ROW_LIMIT});
  tableWrap.replaceChildren(table);
  if (!device) return;
  const total = Number(table.dataset.total);
  const more = $("more");
  more.hidden = total <= ROW_LIMIT;
  more.textContent = `Showing the first ${ROW_LIMIT.toLocaleString()} of ${total.toLocaleString()} rows. ` +
    `Collapse some peripherals or narrow the filter to see the rest.`;

  if (filter) {
    const peripherals = device.peripherals.filter((p) => filter.keep.has(p.id)).length;
    setStatus(`${plural(filter.matched.size, "match", "matches")} across ${plural(peripherals, "peripheral")}`);
  } else {
    setStatus(`Filter by name or by dotted path, for example <code>USART1\\.CR1\\.</code> or <code>^CC\\dIF$</code>`);
  }
}

function revealInTable(/** @type {Node} */ node) {
  if (state.filter && !state.filter.keep.has(node.id)) {
    query.value = "";
    applyQuery();
  }
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (state.filter) state.toggles.set(parent.id, true);
    else state.expanded.add(parent.id);
  }
  switchView("table");
  render();
  const row = tableWrap.querySelector(`tr[data-id="${node.id}"]`);
  if (!row) return;
  row.scrollIntoView({block: "center"});
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 1700);
  /** @type {HTMLElement | null} */ (row.querySelector(".tw, .locate"))?.focus({preventScroll: true});
}

/* ---------------------------------------------------------------------- Map */
function renderCard(/** @type {Node | null} */ node) {
  card.hidden = !node;
  if (node) card.replaceChildren(renderDetails(node, map.layout));
}

function renderCrumbs(/** @type {Node | null} */ selected) {
  const crumbs = $("crumbs");
  if (!state.device) {
    crumbs.innerHTML = "";
    return;
  }
  const chain = [];
  for (let node = selected; node; node = node.parent) chain.unshift(node);
  crumbs.innerHTML = `<button class="crumb" type="button" data-crumb="device" aria-current="${!chain.length}">${esc(state.device.name)}</button>` +
    chain.map((node) => `<span class="crumb-sep" aria-hidden="true">/</span>` +
      `<button class="crumb" type="button" data-crumb="${node.id}" aria-current="${node === selected}">${esc(node.name)}</button>`).join("");
}

function showOnMap(/** @type {Node} */ node) {
  switchView("map");
  map.select(node);
  map.zoomTo(map.selected, false);
}

function switchView(/** @type {string} */ view, focus = false) {
  const isMap = view === "map";
  state.view = isMap ? "map" : "table";
  const tabTable = $("tab-table"), tabMap = $("tab-map");
  tabTable.setAttribute("aria-selected", String(!isMap));
  tabMap.setAttribute("aria-selected", String(isMap));
  tabTable.tabIndex = isMap ? -1 : 0;
  tabMap.tabIndex = isMap ? 0 : -1;
  $("panel-table").hidden = isMap;
  $("panel-map").hidden = !isMap;
  $("table-actions").hidden = isMap;
  try {
    localStorage.setItem(VIEW_KEY, state.view);
  } catch { /* storage unavailable */ }
  map.setVisible(isMap);
  if (focus) (isMap ? tabMap : tabTable).focus();
}

/* ------------------------------------------------------------------ Loading */
function formatBytes(/** @type {number} */ bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function updateFileLine(/** @type {Device} */ device, /** @type {string} */ fileName, /** @type {number | null} */ size, /** @type {boolean} */ example) {
  const s = device.stats;
  const parts = [
    `<span class="dev">${esc(device.name)}</span>`,
    `<span>${esc(fileName)}${size != null ? ` · ${formatBytes(size)}` : ""}</span>`,
    `<span>${plural(s.peripheral, "peripheral")} · ${plural(s.register, "register")} · ${plural(s.field, "field")}</span>`,
  ];
  $("file-line").innerHTML = parts.join(`<span class="sep" aria-hidden="true">/</span>`) +
    (example ? `<span class="tag">Example file</span>` : "");
}

function showError(/** @type {string} */ text) {
  message.textContent = text;
  message.hidden = false;
}

function load(/** @type {string} */ text, /** @type {string} */ fileName, /** @type {number | null} */ size, example = false) {
  let device;
  try {
    device = parseSvd(text);
  } catch (error) {
    showError(`Could not open ${fileName}: ${/** @type {Error} */ (error).message}.`);
    return false;
  }
  message.hidden = true;
  state.device = device;
  state.expanded = new Set();
  updateFileLine(device, fileName, size, example);
  map.setDevice(device);
  return true;
}

async function loadFile(/** @type {File} */ file) {
  try {
    const text = await file.text();
    if (load(text, file.name, file.size)) {
      state.current = null;
      history.replaceState(null, "", location.pathname + location.search);
      renderMenu();
      applyQuery();
      tableWrap.scrollTop = 0;
    }
  } catch (error) {
    showError(`Could not read ${file.name}: ${/** @type {Error} */ (error).message}.`);
  }
}

function loadExample() {
  const example = ($("example-svd").textContent ?? "").trim();
  if (!load(example, "example.svd", new Blob([example]).size, true)) return false;
  const usart = state.device?.peripherals.find((p) => p.name === "USART1");
  const cr1 = usart?.children.find((r) => r.name === "CR1");
  const ps = cr1?.children.find((f) => f.name === "PS");
  for (const node of [usart, cr1, ps]) if (node) state.expanded.add(node.id);
  return true;
}

async function openFile(/** @type {string} */ file) {
  const token = ++state.loading;
  const name = file === EXAMPLE ? "example.svd" : decodeURIComponent(file.split(/[?#]/)[0].split("/").pop() ?? "");
  let ok = false;
  if (file === EXAMPLE) {
    ok = loadExample();
  } else {
    setStatus(`Loading <code>${esc(name)}</code>…`);
    try {
      const response = await fetch(file);
      if (!response.ok) throw new Error(`the server answered ${response.status} ${response.statusText}`.trim());
      const text = await response.text();
      if (token !== state.loading) return false;
      ok = load(text, name, Number(response.headers.get("content-length")) || new Blob([text]).size);
    } catch (error) {
      if (token !== state.loading) return false;
      showError(`Could not load ${name}: ${/** @type {Error} */ (error).message}.`);
    }
  }
  if (ok) {
    state.current = file;
    applyQuery();
    tableWrap.scrollTop = 0;
  } else {
    render();
  }
  renderMenu();
  return ok;
}

/* ---------------------------------------------------------------- File menu */
const displayName = (/** @type {string} */ file) =>
  decodeURIComponent(file.split(/[?#]/)[0].split("/").pop() ?? "").replace(/^header_/, "").replace(/\.svd$/i, "");
const groupName = (/** @type {string} */ name) => (/^stm32/i.test(name) ? name.slice(0, 7).toUpperCase() : "Other");
const fileFromHash = () => (location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : EXAMPLE);

async function discoverFiles() {
  const found = [];
  // A list of file names, e.g. ["header_stm32f407xx.svd"], works on any static host
  try {
    const response = await fetch(MANIFEST, {cache: "no-cache"});
    if (response.ok) {
      for (const item of await response.json()) {
        const file = typeof item === "string" ? item : item?.file;
        if (file) found.push(file);
      }
    }
  } catch { /* no list */ }
  // Otherwise the directory listing of a local server, e.g. python3 -m http.server
  if (!found.length) {
    try {
      const response = await fetch("./", {cache: "no-cache"});
      if (response.ok && (response.headers.get("content-type") || "").includes("html")) {
        const doc = new DOMParser().parseFromString(await response.text(), "text/html");
        for (const link of doc.querySelectorAll("a[href]")) {
          const href = link.getAttribute("href") ?? "";
          if (/\.svd$/i.test(href.split(/[?#]/)[0])) found.push(href);
        }
      }
    } catch { /* no listing */ }
  }

  state.files = [...new Set(found)]
    .map((file) => ({file, name: displayName(file)}))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => ({...entry, group: groupName(entry.name)}));

  const manifestCommand = `python3 -c "import glob, json; json.dump(sorted(glob.glob('*.svd')), open('${MANIFEST}', 'w'))"`;
  if (state.files.length) {
    state.menuNote = "";
  } else if (location.protocol === "file:") {
    state.menuNote = `<p>The browser cannot list the files next to a page opened from disk.</p>` +
      `<p>Run <code>python3 -m http.server</code> in this folder and open <code>http://localhost:8000</code>.</p>`;
  } else {
    state.menuNote = `<p>No SVD files found next to this page.</p>` +
      `<p>Put the SVD files into this folder and list them in <code>${MANIFEST}</code>:</p>` +
      `<p><code>${esc(manifestCommand)}</code></p>`;
  }
  renderMenu();
}

function renderMenu() {
  const text = menuQuery.value;
  const re = regex(text);
  if (re === undefined) {
    markInvalid($("menu-search"), menuQuery, true);
    return;
  }
  markInvalid($("menu-search"), menuQuery, false);

  const mark = (/** @type {string} */ name) => highlight(name, re);
  const item = (/** @type {string} */ file, /** @type {string} */ label) =>
    `<li><button class="menu-item" type="button" data-file="${esc(file)}" aria-current="${file === state.current}">${label}</button></li>`;

  const {files} = state;
  const visible = files.filter((f) => !re || re.test(f.name));
  let html = "";
  if (!re || re.test("example")) html += `<li class="menu-group">BUILT-IN</li>` + item(EXAMPLE, mark("example"));
  let group = null;
  for (const f of visible) {
    if (f.group !== group) {
      group = f.group;
      html += `<li class="menu-group">${esc(group)}</li>`;
    }
    html += item(f.file, mark(f.name));
  }
  if (state.menuNote) html += `<li class="menu-note">${state.menuNote}</li>`;
  else if (!visible.length && text) html += `<li class="menu-note"><p>No file name matches this expression.</p></li>`;
  $("menu-list").innerHTML = html;
  $("menu-count").textContent = files.length ? (text ? `${visible.length} of ${files.length}` : `${files.length} files`) : "";
}

function navigate(/** @type {string} */ file) {
  const target = file === EXAMPLE ? location.pathname + location.search : `#${encodeURIComponent(file)}`;
  if (fileFromHash() !== file) history.pushState(null, "", target);
  openFile(file);
}

/* ------------------------------------------------------------------- Events */
const target = (/** @type {Event} */ event) => /** @type {HTMLElement} */ (event.target);

$("menu-list").addEventListener("click", (e) => {
  const button = /** @type {HTMLElement | null} */ (target(e).closest(".menu-item"));
  if (button?.dataset.file) navigate(button.dataset.file);
});
menuQuery.addEventListener("input", debounce(renderMenu, 80));
menuQuery.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const first = /** @type {HTMLElement | null} */ ($("menu-list").querySelector(".menu-item"));
    if (first?.dataset.file) navigate(first.dataset.file);
  } else if (e.key === "Escape" && menuQuery.value) {
    menuQuery.value = "";
    renderMenu();
  }
});
window.addEventListener("popstate", () => {
  if (fileFromHash() !== state.current) openFile(fileFromHash());
});

$("tabs").addEventListener("click", (e) => {
  const tab = target(e).closest('[role="tab"]');
  if (tab) switchView(tab.id === "tab-map" ? "map" : "table");
});
$("tabs").addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    switchView(state.view === "map" ? "table" : "map", true);
  }
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) loadFile(file);
  fileInput.value = "";
});

query.addEventListener("input", debounce(applyQuery, 140));
query.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && query.value) {
    query.value = "";
    applyQuery();
  }
});
desc.addEventListener("change", applyQuery);
cased.addEventListener("change", applyQuery);

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
  if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    query.focus();
    query.select();
  }
});

tableWrap.addEventListener("click", (e) => {
  const row = /** @type {HTMLElement | null} */ (target(e).closest("tr[data-id]"));
  const device = state.device;
  if (!row || !device) return;
  const node = device.nodes[Number(row.dataset.id)];
  if (target(e).closest(".locate")) {
    showOnMap(node);
    return;
  }
  const onToggle = target(e).closest(".tw");
  const onName = target(e).closest("td.c-name");
  if (!onToggle && !(onName && window.getSelection()?.isCollapsed)) return;
  if (!node.children.length) return;
  const open = row.dataset.open !== "1";
  if (state.filter) state.toggles.set(node.id, open);
  else if (open) state.expanded.add(node.id);
  else state.expanded.delete(node.id);
  render();
  /** @type {HTMLElement | null} */ (tableWrap.querySelector(`tr[data-id="${node.id}"] .tw`))?.focus({preventScroll: true});
});

$("expand-all").addEventListener("click", () => {
  if (!state.device) return;
  for (const node of state.device.nodes) {
    if (!node.children.length) continue;
    if (state.filter) state.toggles.set(node.id, true);
    else state.expanded.add(node.id);
  }
  render();
});
$("collapse-all").addEventListener("click", () => {
  if (!state.device) return;
  if (state.filter) {
    for (const node of state.device.nodes) if (node.children.length) state.toggles.set(node.id, false);
  } else state.expanded.clear();
  render();
});

card.addEventListener("click", (e) => {
  const action = /** @type {HTMLElement | null} */ (target(e).closest("[data-action]"))?.dataset.action;
  const selected = map.selected;
  if (!action || !selected) return;
  if (action === "close") {
    map.select(null);
    map.canvas.focus();
  } else if (action === "zoom") map.zoomTo(selected);
  else if (action === "table") revealInTable(selected);
});
$("crumbs").addEventListener("click", (e) => {
  const crumb = /** @type {HTMLElement | null} */ (target(e).closest("[data-crumb]"));
  if (!crumb || !state.device) return;
  if (crumb.dataset.crumb === "device") {
    map.showAll();
  } else {
    const node = state.device.nodes[Number(crumb.dataset.crumb)];
    map.select(node);
    map.zoomTo(node);
  }
});
$("map-dense").addEventListener("change", (e) => map.setRows({dense: /** @type {HTMLInputElement} */ (target(e)).checked}));
$("map-row").addEventListener("change", (e) => map.setRows({rowBytes: Number(/** @type {HTMLSelectElement} */ (target(e)).value)}));
$("zoom-in").addEventListener("click", () => map.zoomBy(1.5));
$("zoom-out").addEventListener("click", () => map.zoomBy(1 / 1.5));
$("zoom-fit").addEventListener("click", () => map.fitWidth());

const hasFiles = (/** @type {DragEvent} */ e) => Array.from(e.dataTransfer?.types || []).includes("Files");
const drop = $("drop");
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  drop.hidden = false;
});
window.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  /** @type {DataTransfer} */ (e.dataTransfer).dropEffect = "copy";
});
window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) drop.hidden = true;
});
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  drop.hidden = true;
  const file = e.dataTransfer?.files[0];
  if (file) loadFile(file);
});

/* ------------------------------------- Start with the file in the URL or the example */
render();
renderMenu();
let savedView = "table";
try {
  savedView = localStorage.getItem(VIEW_KEY) || "table";
} catch { /* storage unavailable */ }
const initial = fileFromHash();
openFile(initial).then((ok) => {
  if (!ok && initial !== EXAMPLE) return openFile(EXAMPLE);
  return ok;
}).then(() => switchView(savedView));
discoverFiles();

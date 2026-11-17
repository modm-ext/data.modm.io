// Copyright 2026, Niklas Hauser
// SPDX-License-Identifier: MPL-2.0
// @ts-check
// The tree table of a device: peripherals, clusters, registers, bit fields and enumerated values
// with address, bits, access, reset and description, the filter matches marked. It only draws,
// the page handles the clicks on the toggles (.tw) and the map buttons (.locate) by data-id.
// Styles: ../shared/theme.css and table-view.css.

import {el, esc, hex, hexBits, highlight} from "../shared/util.js";
import {ACCESS, WRITES, bitRange, bitsValue, offsetText} from "./parse.js";

/** @typedef {import("./parse.js").Device} Device */
/** @typedef {import("./parse.js").Node} Node */
/** @typedef {import("./parse.js").Filter} Filter */

/** The access of a register or field, e.g. "rw w1c", as HTML. */
export function accessHtml(/** @type {Node} */ node) {
  const short = ACCESS[node.access ?? ""] || node.access || "";
  const extra = [node.readAction === "clear" ? "rc" : node.readAction, WRITES[node.writes ?? ""] || node.writes];
  const label = [short, ...extra].filter(Boolean).join(" ");
  if (!label) return "";
  const kind = short === "ro" ? "ro" : short === "wo" ? "wo" : "rw";
  const title = [node.access, node.readAction && `read: ${node.readAction}`, node.writes].filter(Boolean).join(", ");
  return `<span class="acc acc-${kind}" title="${esc(title)}">${esc(label)}</span>`;
}

function rowHtml(/** @type {Node} */ node, /** @type {number} */ depth, /** @type {boolean} */ open, /** @type {Filter | null} */ filter) {
  const hit = filter && filter.matched.has(node.id);
  const name = hit ? highlight(node.name, filter?.reG) : esc(node.name);
  const desc = hit && filter?.useDesc ? highlight(node.desc, filter?.reG) : esc(node.desc);
  const toggle = node.children.length
    ? `<button class="tw" type="button" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} ${esc(node.path)}"></button>`
    : `<span class="tw-gap"></span>`;
  const locate = node.type === "enum"
    ? `<span class="locate-gap"></span>`
    : `<button class="locate" type="button" data-locate="${node.id}" title="Show on map" aria-label="Show ${esc(node.path)} on the map"></button>`;
  let address = "", bits = "", access = "", reset = "", nameTags = "", descTags = "";
  const at = () => `${hexBits(node.address ?? 0, 32)}<span class="off">${offsetText(node.offset ?? 0)}</span>`;

  switch (node.type) {
    case "peripheral":
      address = hexBits(node.address ?? 0, 32);
      if (node.derivedFrom) descTags += `<span class="pill">derived from ${esc(node.derivedFrom)}</span>`;
      for (const irq of node.interrupts ?? []) descTags += `<span class="pill">IRQ ${esc(irq.value)} ${esc(irq.name)}</span>`;
      break;
    case "cluster":
      address = at();
      if (node.dim) nameTags += `<span class="pill">×${node.dim}</span>`;
      break;
    case "register":
      address = at();
      bits = String(node.size);
      access = accessHtml(node);
      reset = node.reset != null ? hexBits(node.reset, node.size ?? 32) : "";
      if (node.dim) nameTags += `<span class="pill">×${node.dim} +${hex(node.increment ?? 0)}</span>`;
      if (node.alternate) descTags += `<span class="pill">alternate of ${esc(node.alternate)}</span>`;
      if (node.derivedFrom) descTags += `<span class="pill">derived from ${esc(node.derivedFrom)}</span>`;
      break;
    case "field": {
      const size = node.registerSize || 32;
      const width = node.width ?? 1;
      const left = Math.max(0, ((size - 1 - (node.msb ?? 0)) / size) * 100);
      const share = Math.min(100, (width / size) * 100);
      bits = bitRange(node) +
        `<span class="bar" style="--l:${left.toFixed(3)}%;--w:${share.toFixed(3)}%" aria-hidden="true"></span>`;
      access = accessHtml(node);
      reset = node.reset != null ? bitsValue(node.reset, width) : "";
      break;
    }
    case "enum":
      bits = node.value != null ? bitsValue(node.value, node.width ?? 1) : esc(node.raw ?? "");
      if (node.isDefault) nameTags += `<span class="pill">default</span>`;
      if (node.usage && node.usage !== "read-write") descTags += `<span class="pill">${esc(node.usage)}</span>`;
      break;
  }

  const text = desc ? `<span class="text">${desc}</span>` : "";
  return `<tr class="lv-${node.type}" data-id="${node.id}" data-open="${open ? 1 : 0}">` +
    `<td class="c-name" style="--d:${depth}">${toggle}<span class="nm">${name}</span>${nameTags}</td>` +
    `<td class="num">${locate}${address}</td><td class="c-bits num">${bits}</td><td>${access}</td>` +
    `<td class="num">${reset}</td><td class="c-desc">${text}${descTags}</td></tr>`;
}

/**
 * The tree table of a device. A node shows its children when isOpen says so; with a filter only
 * the matching nodes and their ancestors are shown, and a matching node without matching
 * descendants shows all of its children when opened ("unfiltered").
 * @param {Device} device
 * @param {{filter?: Filter | null, isOpen?: (node: Node, unfiltered: boolean) => boolean, limit?: number}} [options]
 *   isOpen: by default the ancestors of the matches are open, limit: the most rows to draw
 * @returns {HTMLTableElement} with data-total, the number of rows without the limit
 */
export function renderTable(device, {filter = null, isOpen, limit = 5000} = {}) {
  const open = isOpen ?? ((node, unfiltered) => !!filter && !unfiltered && filter.ancestors.has(node.id));
  const rows = [];
  let total = 0;
  const walk = (/** @type {Node[]} */ list, /** @type {number} */ depth, /** @type {boolean} */ unfiltered) => {
    for (const node of list) {
      if (filter && !unfiltered && !filter.keep.has(node.id)) continue;
      const opened = node.children.length > 0 && open(node, unfiltered);
      total++;
      if (rows.length < limit) rows.push(rowHtml(node, depth, opened, filter));
      if (opened) walk(node.children, depth + 1, unfiltered || (!!filter && !filter.ancestors.has(node.id)));
    }
  };
  walk(device.peripherals, 0, false);

  const table = /** @type {HTMLTableElement} */ (el("table", "svd-table"));
  table.innerHTML = "<thead><tr>" +
    ["Name", "Address", "Bits", "Access", "Reset", "Description"].map((title) => `<th scope="col">${title}</th>`).join("") +
    "</tr></thead>";
  const body = el("tbody");
  if (filter && !filter.keep.size) {
    body.innerHTML = `<tr class="none"><td colspan="6">Nothing in ${esc(device.name)} matches ` +
      `<code class="num">/${esc(filter.query)}/${filter.flags}</code>. ` +
      `${filter.useDesc ? "" : "Turn on Descriptions to search the description text too."}</td></tr>`;
  } else {
    body.innerHTML = rows.join("");
  }
  table.append(body);
  table.dataset.total = String(total);
  return table;
}

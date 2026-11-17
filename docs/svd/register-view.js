// Copyright 2026, Niklas Hauser
// SPDX-License-Identifier: MPL-2.0
// @ts-check
// One register with its bit fields, drawn like in a reference manual, and optionally a value
// decoded into its fields. It only draws the register it gets, so the MCP server can show it too.
// Styles: ../shared/theme.css and register-view.css.

import {el, hexBits} from "../shared/util.js";
import {ACCESS, WRITES, bitRange, bitsValue, fieldValue} from "./parse.js";

/** @typedef {import("./parse.js").Node} Node */

const accessKind = (/** @type {Node} */ node) => {
  const short = ACCESS[node.access ?? ""];
  return short === "ro" ? "ro" : short === "wo" ? "wo" : "rw";
};

/** The enumerated value of a field value, or the default one. */
const meaning = (/** @type {Node} */ field, /** @type {number | null} */ value) =>
  field.children.find((v) => v.value != null && v.value === value) ?? field.children.find((v) => v.isDefault);

/**
 * A register as rows of bits, most significant first: the bit numbers, the fields with their
 * access in the colours of the map, unused bits hatched. With a value, every bit shows its state and
 * the field list shows the field values with the names of their enumerated values; otherwise it
 * shows the reset values.
 * @param {Node} register a register node of parseSvd()
 * @param {{value?: number | bigint | null, bitsPerRow?: number}} [options]
 * @returns {HTMLElement}
 */
export function renderRegister(register, {value = null, bitsPerRow = 16} = {}) {
  const size = register.size ?? 32;
  const perRow = Math.min(bitsPerRow, size);
  const fields = register.children.filter((f) => f.type === "field");
  const figure = el("figure", "register-view");

  const caption = el("figcaption");
  caption.append(el("b", "", register.path));
  const facts = [hexBits(register.address ?? 0, 32), `${size} bits`];
  if (register.reset != null) facts.push(`reset ${hexBits(register.reset, size)}`);
  if (value != null) facts.push(`value ${hexBits(BigInt(value), size)}`);
  caption.append(" ", el("span", "", facts.join(" · ")));
  figure.append(caption);

  for (let hi = size - 1; hi >= 0; hi -= perRow) {
    const lo = Math.max(0, hi - perRow + 1);
    const row = el("div", "reg-row");
    row.style.setProperty("--bits", String(hi - lo + 1));
    const column = (/** @type {number} */ bit) => hi - bit + 1;
    for (let bit = hi; bit >= lo; bit--) row.append(el("span", "bit-num", String(bit)));

    // Fields and the unused bits between them, a field across rows is drawn in each
    let free = hi;
    const gap = (/** @type {number} */ from, /** @type {number} */ to) => {
      if (from < to) return;
      const cell = el("span", "reg-cell reserved");
      cell.title = "reserved";
      cell.style.gridColumn = `${column(from)} / span ${from - to + 1}`;
      row.append(cell);
    };
    for (const field of fields) {
      const msb = Math.min(field.msb ?? 0, hi), lsb = Math.max(field.lsb ?? 0, lo);
      if (msb < lsb) continue;
      gap(free, msb + 1);
      free = lsb - 1;
      const cell = el("span", `reg-cell f-${accessKind(field)}`);
      cell.style.gridColumn = `${column(msb)} / span ${msb - lsb + 1}`;
      const name = el("b", "", field.name);
      // Names longer than the bits are wide run along them, like in the manuals
      if (field.name.length > (msb - lsb + 1) * 2) cell.classList.add("vertical");
      const access = [ACCESS[field.access ?? ""] || field.access, WRITES[field.writes ?? ""] || field.writes].filter(Boolean).join(" ");
      cell.append(name, el("small", "", access));
      cell.title = `${field.name} ${bitRange(field)}${field.desc ? `: ${field.desc}` : ""}`;
      row.append(cell);
    }
    gap(free, lo);

    if (value != null) {
      const bits = BigInt(value);
      for (let bit = hi; bit >= lo; bit--) {
        const set = (bits >> BigInt(bit)) & 1n;
        row.append(el("span", `bit-val${set ? " set" : ""}`, String(set)));
      }
    }
    figure.append(row);
  }

  if (fields.length) {
    const list = el("table", "reg-fields");
    const head = el("tr");
    for (const title of ["Bits", "Field", "Access", value != null ? "Value" : "Reset", ""]) head.append(el("th", "", title));
    list.append(head);
    for (const field of fields) {
      const width = field.width ?? 1;
      const shown = value != null ? fieldValue(BigInt(value), field.lsb ?? 0, width) : (field.reset ?? null);
      const enumerated = shown != null ? meaning(field, shown) : undefined;
      const line = el("tr");
      line.append(
        el("td", "num", bitRange(field)),
        el("td", "num", field.name),
        el("td", "num", ACCESS[field.access ?? ""] || field.access || ""),
        el("td", "num", shown != null ? bitsValue(shown, width) : ""),
        el("td", "", enumerated ? `${enumerated.name}${enumerated.desc ? `: ${enumerated.desc}` : ""}` : field.desc),
      );
      list.append(line);
    }
    figure.append(list);
  }
  return figure;
}

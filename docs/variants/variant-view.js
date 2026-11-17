// Copyright 2026, Niklas Hauser
// SPDX-License-Identifier: MPL-2.0
// @ts-check
// Views of a peripheral variant: its numbers, the feature legend, why it is a variant of its own,
// its devices, and the details of a register, bit field or feature of the register map.
// They take the variant data and return an element, nothing else, so other pages and the
// MCP server can show them too. Styles: ../shared/theme.css and variant-view.css.

import {el, num, plural, renderChips, renderFacts} from "../shared/util.js";
import {elements, hue, offset, range} from "./model.js";

/** @typedef {import("./model.js").Group} Group */
/** @typedef {import("./model.js").Variant} Variant */
/** @typedef {import("./model.js").Target} Target */

/**
 * A collapsible box with a title, a count and lines of text.
 * @param {string} title
 * @param {string} count
 * @param {string} note
 * @param {HTMLElement[]} content
 */
function renderBox(title, count, note, content, open = false) {
  const box = /** @type {HTMLDetailsElement} */ (el("details", "box"));
  box.open = open;
  const summary = el("summary", "", title);
  summary.append(el("em", "", count));
  const inner = el("div");
  inner.append(el("p", "note", note), ...content);
  box.append(summary, inner);
  return box;
}

/**
 * @param {string[]} lines
 * @param {number} limit
 * @param {string} [head]
 */
function renderLines(lines, limit, head) {
  const list = el("ul", "lines");
  if (head) {
    const item = el("li");
    item.append(el("b", "", head));
    list.append(item);
  }
  for (const line of lines.slice(0, limit)) list.append(el("li", "", line));
  if (lines.length > limit) list.append(el("li", "", `… and ${lines.length - limit} more`));
  return list;
}

/**
 * The legend of the feature colours, a click on a feature calls onFeature with its index, or with
 * null for the core and for the feature that is already selected.
 * @param {Variant} variant
 * @param {{feature?: number | null, onFeature?: (index: number | null) => void}} [options]
 */
export function renderLegend(variant, {feature = null, onFeature} = {}) {
  const wrap = el("div", "legend");
  const all = el("button", "feat core");
  all.setAttribute("type", "button");
  all.setAttribute("aria-pressed", String(feature === null));
  all.append(el("span", "swatch"), el("span", "num", "core"), el("span", "info", "in every instance"));
  all.addEventListener("click", () => onFeature?.(null));
  wrap.append(all);

  variant.features.forEach((entry, index) => {
    const button = el("button", "feat");
    button.setAttribute("type", "button");
    button.style.setProperty("--h", String(hue(index)));
    button.setAttribute("aria-pressed", String(feature === index));
    button.append(el("span", "swatch"), el("span", "num", `${index}`));
    if (entry.name) button.append(el("span", "name", entry.name));
    button.append(el("span", "info",
      `${entry.elements} el · ${entry.members.length}/${variant.members.length} maps · ${entry.devices.length} dev`));
    button.title =
      `${entry.name ? entry.name + "\n" : ""}` +
      `${entry.elements} elements in ${entry.registers} registers, ` +
      `implemented by ${entry.instances} instances on ${entry.devices.length} devices`;
    button.addEventListener("click", () => onFeature?.(feature === index ? null : index));
    wrap.append(button);
  });
  return wrap;
}

/**
 * A variant of a peripheral: its numbers, the feature legend, the conflicts with the other
 * variants, the merged renames and relocations, and the devices that implement it.
 * @param {Group} data
 * @param {number} index
 * @param {{feature?: number | null, device?: RegExp | null, onFeature?: (index: number | null) => void}} [options]
 *   feature: the selected feature, device: marks these devices, onFeature: a click into the legend
 */
export function renderVariant(data, index, {feature = null, device = null, onFeature} = {}) {
  const variant = data.variants[index];
  const wrap = el("div", "variant");
  const {core, total} = elements(variant);
  const cards = el("div", "cards");
  for (const [value, name] of [
    [num(variant.instances), "instances"],
    [num(variant.devices.length), "devices"],
    [num(variant.members.length), "register maps"],
    [num(variant.registers.length), "registers"],
    [`${num(core)}/${num(total)}`, "core elements"],
    [num(variant.features.length), "features"],
  ]) {
    const card = el("div", "card");
    card.append(el("b", "", value), el("span", "", name));
    cards.append(card);
  }
  wrap.append(cards, renderLegend(variant, {feature, onFeature}));

  const conflicts = Object.entries(variant.conflicts);
  if (conflicts.length) {
    const count = conflicts.reduce((sum, [, lines]) => sum + lines.length, 0);
    wrap.append(renderBox("Why this is a separate variant", `${count} conflicts`,
      "These names sit at a different address in the other variant, so no single driver can address both.",
      conflicts.map(([other, lines]) => renderLines(lines, 40, `vs variant ${other}`))));
  }
  if (variant.renames.length) {
    wrap.append(renderBox("Renamed, but the same silicon", `${variant.renames.length} aliases`,
      "Same address, different name: these were merged and every name is kept as an alias.",
      [renderLines(variant.renames, 200)]));
  }
  const relocated = variant.relocated || [];
  if (relocated.length) {
    wrap.append(renderBox("Moved, but the same bit field",
      plural(relocated.length, "relocation"),
      "Same name inside the same register, but at another bit position. A CMSIS header hides this " +
      "behind its _Pos and _Msk macros, so these were merged and the field is drawn at every position.",
      [renderLines(relocated, 200)]));
  }
  const devices = renderBox("Devices and instances", `${variant.devices.length} devices`,
    "Implemented by these devices:", [renderChips(variant.devices.map((d) => data.devices[d]), device)], true);
  // The instance names come first
  devices.lastElementChild?.prepend(renderChips(variant.names, device));
  wrap.append(devices);
  return wrap;
}

/**
 * The details of what is selected in the register map: a register, a bit field, a feature, or
 * an overview of the variant if nothing is.
 * @param {Group} data
 * @param {number} index the variant
 * @param {Target | null} target
 * @param {{device?: RegExp | null}} [options] device: marks these devices
 */
export function renderDetails(data, index, target, {device = null} = {}) {
  const variant = data.variants[index];
  const box = el("div", "variant-details");
  const chipsOf = (/** @type {number[]} */ devices) => renderChips(devices.map((d) => data.devices[d]), device);

  if (target && target.kind === "feature") {
    const feature = variant.features[target.index];
    const badge = el("span", "badge opt", "optional");
    badge.style.setProperty("--h", String(hue(target.index)));
    box.append(
      el("h3", "", feature.name || `Feature ${target.index}`),
      el("div", "sub", `feature ${target.index}`),
      badge,
      el("p", "",
        `${feature.elements} elements in ${feature.registers} registers that appear in exactly the same instances, ` +
        `so they are enabled and disabled together.`),
      renderFacts([
        ["register maps", `${feature.members.length} of ${variant.members.length}`],
        ["instances", num(feature.instances)],
        ["devices", num(feature.devices.length)],
      ]),
      el("hr"),
      el("p", "", "Implemented by:"),
      chipsOf(feature.devices),
    );
    return box;
  }

  if (!target) {
    box.append(
      el("h3", "", `${data.name} variant ${index}`),
      el("p", "", "Click a register or a bit field in the map to see what it is and which devices have it."),
      renderFacts([
        ["instances", num(variant.instances)],
        ["devices", num(variant.devices.length)],
        ["register maps", num(variant.members.length)],
        ["registers", num(variant.registers.length)],
        ["features", num(variant.features.length)],
      ]),
      el("hr"),
      el("p", "", "Instance names:"),
      renderChips(variant.names, device),
    );
    return box;
  }

  const register = target.row.register;
  const node = target.kind === "field" ? target.item.field : register;
  const feature = node.feature;
  box.append(el("h3", "", node.names[0] || "?"));
  box.append(el("div", "sub", target.kind === "field"
    ? `${register.names[0]} [${range(target.item.field.position, target.item.field.width)}]`
    : `${offset(register.offset)} · ${register.width * 8} bit`));
  const badge = el("span", `badge${feature < 0 ? "" : " opt"}`, feature < 0 ? "core" : `feature ${feature}`);
  if (feature >= 0) {
    badge.style.setProperty("--h", String(hue(feature)));
    badge.title = variant.features[feature].name || "";
  }
  box.append(badge);
  if (feature >= 0 && variant.features[feature].name) box.append(el("div", "sub", variant.features[feature].name || ""));
  if (node.description) box.append(el("p", "", node.description));

  /** @type {[string, string][]} */
  const facts = [];
  if (node.names.length > 1) facts.push(["also named", node.names.slice(1).join(", ")]);
  if (target.kind === "field") {
    const field = target.item.field;
    facts.push(["bits", range(field.position, field.width)]);
    facts.push(["width", `${field.width} bit`]);
    facts.push(["register", register.names.join(" = ")]);
    facts.push([register.offsets ? "offsets" : "offset", (register.offsets || [register.offset]).map(offset).join(", ")]);
    if (register.access && register.access.length) facts.push(["access", register.access.join(", ")]);
  } else {
    facts.push(register.offsets ? ["offsets", register.offsets.map(offset).join(", ")] : ["offset", offset(register.offset)]);
    facts.push(["size", `${register.width * 8} bit`]);
    if (register.access && register.access.length) facts.push(["access", register.access.join(", ")]);
    if (register.dim) facts.push(["array", `${register.dim} entries`]);
    facts.push(["fields", String(register.fields.length)]);
  }
  box.append(renderFacts(facts), el("hr"));

  const devices = feature < 0 ? variant.devices : variant.features[feature].devices;
  const maps = feature < 0 ? variant.members.length : variant.features[feature].members.length;
  box.append(
    el("p", "", feature < 0
      ? `Part of the core: present in all ${maps} register maps of this variant, on ${devices.length} devices.`
      : `Optional: present in ${maps} of ${variant.members.length} register maps, on ${devices.length} devices.`),
    chipsOf(devices),
  );
  return box;
}

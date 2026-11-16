// Copyright 2026, Niklas Hauser
// SPDX-License-Identifier: MPL-2.0
// @ts-check
// The peripheral variant data of variants.json and <mode>/<group>.json: the register maps of all
// instances of a peripheral merged into variants with a common core and optional features.
// No DOM access, so the MCP server and tests can use it too.

/**
 * @typedef {{position: number, width: number, names: string[], feature: number,
 *            description?: string, relocated?: boolean}} Field
 * @typedef {{offset: number, offsets?: number[], width: number, dim?: number, names: string[],
 *            feature: number, description?: string, access?: string[], fields: Field[]}} Register
 * @typedef {{name?: string, elements: number, registers: number, instances: number,
 *            members: number[], devices: number[]}} Feature
 * @typedef {{instances: number, devices: number[], names: string[], members: number[],
 *            features: Feature[], renames: string[], relocated?: string[],
 *            conflicts: Record<string, string[]>, registers: Register[]}} Variant
 * @typedef {{name: string, mode: string, ignored?: string[], instances: number, devices: string[],
 *            variants: Variant[]}} Group
 * @typedef {{name: string, ignored?: string[], instances: number, devices: number, shapes: number,
 *            variants: object[]}} GroupSummary
 * @typedef {{groups: GroupSummary[], instances: number, shapes: number, variants: number}} ModeIndex
 * @typedef {{modes: Record<string, ModeIndex>}} Index
 *
 * A register as a row of the map, its fields packed into lanes where alternates overlap.
 * @typedef {{field: Field, lane: number, start: number}} Item
 * @typedef {{register: Register, bits: number, y: number, height: number, items: Item[]}} Row
 * @typedef {{rows: Row[], rowCount: number}} Layout
 * @typedef {{kind: "feature", index: number} | {kind: "register", row: Row}
 *           | {kind: "field", row: Row, item: Item}} Target
 */

// Golden angle keeps neighbouring features far apart in hue
export const hue = (/** @type {number} */ index) => Math.round((index * 137.508 + 8) % 360);

/** A register offset like 0x01c. */
export const offset = (/** @type {number} */ value) => `0x${value.toString(16).padStart(3, "0")}`;

/** The bits of a field like 7:4, or 3 for a single bit. */
export const range = (/** @type {number} */ position, /** @type {number} */ width) =>
  width === 1 ? `${position}` : `${position + width - 1}:${position}`;

/** Groups with the most variants first. */
export const sortGroups = (/** @type {GroupSummary[]} */ groups) =>
  groups.sort((a, b) => b.variants.length - a.variants.length || a.name.localeCompare(b.name));

/** Whether a device that the pattern matches implements the variant. */
export const usedBy = (/** @type {Group} */ data, /** @type {Variant} */ variant, /** @type {RegExp} */ pattern) =>
  variant.devices.some((d) => pattern.test(data.devices[d]));

/**
 * The elements (registers and fields) of a variant and how many of them are in every instance.
 * @param {Variant} variant
 */
export function elements(variant) {
  const core = variant.registers.reduce(
    (sum, r) => sum + (r.feature < 0 ? 1 : 0) + r.fields.filter((f) => f.feature < 0).length, 0);
  const total = variant.registers.reduce((sum, r) => sum + 1 + r.fields.length, 0);
  return {core, total};
}

const ACCESS = /** @type {Record<string, string>} */ ({"read-only": "ro", "write-only": "wo", "read-write": "rw"});

/**
 * Almost every register is declared read-write, so only the exceptions are marked.
 * @param {Register} register
 */
export function accessTag(register) {
  const access = register.access || [];
  if (!access.length || (access.length === 1 && access[0] === "read-write")) return "";
  return access.map((a) => ACCESS[a] || a).join("/");
}

/**
 * The rows of the register map: one per register, alternates of the same register overlap,
 * so they are packed into extra lanes.
 * @param {Variant} variant
 * @returns {Layout}
 */
export function layout(variant) {
  const rows = [];
  let y = 0;
  for (const register of variant.registers) {
    const bits = register.width * 8;
    /** @type {[number, number][][]} */
    const lanes = [];
    const items = [];
    for (const field of [...register.fields].sort((a, b) => b.position - a.position || b.width - a.width)) {
      const start = bits - (field.position + field.width);
      let lane = lanes.findIndex((used) => used.every(([s, w]) => start >= s + w || start + field.width <= s));
      if (lane < 0) lane = lanes.push([]) - 1;
      lanes[lane].push([start, field.width]);
      items.push({field, lane, start});
    }
    const height = Math.max(1, lanes.length);
    rows.push({register, bits, y, height, items});
    y += height;
  }
  return {rows, rowCount: Math.max(y, 1)};
}

/** Whether the pattern matches a name of the register or of one of its fields. */
export const matches = (/** @type {RegExp} */ pattern, /** @type {Row} */ row) =>
  pattern.test(row.register.names.join(" ")) || row.items.some(({field}) => field.names.some((n) => pattern.test(n)));

/** The names of a register or field, aliases included. */
export const label = (/** @type {Target} */ target) =>
  target.kind === "register" ? target.row.register.names.join(" = ")
    : target.kind === "field" ? target.item.field.names.join(" = ") : `feature ${target.index}`;

/**
 * One line about a register or field: where it is and whether it is core or a feature.
 * @param {Target} target
 * @param {Variant} variant
 */
export function describe(target, variant) {
  if (target.kind === "register") {
    const r = target.row.register;
    const tag = accessTag(r);
    return `${(r.offsets || [r.offset]).map(offset).join("/")} · ${r.width * 8} bit · ${r.fields.length} fields` +
      (tag ? ` · ${tag}` : "");
  }
  if (target.kind === "feature") return variant.features[target.index].name || "";
  const f = target.item.field;
  const feature = f.feature < 0 ? "core"
    : `feature ${f.feature}${variant.features[f.feature].name ? ": " + variant.features[f.feature].name : ""}`;
  return `[${range(f.position, f.width)}] · ${feature}` + (f.relocated ? " · relocated" : "");
}

/**
 * The URL hash "#mode/group/variant", or the older "#group/variant".
 * @param {string} hash
 */
export function parseHash(hash) {
  const parts = decodeURIComponent(hash.replace(/^#/, "")).split("/");
  const [mode, group, variant] = parts.length > 2 ? parts : ["binary", ...parts];
  return {mode, group, variant: Number(variant) || 0};
}

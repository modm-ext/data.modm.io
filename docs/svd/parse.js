// Copyright 2026, Niklas Hauser
// SPDX-License-Identifier: MPL-2.0
// @ts-check
// A CMSIS-SVD file as a tree of peripherals, clusters, registers, bit fields and enumerated values,
// the regular expression filter over that tree and the number formats the views share.
// No DOM access except the XML document it reads, so the MCP server and tests can use it too.

import {hex, hexBits, plural} from "../shared/util.js";

/**
 * @typedef {"peripheral" | "cluster" | "register" | "field" | "enum"} NodeType
 * @typedef {{name: string | null, value: string | null}} Interrupt
 * @typedef {{id: number, type: NodeType, name: string, path: string, desc: string, children: Node[],
 *            parent: Node | null, address?: number, offset?: number, size?: number, access?: string | null,
 *            reset?: number | null, dim?: number, increment?: number, derivedFrom?: string | null,
 *            alternate?: string | null, blockSize?: number, interrupts?: Interrupt[], lsb?: number, msb?: number,
 *            width?: number, registerSize?: number, writes?: string | null, readAction?: string | null,
 *            raw?: string | null, value?: number | null, isDefault?: boolean, usage?: string | null}} Node
 *   Fields per type: peripheral (address, blockSize, derivedFrom, interrupts), cluster (address, offset, dim),
 *   register (address, offset, size, access, reset, dim, increment, derivedFrom, alternate),
 *   field (lsb, msb, width, registerSize, access, writes, readAction, reset), enum (raw, value, width, isDefault, usage)
 * @typedef {{name: string, peripherals: Node[], nodes: Node[], stats: Record<NodeType, number>}} Device
 *   nodes: all nodes by id
 * @typedef {{query: string, flags: string, re: RegExp, reG: RegExp, useDesc: boolean,
 *            matched: Set<number>, keep: Set<number>, ancestors: Set<number>}} Filter
 *   matched: ids of the nodes that match, ancestors: ids of nodes with matching descendants, keep: both
 */

// Arrays larger than this stay one node, e.g. a 256 word FIFO
const MAX_DIM = 64;

/** Short names of the access types. */
export const ACCESS = /** @type {Record<string, string>} */ ({
  "read-write": "rw", "read-only": "ro", "write-only": "wo", "writeOnce": "w1", "read-writeOnce": "rw1",
});
/** Short names of the modifiedWriteValues. */
export const WRITES = /** @type {Record<string, string>} */ ({
  oneToClear: "w1c", oneToSet: "w1s", oneToToggle: "w1t", zeroToClear: "w0c",
  zeroToSet: "w0s", zeroToToggle: "w0t", clear: "wc", set: "ws", modify: "wm",
});

/* ---------------------------------------------------------------- XML helpers */
const kids = (/** @type {Element | null | undefined} */ node, /** @type {string} */ tag) =>
  node ? Array.from(node.children).filter((c) => c.localName === tag) : [];
const kid = (/** @type {Element | null | undefined} */ node, /** @type {string} */ tag) =>
  node ? Array.from(node.children).find((c) => c.localName === tag) || null : null;
const txt = (/** @type {Element | null | undefined} */ node, /** @type {string} */ tag) => {
  const k = kid(node, tag);
  return k ? (k.textContent ?? "").trim() : null;
};
const clean = (/** @type {string | null} */ s) => (s ? s.replace(/\s+/g, " ").trim() : "");

/**
 * An SVD number: decimal, 0x hex, 0b or # binary (x as don't care), with an optional k, m or g suffix.
 * @param {string | null | undefined} value
 * @returns {number | null}
 */
export function parseNumber(value) {
  if (value == null) return null;
  let s = String(value).trim().toLowerCase();
  if (s.startsWith("#")) {
    s = s.slice(1).replace(/x/g, "0");
    return /^[01]+$/.test(s) ? parseInt(s, 2) : null;
  }
  if (/^0x[0-9a-f]+$/.test(s)) return parseInt(s, 16);
  if (/^0b[01]+$/.test(s)) return parseInt(s.slice(2), 2);
  const m = s.match(/^(\d+)([kmg])?$/);
  if (m) return parseInt(m[1], 10) * (/** @type {Record<string, number>} */ ({k: 1024, m: 1048576, g: 1073741824})[m[2]] || 1);
  return null;
}
const range = (/** @type {number} */ a, /** @type {number} */ b) => Array.from({length: b - a + 1}, (_, i) => String(a + i));

/**
 * Expands dim arrays and lists, e.g. CCR[%s] or MODE%s.
 * @param {Element} node
 * @param {string | null} name
 * @returns {{name: string, step: number, dim: number, increment?: number}[]}
 */
function expand(node, name) {
  const dim = parseNumber(txt(node, "dim"));
  if (!dim || !name || !name.includes("%s")) return [{name: name ?? "", step: 0, dim: 0}];
  const increment = parseNumber(txt(node, "dimIncrement")) || 0;
  const raw = txt(node, "dimIndex");
  let indices = null;
  if (raw) {
    const r = raw.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
    indices = r ? range(+r[1], +r[2]) : raw.split(",").map((s) => s.trim());
  }
  if (!indices || indices.length !== dim) indices = range(0, dim - 1);
  if (dim > MAX_DIM) {
    return [{name: name.replace("%s", `${indices[0]}…${indices[dim - 1]}`), step: 0, dim, increment}];
  }
  return indices.map((index, i) => ({name: name.replace("%s", index), step: i * increment, dim: 0}));
}

/** The bits of a register value that belong to a field. */
export function fieldValue(/** @type {number | bigint | null | undefined} */ value, /** @type {number} */ lsb, /** @type {number} */ width) {
  if (value == null) return null;
  return Number((BigInt(value) >> BigInt(lsb)) & ((1n << BigInt(width)) - 1n));
}

/* ----------------------------------------------------------------- SVD parser */
/**
 * Parses an SVD file, throws an Error with a readable reason if it is not one.
 * @param {string | Document} input the XML text, or a document parsed elsewhere
 * @returns {Device}
 */
export function parseSvd(input) {
  const doc = typeof input === "string" ? new DOMParser().parseFromString(input, "application/xml") : input;
  if (doc.getElementsByTagName("parsererror").length) throw new Error("the file is not well-formed XML");
  const device = doc.documentElement;
  if (!device || device.localName !== "device") {
    throw new Error("it has no <device> root element, so it is not a CMSIS-SVD file");
  }

  /** @type {Node[]} */
  const nodes = [];
  const stats = {peripheral: 0, cluster: 0, register: 0, field: 0, enum: 0};
  const make = (/** @type {NodeType} */ type, /** @type {Partial<Node>} */ props) => {
    const node = /** @type {Node} */ (Object.assign({id: nodes.length, type, children: [], parent: null}, props));
    nodes.push(node);
    stats[type]++;
    return node;
  };

  const deviceProps = {
    size: parseNumber(txt(device, "size")) ?? 32,
    access: txt(device, "access"),
    reset: parseNumber(txt(device, "resetValue")),
  };
  const peripheralEls = kids(kid(device, "peripherals"), "peripheral");
  const byName = new Map(peripheralEls.map((p) => [txt(p, "name"), p]));

  // Child element of a peripheral, falling back to the peripheral it is derived from
  /** @returns {Element | null} */
  const inherited = (/** @type {Element} */ p, /** @type {string} */ tag, seen = new Set()) => {
    const own = kid(p, tag);
    if (own || seen.has(p)) return own;
    seen.add(p);
    const base = byName.get(p.getAttribute("derivedFrom"));
    return base ? inherited(base, tag, seen) : null;
  };
  const inheritedText = (/** @type {Element} */ p, /** @type {string} */ tag) => {
    const k = inherited(p, tag);
    return k ? (k.textContent ?? "").trim() : null;
  };

  /** @typedef {{size: number, access: string | null, reset: number | null}} Props */

  function parseFields(/** @type {Element} */ fieldsEl, /** @type {Node} */ register) {
    const fields = [];
    for (const f of kids(fieldsEl, "field")) {
      let lsb = parseNumber(txt(f, "bitOffset"));
      let width = parseNumber(txt(f, "bitWidth"));
      if (lsb == null) {
        const l = parseNumber(txt(f, "lsb")), m = parseNumber(txt(f, "msb"));
        const r = (txt(f, "bitRange") || "").match(/\[\s*(\d+)\s*:\s*(\d+)\s*\]/);
        if (l != null && m != null) {
          lsb = l;
          width = m - l + 1;
        } else if (r) {
          lsb = +r[2];
          width = +r[1] - +r[2] + 1;
        }
      }
      const offset = lsb ?? 0;
      const bits = width ?? 1;
      const access = txt(f, "access") ?? register.access;
      const writes = txt(f, "modifiedWriteValues");
      const readAction = txt(f, "readAction");
      const desc = clean(txt(f, "description"));
      for (const {name, step} of expand(f, txt(f, "name"))) {
        const position = offset + step;
        const field = make("field", {
          name, path: `${register.path}.${name}`, lsb: position, msb: position + bits - 1, width: bits,
          registerSize: register.size, access, writes, readAction, desc,
          reset: fieldValue(register.reset, position, bits),
        });
        for (const values of kids(f, "enumeratedValues")) {
          for (const v of kids(values, "enumeratedValue")) {
            const isDefault = txt(v, "isDefault") === "true";
            const vname = txt(v, "name") || (isDefault ? "default" : "?");
            field.children.push(make("enum", {
              name: vname, path: `${field.path}.${vname}`, raw: txt(v, "value"), value: parseNumber(txt(v, "value")),
              isDefault, width: bits, usage: txt(values, "usage"), desc: clean(txt(v, "description")),
            }));
          }
        }
        fields.push(field);
      }
    }
    // Most significant bit first, as in reference manuals
    return fields.sort((a, b) => /** @type {number} */ (b.msb) - /** @type {number} */ (a.msb) || /** @type {number} */ (b.lsb) - /** @type {number} */ (a.lsb));
  }

  /** @returns {Node[]} */
  function parseBlock(/** @type {Element} */ container, /** @type {Node} */ parent, /** @type {number} */ base, /** @type {Props} */ props) {
    const children = [];
    const siblings = new Map(kids(container, "register").map((r) => [txt(r, "name"), r]));
    for (const child of Array.from(container.children)) {
      if (child.localName === "register") children.push(...parseRegister(child, parent, base, props, siblings));
      else if (child.localName === "cluster") children.push(...parseCluster(child, parent, base, props));
    }
    return children.sort((a, b) => /** @type {number} */ (a.offset) - /** @type {number} */ (b.offset));
  }

  function parseRegister(
    /** @type {Element} */ node, /** @type {Node} */ parent, /** @type {number} */ base,
    /** @type {Props} */ props, /** @type {Map<string | null, Element>} */ siblings,
  ) {
    const derivedFrom = node.getAttribute("derivedFrom");
    const source = derivedFrom ? siblings.get(derivedFrom) : null;
    const get = (/** @type {string} */ tag) => txt(node, tag) ?? (source ? txt(source, tag) : null);
    const offset = parseNumber(get("addressOffset")) ?? 0;
    const size = parseNumber(get("size")) ?? props.size ?? 32;
    const access = get("access") ?? props.access;
    const resetText = get("resetValue");
    const reset = resetText != null ? parseNumber(resetText) : props.reset;
    const desc = clean(get("description"));
    const fieldsEl = kid(node, "fields") || (source ? kid(source, "fields") : null);
    return expand(node, get("name")).map(({name, step, dim, increment}) => {
      const register = make("register", {
        name, path: `${parent.path}.${name}`, address: base + offset + step, offset: offset + step,
        size, access, reset, desc, derivedFrom, alternate: get("alternateRegister"), dim, increment,
      });
      if (fieldsEl) register.children = parseFields(fieldsEl, register);
      return register;
    });
  }

  function parseCluster(/** @type {Element} */ node, /** @type {Node} */ parent, /** @type {number} */ base, /** @type {Props} */ props) {
    const offset = parseNumber(txt(node, "addressOffset")) ?? 0;
    const resetText = txt(node, "resetValue");
    const clusterProps = {
      size: parseNumber(txt(node, "size")) ?? props.size,
      access: txt(node, "access") ?? props.access,
      reset: resetText != null ? parseNumber(resetText) : props.reset,
    };
    return expand(node, txt(node, "name")).map(({name, step, dim}) => {
      const cluster = make("cluster", {
        name, path: `${parent.path}.${name}`, address: base + offset + step, offset: offset + step,
        desc: clean(txt(node, "description")), dim,
      });
      cluster.children = parseBlock(node, cluster, base + offset + step, clusterProps);
      return cluster;
    });
  }

  const peripherals = [];
  for (const p of peripheralEls) {
    const name = txt(p, "name") ?? "";
    const address = parseNumber(inheritedText(p, "baseAddress")) ?? 0;
    const resetText = inheritedText(p, "resetValue");
    const props = {
      size: parseNumber(inheritedText(p, "size")) ?? deviceProps.size,
      access: inheritedText(p, "access") ?? deviceProps.access,
      reset: resetText != null ? parseNumber(resetText) : deviceProps.reset,
    };
    // Registers address blocks of reasonable size, large memory blocks are not drawn
    const blocks = kids(p, "addressBlock").length ? kids(p, "addressBlock")
      : kids(byName.get(p.getAttribute("derivedFrom")), "addressBlock");
    let blockSize = 0;
    for (const block of blocks) {
      const usage = txt(block, "usage");
      const end = (parseNumber(txt(block, "offset")) ?? 0) + (parseNumber(txt(block, "size")) ?? 0);
      if ((!usage || usage === "registers") && end <= 0x10000) blockSize = Math.max(blockSize, end);
    }
    const peripheral = make("peripheral", {
      name, path: name, address, offset: 0, blockSize,
      desc: clean(inheritedText(p, "description")),
      derivedFrom: p.getAttribute("derivedFrom"),
      interrupts: kids(p, "interrupt").map((i) => ({name: txt(i, "name"), value: txt(i, "value")})),
    });
    const registers = inherited(p, "registers");
    if (registers) peripheral.children = parseBlock(registers, peripheral, address, props);
    peripherals.push(peripheral);
  }
  peripherals.sort((a, b) => /** @type {number} */ (a.address) - /** @type {number} */ (b.address) || a.name.localeCompare(b.name));
  const link = (/** @type {Node} */ node) => {
    for (const child of node.children) {
      child.parent = node;
      link(child);
    }
  };
  peripherals.forEach(link);

  return {name: txt(device, "name") || "Unnamed device", peripherals, nodes, stats};
}

/* --------------------------------------------------------------------- Filter */
/**
 * The nodes that a regular expression matches by name, by dotted path like USART1.CR1.UE, or by
 * description. Throws a SyntaxError for an invalid expression.
 * @param {Device} device
 * @param {string} query
 * @param {{cased?: boolean, desc?: boolean}} [options] cased: match case, desc: search the descriptions too
 * @returns {Filter}
 */
export function filterDevice(device, query, {cased = false, desc = false} = {}) {
  const flags = cased ? "" : "i";
  const re = new RegExp(query, flags);
  const reG = new RegExp(query, flags + "g");
  const matches = (/** @type {Node} */ node) => {
    if (re.test(node.name)) return true;
    if (node.path.length > node.name.length) {
      // Dotted paths like USART1.CR1.UE match when the match ends in the last segment, or right
      // before it, so that USART1\.CR1\. matches the fields of USART1.CR1
      const start = node.path.length - node.name.length;
      for (const m of node.path.matchAll(reG)) {
        if (m[0].length && /** @type {number} */ (m.index) + m[0].length >= start) return true;
      }
    }
    return desc && !!node.desc && re.test(node.desc);
  };
  const matched = new Set(), keep = new Set(), ancestors = new Set();
  const visit = (/** @type {Node} */ node) => {
    let childHit = false;
    for (const child of node.children) if (visit(child)) childHit = true;
    const hit = matches(node);
    if (hit) matched.add(node.id);
    if (childHit) ancestors.add(node.id);
    if (hit || childHit) keep.add(node.id);
    return hit || childHit;
  };
  device.peripherals.forEach(visit);
  return {query, flags, re, reG, useDesc: desc, matched, keep, ancestors};
}

/* ----------------------------------------------------------------- Formatting */
/** The offset of a register in its peripheral, e.g. +0x1C. */
export const offsetText = (/** @type {number} */ value) => "+" + hex(value, 2);
/** A field value: one bit as 0 or 1, up to four bits in binary, otherwise hexadecimal. */
export const bitsValue = (/** @type {number} */ value, /** @type {number} */ width) => {
  if (width === 1) return String(value);
  if (width <= 4) return "0b" + value.toString(2).padStart(width, "0");
  return hexBits(value, width);
};
/** The bits of a field, e.g. [7:4] or [3]. */
export const bitRange = (/** @type {Node} */ field) => (field.msb === field.lsb ? `[${field.lsb}]` : `[${field.msb}:${field.lsb}]`);
/** A size in bytes, KiB or MiB. */
export const sizeText = (/** @type {number} */ bytes) => {
  if (bytes >= 1048576 && bytes % 1048576 === 0) return `${bytes / 1048576} MiB`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return plural(bytes, "byte");
};
/** The number of descendants of a type, e.g. the registers of a peripheral. */
export const countOf = (/** @type {Node} */ node, /** @type {NodeType} */ type) =>
  node.children.reduce((/** @type {number} */ n, c) => n + (c.type === type ? 1 : 0) + countOf(c, type), 0);

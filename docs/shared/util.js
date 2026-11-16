// Copyright 2026, Niklas Hauser
// SPDX-License-Identifier: MPL-2.0
// @ts-check

/** The element with this id. */
export const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * A new element with class names and text.
 * @param {string} tag
 * @param {string} [cls]
 * @param {string} [text]
 */
export function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A new element with properties and children, e.g. h("option", {value: "F4"}) or
 * h("label", {className: "check"}, input, "Lock").
 * @param {string} tag
 * @param {Record<string, any>} [props] assigned to the element
 * @param {(Node | string)[]} children
 */
export function h(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** HTML escaped text, for views that build their markup as strings. */
export const esc = (/** @type {unknown} */ text) =>
  String(text ?? "").replace(/[&<>"]/g, (c) => /** @type {Record<string, string>} */ ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"})[c]);

/**
 * The text as HTML with the matches of the expression in <mark>, the rest escaped.
 * @param {string | null | undefined} text
 * @param {RegExp | null | undefined} re with or without the g flag
 */
export function highlight(text, re) {
  if (!re || !text) return esc(text);
  const all = re.global ? re : new RegExp(re.source, re.flags + "g");
  let out = "", last = 0;
  for (const m of text.matchAll(all)) {
    if (!m[0].length) continue;
    const index = /** @type {number} */ (m.index);
    out += esc(text.slice(last, index)) + "<mark>" + esc(m[0]) + "</mark>";
    last = index + m[0].length;
  }
  return out + esc(text.slice(last));
}

/**
 * Chips with names, the ones that the pattern matches are marked.
 * @param {string[]} names
 * @param {RegExp | null} [pattern] tested against the name, not the label
 * @param {(name: string) => string} [label] the text of a chip, the name by default
 */
export function renderChips(names, pattern = null, label = (name) => name) {
  const chips = el("div", "chips");
  for (const name of names) {
    const chip = el("span", "chip", label(name));
    if (pattern && pattern.test(name)) chip.classList.add("on");
    chips.append(chip);
  }
  return chips;
}

/**
 * Facts as a two column list (theme.css .facts), entries without a value are left out.
 * @param {[string, string | null | undefined][]} entries
 */
export function renderFacts(entries) {
  const list = el("dl", "facts");
  for (const [key, value] of entries) if (value) list.append(el("dt", "", key), el("dd", "", value));
  return list;
}

/**
 * The case insensitive regular expression of a search field: null for an empty pattern,
 * undefined for an invalid one (mark the field with the class "bad").
 * @param {string} pattern
 * @returns {RegExp | null | undefined}
 */
export function regex(pattern) {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return undefined;
  }
}

/**
 * Calls fn at most once per pause of ms milliseconds, e.g. while typing into a search field.
 * @template {(...args: any[]) => void} F
 * @param {F} fn
 * @param {number} [ms]
 */
export function debounce(fn, ms = 150) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  return (/** @type {Parameters<F>} */ ...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Fetches JSON, with a readable error for a missing file or a page opened without a server.
 * @param {string | URL} url
 */
export async function loadJSON(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`Could not load ${url}: serve the page over HTTP, the data sits next to it`, {cause: error});
  }
  if (!response.ok) throw new Error(`Could not load ${url}: ${response.status} ${response.statusText}`);
  return response.json();
}

/**
 * Makes the buttons of a .modes group exclusive: apply(button.dataset[attribute]) on a click.
 * @param {HTMLElement} container
 * @param {string} attribute
 * @param {(value: string) => void} apply
 */
export function modes(container, attribute, apply) {
  container.addEventListener("click", (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest("button");
    if (!button) return;
    select(container, attribute, button.dataset[attribute] ?? "");
    apply(button.dataset[attribute] ?? "");
  });
}

/**
 * Presses the button of a .modes group with this value.
 * @param {HTMLElement} container
 * @param {string} attribute
 * @param {string} value
 */
export function select(container, attribute, value) {
  for (const button of container.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String((button.dataset[attribute] ?? "") === value));
  }
}

/** Numbers with thin thousands separators. */
export const num = (/** @type {number} */ value) => value.toLocaleString("en-US");

/** A number in hexadecimal, e.g. hex(1024, 4) is 0x0400. */
export const hex = (/** @type {number | bigint} */ value, digits = 0) => "0x" + value.toString(16).toUpperCase().padStart(digits, "0");

/** A number in hexadecimal with the digits of a value of this many bits, e.g. hexBits(0xABCD, 32) is 0x0000ABCD. */
export const hexBits = (/** @type {number | bigint} */ value, /** @type {number} */ bits) => hex(value, Math.max(1, Math.ceil(bits / 4)));

/** A count with its noun, e.g. plural(1, "bit") is "1 bit", plural(2, "match", "matches") is "2 matches". */
export const plural = (/** @type {number} */ n, /** @type {string} */ word, many = word + "s") => `${num(n)} ${n === 1 ? word : many}`;

/** The value limited to the range from lo to hi. */
export const clamp = (/** @type {number} */ value, /** @type {number} */ lo, /** @type {number} */ hi) => Math.min(hi, Math.max(lo, value));

// Copyright 2026, Niklas Hauser
// SPDX-License-Identifier: MPL-2.0
// @ts-check
// Fills every <nav class="site"> with the links to all pages and marks the current one,
// <body data-page="boards"> names it. The links are relative to this file, so they work on
// data.modm.dev, with serve.py and from pages in sub folders like /pinout/stm32g474ret6/.

const ROOT = new URL("../", import.meta.url);

export const PAGES = [
  ["svd", "SVD Registers"],
  ["variants", "Peripheral Variants"],
  ["boards", "Board Pinouts"],
  ["pinout", "Pin Mapping"],
  ["clocks", "Clock Solver"],
  ["tools", "Tools"],
];

/** @param {HTMLElement} nav */
export function siteNav(nav, current = document.body.dataset.page) {
  const brand = document.createElement("a");
  brand.className = "brand";
  brand.href = ROOT.href;
  brand.innerHTML = "modm<span>-</span>data";
  const pages = document.createElement("div");
  pages.className = "pages";
  for (const [page, title] of PAGES) {
    const link = document.createElement("a");
    link.href = new URL(`${page}/`, ROOT).href;
    link.textContent = title;
    if (page === current) link.setAttribute("aria-current", "page");
    pages.append(link);
  }
  const source = document.createElement("a");
  source.className = "end";
  source.href = "https://github.com/modm-io/modm-data";
  source.textContent = "GitHub ↗";
  nav.replaceChildren(brand, pages, source);
}

for (const nav of document.querySelectorAll("nav.site")) siteNav(/** @type {HTMLElement} */ (nav));

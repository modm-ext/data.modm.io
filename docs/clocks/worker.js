// Copyright 2026, Niklas Hauser
// SPDX-License-Identifier: MPL-2.0
// Runs the Python clock code (copied to py/ by python -m modm_data_tools.clocks) and py/site_api.py in Pyodide.
// Messages are {id, op, args} in and {id, out} or {id, error} out, everything as JSON.
importScripts("https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js");

const FILES = [
  "modm_data/__init__.py", "modm_data/clocks/__init__.py", "modm_data/clocks/evaluate.py",
  "modm_data_tools/__init__.py", "modm_data_tools/errors.py", "modm_data_tools/clocks/__init__.py",
  "modm_data_tools/clocks/solver.py",
  "modm_data_tools/clocks/configure.py", "modm_data_tools/clocks/modm.py", "site_api.py",
];

const ready = (async () => {
  const py = await loadPyodide();
  // modm.py renders the SystemClock struct with a jinja2 template
  await py.loadPackage("jinja2");
  py.FS.mkdirTree("/home/pyodide/modm_data/clocks");
  py.FS.mkdirTree("/home/pyodide/modm_data_tools/clocks");
  for (const f of FILES) {
    const text = await (await fetch(`py/${f}`, {cache: "no-store"})).text();
    py.FS.writeFile(`/home/pyodide/${f}`, text);
  }
  py.runPython("import sys; sys.path.insert(0, '/home/pyodide'); import site_api");
  return py.pyimport("site_api").handle;
})();

onmessage = async ({data: {id, op, args}}) => {
  try {
    const handle = await ready;
    postMessage({id, out: JSON.parse(handle(op, JSON.stringify(args)))});
  } catch (error) {
    // A Python exception: its last line is the message
    const text = String(error.message ?? error).trim().split("\n").pop();
    postMessage({id, error: text});
  }
};

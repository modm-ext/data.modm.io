// Copyright 2026, Niklas Hauser
// SPDX-License-Identifier: MPL-2.0
// The Python clock code in a worker: evaluate, solve, max performance and code generation, all async.
const worker = new Worker(new URL("./worker.js", import.meta.url));
let next = 0;
const pending = new Map();
worker.onmessage = ({data: {id, out, error}}) => {
  const {resolve, reject} = pending.get(id);
  pending.delete(id);
  error === undefined ? resolve(out) : reject(new Error(error));
};

/** Calls are answered in order, the worker runs one at a time. */
export function call(op, args = {}) {
  const id = next++;
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject});
    worker.postMessage({id, op, args});
  });
}

export const load = (device, treeText, api) => call("load", {device, tree: treeText, api});
export const evaluate = (config, use) => call("evaluate", {config, use: use ? [...use] : null});
export const solve = (args) => call("solve", {...args, locked: [...args.locked], use: args.use ? [...args.use] : null});
export const maxPerformance = (config) => call("max", {config});
export const generate = (config, use) => call("generate", {config, use: use ? [...use] : null});

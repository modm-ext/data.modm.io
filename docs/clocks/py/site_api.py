"""The calls the clock solver page makes into modm_data.clocks, JSON in and out (runs in Pyodide, see ../worker.js)."""

import json
import math

from modm_data.clocks import evaluate
from modm_data_tools.clocks.modm import generate
from modm_data_tools.clocks.solver import Solver, max_performance

_state = {}


def _clean(value):
    """JSON without Infinity and NaN, which JSON.parse rejects."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {str(k): _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_clean(v) for v in value]
    return value


def _use(use):
    return None if use is None else set(use)


def handle(op: str, args: str) -> str:
    a = json.loads(args)
    if op == "load":
        tree = json.loads(a["tree"])
        _state.update(tree=tree, solver=Solver(tree), api=a.get("api"), device=a["device"])
        out = True
    elif op == "evaluate":
        out = evaluate(_state["tree"], a["config"], _use(a.get("use")))
    elif op == "solve":
        targets = {k: float(v) for k, v in a["targets"].items()}
        out = _state["solver"].solve(
            a["config"], set(a["locked"]), targets, _use(a.get("use")), a.get("tolerance", 0), a.get("budget", 3)
        )
    elif op == "max":
        out = max_performance(_state["tree"], a["config"], budget=a.get("budget", 0.6))
        if out is not None:
            out["use"] = None if out["use"] is None else list(out["use"])
    elif op == "generate":
        use = _use(a.get("use"))
        result = evaluate(_state["tree"], a["config"], use)
        out = generate(_state["tree"], _state["device"], a["config"], result, use, _state["api"])
    else:
        raise ValueError(f"unknown op {op}")
    return json.dumps(_clean(out))

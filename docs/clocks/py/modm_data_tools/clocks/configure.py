# Copyright 2026, Niklas Hauser
# SPDX-License-Identifier: MPL-2.0

"""
Solves a clock configuration from text, as the CLI and the site
take it, and explains the result or why there is none.

Targets are `name=value` items: `SYSCLK=max`, `USB=48M`, `SPI1=49.152M~0.1%`
(relative tolerance), `ADC<=50M`, `I2C1>=8M`, `SAI1=12.288M..12.3M`. Names are
nodes, their CubeMX parameters with or without `Freq_Value`, peripherals or one
of the aliases (SYSCLK, HCLK, PCLK1, CPU, ...), without case.
"""

import difflib
import math
import re
import time

from modm_data.clocks.evaluate import _frequency, _setting, _test, evaluate, identifiers, option_value
from ..errors import UserError
from .solver import Solver, fmt_hz

_ALIASES = {
    "SYSCLK": ["SysCLKOutput"],
    "HCLK": ["AHBOutput"],
    "AHB": ["AHBOutput"],
    "CPU": ["CpuClockOutput", "FCLKCortexOutput", "AHBOutput"],
    "CORE": ["CpuClockOutput", "FCLKCortexOutput", "AHBOutput"],
    "PCLK": ["APBOutput", "APB1Output"],
    "PCLK1": ["APB1Output", "APBOutput"],
    "PCLK2": ["APB2Output"],
    "PCLK3": ["APB3Output"],
    "PCLK4": ["APB4Output"],
    "APB": ["APBOutput", "APB1Output"],
    "HSE": ["HSEOSC"],
    "LSE": ["LSEOSC"],
}

_SPEC = re.compile(r"^\s*([\w\-.]+)\s*(<=|>=|=)\s*(.+?)\s*$")


def find_node(tree: dict, name: str) -> str:
    """:return: The node a name stands for, or a UserError with the closest names."""
    nodes, key = tree["nodes"], name.strip()
    if key in nodes:
        return key
    upper = key.upper()
    for alias in _ALIASES.get(upper, ()):
        if alias in nodes:
            return alias
    names = {}
    for n, node in nodes.items():
        names.setdefault(n.upper(), n)
        if param := node.get("param"):
            names.setdefault(param.upper(), n)
            names.setdefault(re.sub(r"FREQ_VALUE$", "", param.upper()), n)
    for p, n in tree.get("clocks", {}).items():
        # A peripheral without a node of its own is clocked by its kernel clock node
        names.setdefault(p.upper(), p if p in nodes else n)
    if upper in names:
        return names[upper]
    close = difflib.get_close_matches(upper, list(names), 6, 0.6)
    hint = f", did you mean {', '.join(names[c] for c in close)}?" if close else ""
    raise UserError(f"no clock '{name}' in this tree{hint}")


def parse_items(text: str) -> list[tuple[str, str, str]]:
    """:return: (name, operator, value) of comma, semicolon or line separated items."""
    items = []
    for item in filter(None, (i.strip() for i in re.split(r"[,;\n]", text or ""))):
        if not (m := _SPEC.match(item)):
            raise UserError(f"items are name=value, name<=value or name>=value, not '{item}'")
        items.append((m[1], m[2], m[3]))
    return items


def _maximum(tree: dict, name: str, settings: dict | None = None) -> float | None:
    """
    The highest frequency any limit of a node allows, for `name=max`, without the
    limits whose condition the settings rule out, for example, of the other voltage scales.
    """
    nodes, semaphores = tree["nodes"], tree["semaphores"]
    options = {k: option_value(tree, k, v) for k, v in (settings or {}).items() if k not in nodes}

    def known(gate):
        if gate[0] in ("var", "eq", "cmp"):
            return gate[1] in options
        return gate[0] == "const" or all(known(g) for g in gate[1:])

    for n in [name] + (["AHBOutput"] if name == "SysCLKOutput" else []):
        node = nodes.get(n, {})
        limits = [*node.get("limits", ()), *node.get("out_limits", ())]
        # A limit the settings select replaces the static ones, which cover every case
        decided = [v for v in limits if "when" in v and known(v["when"]) and _test(v["when"], options, semaphores)]
        if decided:
            values = [v.get(k) for k in ("max", "out_max") for v in decided]
        else:
            values = [node.get("max"), node.get("out_max")]
            values += [v.get(k) for k in ("max", "out_max") for v in limits if "when" not in v or not known(v["when"])]
        if values := [v for v in values if v]:
            return max(values)
    return None


def parse_targets(tree: dict, text: str, settings: dict | None = None) -> dict:
    """:return: {node: (lo, hi, aim)} with `aim` None for `max`, the highest frequency the settings allow."""
    targets = {}
    for name, op, value in parse_items(text):
        node = find_node(tree, name)
        if node in targets:
            raise UserError(f"{name} is a target twice ({node})")
        value = value.replace(" ", "")
        if value.lower() == "max":
            if (top := _maximum(tree, node, settings)) is None:
                raise UserError(f"{name} has no maximum frequency to aim at, give one")
            targets[node] = (0, top, None)
            continue
        try:
            if ".." in value:
                lo, hi = (_frequency(v) for v in value.split("..", 1))
                targets[node] = (lo, hi, hi)
            elif op != "=":
                f = _frequency(value)
                targets[node] = (0, f, f) if op == "<=" else (f, math.inf, f)
            else:
                f, _, tol = value.partition("~")
                f = _frequency(f)
                tol = float(tol.rstrip("%")) / (100 if tol.endswith("%") else 1) if tol else 0
                eps = max(f * tol, f * 1e-9, 1e-6)
                targets[node] = (f - eps, f + eps, f)
        except ValueError as error:
            raise UserError(f"{name}: {error}, write 48M, 12.288MHz, 32.768k, max or a range 10M..12M") from None
        lo, hi, aim = targets[node]
        if lo > hi:
            raise UserError(f"{name}: the range {value} is reversed")
        if aim <= 0:
            raise UserError(f"{name}: the frequency must be above 0 Hz, not {value}")
    if not targets:
        raise UserError("no targets given, e.g. 'SYSCLK=max, USB=48M'")
    return targets


def parse_config(tree: dict, text: str) -> dict:
    """:return: The settings with node names resolved, other keys (options, modes, flags) as they are.
    A value that a node, mode or option cannot take is a UserError, the solver would ignore it."""
    config = {}
    for name, op, value in parse_items(text):
        if op != "=":
            raise UserError(f"config items are name=value, not '{name}{op}{value}'")
        if (modes := tree.get("modes", {}).get(name)) and not re.match(r"[\d.]", value):
            # an oscillator mode, for example, HSE=ByPass
            if not any(value.lower() in (m.lower(), f.lower()) for m, f in modes.items()):
                raise UserError(f"{name} has no mode '{value}', choose from {', '.join(modes)}")
            config[name] = value
            continue
        try:
            name = find_node(tree, name)
        except UserError:
            # an option or a flag that a rule tests, evaluate() knows them
            if name not in tree["options"] and name not in identifiers(tree):
                raise
            choices = tree.get("choices", {}).get(name) or [
                f["macro"] for f in tree["semaphores"].values() if f["param"] == name
            ]
            if choices and option_value(tree, name, value) not in choices:
                raise UserError(f"{name} cannot be '{value}', choose from {', '.join(choices)}") from None
            config[name] = value
            continue
        try:
            _setting(name, tree["nodes"][name], value)
        except ValueError as error:
            # names the allowed values or the range of the node
            raise UserError(str(error)) from None
        config[name] = value
    return config


def _dead(tree: dict, settings: dict) -> set:
    """The nodes without a clock: external sources and pins the config does not set, and what only they feed."""
    nodes = tree["nodes"]
    dead = {n for n, node in nodes.items() if node["kind"] == "varied" and n not in settings}
    changed = True
    while changed:
        changed = False
        for n, node in nodes.items():
            if n in dead or not node["inputs"]:
                continue
            sources = [i["from"] for i in node["inputs"] if i["from"] in nodes and nodes[i["from"]]["kind"] != "frac"]
            if sources and (all(s in dead for s in sources) if node["kind"] == "mux" else sources[0] in dead):
                dead.add(n)
                changed = True
    return dead


def _without(tree: dict, drop) -> dict:
    """A copy of the tree whose muxes lose the inputs `drop` says no to, as long as one input is left."""
    nodes = dict(tree["nodes"])
    for n, node in nodes.items():
        if node["kind"] == "mux":
            kept = [i for i in node["inputs"] if not drop(n, i["from"])]
            if kept and len(kept) < len(node["inputs"]):
                nodes[n] = {**node, "inputs": kept}
    return {**tree, "nodes": nodes}


def restrict(tree: dict, settings: dict) -> dict:
    """The tree without the external clocks the board does not have, see `_dead`."""
    dead = _dead(tree, settings)
    return _without(tree, lambda mux, source: source in dead)


def prefer(tree: dict, source: str) -> dict:
    """The tree where the muxes upstream of SYSCLK only take inputs that come from `source`."""
    solver = Solver(tree)
    # the N6 has no SYSCLK, its cores and buses run from the SYSA, SYSB, ... muxes
    cores = ["SysCLKOutput"] if "SysCLKOutput" in tree["nodes"] else ["CpuClockOutput", "AHBOutput"]
    upstream = set().union(*(solver.ancestors(n) for n in cores if n in tree["nodes"]))
    return _without(tree, lambda mux, s: mux in upstream and source not in solver.ancestors(s))


def _peripherals(tree: dict, names: list[str]) -> set:
    """The peripherals a target or use item names, which evaluate() marks in use."""
    out, clocks = set(), tree.get("clocks", {})
    for name in names:
        upper = name.upper()
        if any(p.upper() == upper for p in clocks) or upper in ("MCO", "MCO1", "MCO2", "LSCO"):
            out.add(upper)
        elif clocked := sorted(p for p, node in clocks.items() if node == name):
            # A kernel clock output like FDCANoutput stands for the first peripheral on it
            out.add(clocked[0].upper())
    return out


def _settings(tree: dict, config: dict) -> dict:
    """The settings that differ from the defaults, in a form evaluate() reads back."""
    out = {}
    for name, value in config.items():
        node = tree["nodes"].get(name)
        default = node.get("value", node.get("default")) if node else None
        if node and node["kind"] != "mux" and default is not None:
            try:
                if float(value) == float(default):
                    continue
            except (TypeError, ValueError):
                pass
        elif node and value == default:
            continue
        out[name] = value
    return out


def _short(value, frequency: bool = True) -> str:
    """Macros without their RCC_..._ prefix where that stays unique, frequencies as 8M."""
    text = str(value)
    if m := re.fullmatch(r"RCC_\w+?SOURCE_(\w+)", text):
        return m[1]
    try:
        f = float(text)
    except ValueError:
        return text
    for suffix, scale in (("M", 1e6), ("k", 1e3)) if frequency else ():
        if f >= scale and f % 1 == 0:
            return f"{f / scale:.10g}{suffix}"
    return f"{f:.10g}"


def config_text(tree: dict, config: dict) -> str:
    """:return: `name=value, ...` for the non-default settings, which `parse_config` reads back."""
    kinds = {n: node["kind"] for n, node in tree["nodes"].items()}
    return ", ".join(
        f"{k}={_short(v, kinds.get(k) in ('fixed', 'varied', 'choice'))}" for k, v in _settings(tree, config).items()
    )


def _human(error: str) -> str:
    """6.4e+07 > 1.6e+07 as 64 MHz > max 16 MHz."""
    if m := re.fullmatch(r"([\d.e+]+) ([<>]) ([\d.e+]+)", error):
        return f"{fmt_hz(float(m[1]))} {m[2]} {'min' if m[2] == '<' else 'max'} {fmt_hz(float(m[3]))}"
    return error


def solve_text(tree: dict, targets: str, config: str = "", use: str = "", lock: str = "", budget: float = 5) -> dict:
    """
    Solves the targets with the settings of `config` kept where possible.

    :param lock: nodes the solver must not move, comma separated; the sources set in config are always locked.
    :return: {ok, config, result, targets, use, unmet, problems, conflicts, timeout, seconds}
    """
    settings = parse_config(tree, config)
    goals = parse_targets(tree, targets, settings)
    locked = {find_node(tree, n) for n in (lock or "").split(",") if n.strip()}
    # A board's oscillator frequencies are facts, not choices
    locked |= {n for n in settings if tree["nodes"].get(n, {}).get("kind") in ("varied", "fixed")}
    # The muxes chosen in config are the user's choice: first try to keep all of them, only then move them
    muxes = {n for n in settings if tree["nodes"].get(n, {}).get("kind") == "mux"} - locked
    if muxes:
        kept = solve_text(tree, targets, config, use, ",".join(sorted(locked | muxes)), budget / 2)
        if kept["ok"]:
            return kept | {"locked": sorted(locked)}
    use_set = _peripherals(tree, [u for u in (use or "").split(",") if u.strip()] + list(goals))
    start = time.monotonic()
    # The board decides which external clocks exist: only those set in config count
    available = restrict(tree, settings)
    solver = Solver(available)

    cpu = next((n for n in _ALIASES["CPU"][:2] if n in tree["nodes"]), None)

    def run(goals_now: dict, share: float, diagnose: bool = True, start: dict | None = None) -> dict:
        start = settings if start is None else start
        maxima = [n for n, (_, _, aim) in goals_now.items() if aim is None]
        if not maxima:
            return solver.solve(start, locked, goals_now, use_set, 0, budget * share, diagnose)
        if len(maxima) > 1:
            # one maximum after the other, in the order given: CPU=max, HCLK=max is the fastest HCLK of the fastest CPU
            first = run({k: v for k, v in goals_now.items() if k not in maxima[1:]}, share / 2, diagnose, start)
            if not first["ok"]:
                return first
            f = first["result"][maxima[0]]["freq"]
            # from the first configuration, so that the N6 HCLK shares the PLL of the CPU instead of taking another
            fixed = goals_now | {maxima[0]: (f * (1 - 1e-9), f * (1 + 1e-9), f)}
            return run(fixed, share / 2, diagnose, first["config"])
        # Aim at the maximum, then step down through the frequencies the node can reach
        name, top = maxima[0], goals_now[maxima[0]][1]
        reachable = [f for f in solver.reachable(name, start, locked) if f <= top * (1 + 1e-9)]
        rungs = reachable[:200] or [top]
        # SYSCLK=max is the fastest core: a slightly slower SYSCLK may let the CPU and HCLK run faster,
        # for example, 434 MHz on the STM32H7P instead of 435 MHz, whose HCLK would need a divider of 2.008
        core = [name] + ([n for n in (cpu, "AHBOutput") if n and n != name] if name == "SysCLKOutput" else [])
        deadline, r, best, timeouts, i = time.monotonic() + budget * share, None, None, 0, 0
        knees, solved = [top], set()

        def interval(f):
            return min((k for k in knees if k >= f * (1 - 1e-9)), default=top)

        while i < len(rungs):
            f, i = rungs[i], i + 1
            # A rung cannot beat the best solution when even the core clocks at their limits would not,
            # the CPU and HCLK count first, SYSCLK only between equals
            if best and (sum(min(f, cap) for cap in best[2]), f) <= (best[0][0] * (1 + 1e-9), best[0][1]):
                continue
            # Between two knees the dividers stay the same, a lower rung only slows the core down
            if interval(f) in solved:
                continue
            trial = {**goals_now, name: (f * (1 - 1e-9), f * (1 + 1e-9), f)}
            left = deadline - time.monotonic()
            # Only the last rung explains a failure
            last = diagnose and not best and (left <= budget * share / 5 or i == len(rungs))
            r = solver.solve(start, locked, trial, use_set, 0, max(min(left, budget * share / 5), 0.05), last)
            # Two rungs out of time in a row: the next ones will not do better
            timeouts = timeouts + 1 if r.get("timeout") else 0
            if r["ok"]:
                result = r["result"]
                score = (sum(result[n]["freq"] for n in core[1:]), result[name]["freq"])
                # The limits of the core clocks, a clock below another one also within that one's
                own = {n: result[n].get("bounds", {}).get("", (None, None))[1] or math.inf for n in core}
                caps = [min(own[m] for m in core if m == n or m in solver.ancestors(n)) for n in core[1:]]
                if best is None and caps:
                    # Next the SYSCLKs that put a core clock at its limit with a divider of 2 to 16,
                    # the fractional PLLs reach too many frequencies near the top to step down to them
                    knees += [c * k for c in caps if c < top for k in range(2, 17) if c * k <= top * (1 + 1e-9)]
                    below = {next((g for g in reachable if g <= k * (1 + 1e-9)), None) for k in knees}
                    rungs[i:i] = sorted(below - {None} - set(rungs[:i]), reverse=True)
                solved.add(interval(f))
                if not best or score > best[0]:
                    best = (score, r, caps)
            if left <= 0 or timeouts >= 2:
                break
        return best[1] if best else r

    # A target no path reaches even alone fails at once, with the closest frequency it reaches
    if unmet := solver.unreachable(settings, locked, goals, budget):
        result = evaluate(tree, settings, use_set)
        return {"ok": False, "targets": goals, "use": sorted(use_set), "locked": sorted(locked), "conflicts": [],
                "unmet": unmet, "problems": [], "timeout": False, "config": settings, "result": result,
                "seconds": time.monotonic() - start}  # fmt: skip
    r = None
    if "HSEOSC" in settings:
        # A board with a crystal clocks the core from it, the HSI drifts too much for USB, CAN or a UART
        solver = Solver(prefer(available, "HSEOSC"))
        r = run(goals, 0.5, diagnose=False)
        solver = Solver(available)
    if not r or not r["ok"]:
        r = run(goals, 1)
    out = {"ok": r["ok"], "targets": goals, "use": sorted(use_set), "locked": sorted(locked), "conflicts": [],
           "unmet": r["unmet"], "problems": r["problems"], "timeout": r.get("timeout", False)}  # fmt: skip
    if r["ok"]:
        out |= {"config": r["config"], "result": r["result"]}
    else:
        best = r.get("best") or {}
        out |= {
            "config": best.get("config", settings),
            "result": best.get("result") or evaluate(tree, settings, use_set),
        }
        # Which targets stand in each other's way: each one left out in turn
        if len(goals) > 1 and not any(u["id"] for u in r["unmet"]):

            def attempt(wanted):
                # like the full search, from the crystal first
                nonlocal solver
                if "HSEOSC" in settings:
                    solver = Solver(prefer(available, "HSEOSC"))
                    found = run(wanted, 0.3 / len(goals), diagnose=False)
                    solver = Solver(available)
                    if found["ok"]:
                        return found
                return run(wanted, 0.3 / len(goals), diagnose=False)

            for name in goals:
                if (partial := attempt({k: v for k, v in goals.items() if k != name}))["ok"]:
                    out["conflicts"].append(name)
                    # the result shown leaves out the last conflicting target, the others come first for the user
                    out |= {"config": partial["config"], "result": partial["result"], "left_out": name}
            if name := out.get("left_out"):
                # and gets that target as close as it can
                lo, hi, aim = goals[name]
                for tolerance in (0.01, 0.1, 0.25) if aim else ():
                    if (partial := attempt(goals | {name: (aim * (1 - tolerance), aim * (1 + tolerance), aim)}))["ok"]:
                        out |= {"config": partial["config"], "result": partial["result"]}
                        break
    out["seconds"] = time.monotonic() - start
    out["moved"] = {n: (settings[n], out["config"].get(n)) for n in muxes if out["config"].get(n) != settings[n]}
    return out


def _source_path(tree: dict, result: dict, name: str) -> str:
    """The chosen path from a clock source to a node, e.g. HSEOSC > PLLM > PLLN > PLLP."""
    nodes, path, seen = tree["nodes"], [], set()
    while name in nodes and name not in seen:
        seen.add(name)
        node = nodes[name]
        if node["kind"] in ("mux", "div", "mul", "mulfrac", "fixed", "varied", "choice") and (
            node["kind"] != "mux" or len(node["inputs"]) > 1
        ):
            path.append(name)
        setting = result[name].get("setting")
        inputs = [i for i in node["inputs"] if i["from"] in nodes and nodes[i["from"]]["kind"] != "frac"]
        if node["kind"] == "mux":
            inputs = [i for i in inputs if setting in (i.get("macro"), i["from"])]
        name = inputs[0]["from"] if inputs else None
    return " < ".join(path)


def report(tree: dict, solved: dict, device: str = "", code: str | None = None) -> str:
    """:return: The result of `solve_text` as text for a person or a model."""
    nodes, result = tree["nodes"], solved["result"]
    lines = []
    head = f"{device}: " if device else ""
    if solved["ok"]:
        lines.append(f"{head}solved in {solved['seconds']:.2f} s")
    else:
        lines.append(f"{head}NO SOLUTION ({solved['seconds']:.2f} s)")

    def freq(n):
        return result.get(n, {}).get("freq")

    lines.append("targets:")
    for name, (lo, hi, aim) in solved["targets"].items():
        f = freq(name)
        hit = f is not None and lo * (1 - 1e-9) <= f <= hi * (1 + 1e-9)
        want = "max" if aim is None else fmt_hz(aim) if lo == hi or abs(hi - lo) < aim * 1e-6 else (
            f"<={fmt_hz(hi)}" if lo == 0 else f">={fmt_hz(lo)}" if hi == math.inf else f"{fmt_hz(lo)}..{fmt_hz(hi)}")  # fmt: skip
        error = "" if hit or aim is None else f", off by {(f - aim) / aim * 100:+.3g} %" if f and aim else ""
        mark = "ok" if hit else "MISSED"
        lines.append(f"  {name} = {fmt_hz(f)} (want {want}) {mark}{error}  from {_source_path(tree, result, name)}")

    if not solved["ok"]:
        lines.append("why:")
        for u in solved["unmet"]:
            if u["id"]:
                aim = solved["targets"][u["id"]][2] or solved["targets"][u["id"]][1]
                closest = (f", the closest it gets with the board's clocks is {fmt_hz(u['closest'])}"
                           f" ({(u['closest'] - aim) / aim * 100:+.2g} %)" if u.get("closest") else "")  # fmt: skip
                lines.append(f"  {u['id']} cannot reach its target on any path{closest}.")
            else:
                lines.append(f"  every target is reachable on its own, but {u['why']}.")
        if len(solved["conflicts"]) == 1:
            lines.append(f"  {solved['conflicts'][0]} does not fit with the other targets, without it they solve.")
        elif solved["conflicts"]:
            lines.append(f"  {', '.join(solved['conflicts'])} conflict: leaving out any one of them solves the rest.")
        if solved.get("left_out"):
            lines.append(f"  the configuration below solves every target except {solved['left_out']}.")
        if solved["problems"]:
            lines.append("  closest candidate breaks: " + "; ".join(_problem(p) for p in solved["problems"][:6]))
        if solved["timeout"]:
            lines.append(
                "  the search ran out of time: give a tolerance (~0.1%), lock fewer nodes or set more in config."
            )

    # The core clocks and every peripheral in use
    core = [n for n in ("SysCLKOutput", "CpuClockOutput", "FCLKCortexOutput", "AHBOutput", "APBOutput", "APB1Output",
                        "APB2Output", "APB3Output", "APB4Output") if n in nodes and freq(n)]  # fmt: skip
    lines.append("clocks: " + ", ".join(f"{n.removesuffix('Output')} {fmt_hz(freq(n))}" for n in core))
    used = [p for p in solved["use"] if p in nodes and p not in solved["targets"]]
    if used:
        lines.append("in use: " + ", ".join(f"{p} {fmt_hz(freq(p))}" for p in used))
    options = result.get("options", {}).get("setting", {})
    power = [f"{k}={_short(v)}" for k, v in options.items() if re.search(r"Voltage_Scale|OverDrive|Boost", k)]
    flash = result.get("FLatency", {}).get("setting")
    if power or flash:
        lines.append("power: " + ", ".join(power + ([f"flash {flash}"] if flash else [])))
    errors = [f"{n}: {', '.join(_human(e) for e in r['errors'])}"
              for n, r in result.items() if n in nodes and r.get("used") and r.get("errors")]  # fmt: skip
    if errors and solved["ok"]:
        lines.append("warnings: " + "; ".join(errors))
    usb = [p for p in list(solved["targets"]) + list(solved["use"]) if "USB" in p.upper() and p in nodes]
    if any(re.search(r"(HSI)?48(RC|M)?$|RC48", _source_path(tree, result, p).split(" < ")[-1]) for p in usb):
        lines.append("note: USB from the HSI48 needs the CRS synchronized to the USB SOF, or use a crystal clock.")
    if moved := solved.get("moved"):
        # no silent change of a choice the user made
        lines.append("moved: " + ", ".join(f"{n} {a} -> {b or 'default'}" for n, (a, b) in moved.items())
                     + " (the targets could not be met with these kept; lock them to insist)")  # fmt: skip
    text = config_text(tree, solved["config"])
    lines.append(f"config: {text or '(all defaults)'}")
    # factors whose macro is not just their number, e.g. PSI=18 is PSI_144MHZ_REF_8MHZ
    named = []
    for k, v in _settings(tree, solved["config"]).items():
        for d in nodes.get(k, {}).get("domain", ()):
            try:
                same = d.get("macro") and abs(float(d["factor"]) - float(v)) < 1e-9
            except (KeyError, TypeError, ValueError):
                same = False
            if same and not re.search(rf"(?<![\d.]){float(v):g}$", d["macro"]):
                named.append(f"{k}={d['macro']}")
    if named:
        lines.append("macros: " + ", ".join(named))
    if solved["ok"]:
        lines.append("next: pass this config back with more targets or use items; it keeps these choices where it can.")
    elif (name := solved.get("left_out")) and (aim := solved["targets"][name][2]) and (f := freq(name)):
        # the tolerance that accepts what the other targets leave for it
        tolerance = math.ceil(abs(f - aim) / aim * 1000) / 10
        lines.append(
            f"next: {name}={fmt_hz(aim).replace(' ', '')}~{tolerance:g}% accepts {fmt_hz(f)}, or change another target."
        )
    else:
        lines.append(
            "next: relax a target (tolerance ~0.1%, a range or <=), unlock nodes, or change the sources in config."
        )
    if code:
        lines += ["", code]
    return "\n".join(lines)


def _problem(text: str) -> str:
    name, _, rest = text.partition(": ")
    return f"{name} {_human(rest)}"

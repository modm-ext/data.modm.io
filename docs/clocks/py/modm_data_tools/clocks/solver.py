# Copyright 2026, Niklas Hauser
# SPDX-License-Identifier: MPL-2.0

"""
Finds a clock configuration that meets frequency targets on any nodes of a tree.

Depth first search from each target down to the sources: a mux tries its
inputs, a divider its factors (target × k on its input), a multiplier the
frequencies its input can reach (enumerated bottom up), so the factor follows.
The current choice of every node is tried first, which finds the smallest
change. Every complete candidate goes through `evaluate()`, so configuration
dependent limits, constraints and flash wait states reject it there.
"""

import math
import time

from modm_data.clocks.evaluate import _compile, _setting, evaluate

REACH_CAP = 20000


def fmt_hz(hz) -> str:
    """:return: A frequency with its unit, for example, `48 MHz`."""
    if hz is None or not math.isfinite(hz):
        return "-"
    for unit, scale in (("GHz", 1e9), ("MHz", 1e6), ("kHz", 1e3)):
        if abs(hz) >= scale:
            return f"{hz / scale:.7g} {unit}"
    return f"{hz:.7g} Hz"


def choice_of(tree: dict, name: str, config: dict | None):
    """:return: The setting a node stands at: config, else its default."""
    node = tree["nodes"][name]
    if config and name in config:
        try:
            return _setting(name, node, config[name])
        except ValueError:
            pass  # a stale value, fall back
    return node.get("value", node.get("default"))


def factors_of(node: dict) -> list:
    """:return: The values the solver may give a node."""
    if node.get("domain"):
        return [d.get("factor", d.get("value")) for d in node["domain"]]
    if "range" in node:
        return list(range(int(node["range"][0]), int(node["range"][1]) + 1))
    return []


def is_variable(node: dict) -> bool:
    """:return: Whether the solver may move a node."""
    if node["kind"] == "mux":
        return len(node["inputs"]) > 1
    if node["kind"] in ("div", "mul", "mulfrac", "frac"):
        return not node.get("rules") and len(factors_of(node)) > 1
    return node["kind"] == "choice" and len(node.get("domain") or ()) > 1


def _macro(input: dict) -> str:
    return input.get("macro") or input["from"]


class _Timeout(Exception):
    pass


class _Frozen(frozenset):
    """The variable nodes a tier of the search must not move."""

    def __new__(cls, items=(), tag="", fresh=()):
        self = super().__new__(cls, items)
        self.tag, self.fresh = tag, list(fresh)
        return self


_NONE = _Frozen()


class Solver:
    def __init__(self, tree: dict):
        self.tree = tree
        self.nodes = tree["nodes"]
        self._ancestors, self._descendants, self._tiers = {}, {}, {}
        self.config = {}
        self.params = {n: node["param"] for n, node in self.nodes.items() if "param" in node}
        self._compiled = {}
        # The input frequency some factors need, the STM32C5 PSI x2 only from 50 MHz
        self.refs = {
            n: {d["factor"]: d["input"] for d in node["domain"] if "input" in d}
            for n, node in self.nodes.items()
            if any("input" in d for d in node.get("domain", ()))
        }
        # Nodes upstream of a bus clock, the shared core, solved first
        self.core = set()
        for node in self.nodes.values():
            if "bus" in node:
                self.core |= self.ancestors(node["bus"])

    def ancestors(self, name: str) -> set:
        if name not in self._ancestors:
            seen, stack = set(), [name]
            while stack:
                n = stack.pop()
                if n in seen or n not in self.nodes:
                    continue
                seen.add(n)
                stack += [i["from"] for i in self.nodes[n]["inputs"]]
            self._ancestors[name] = seen
        return self._ancestors[name]

    def descendants(self, name: str) -> set:
        if name not in self._descendants:
            seen, stack = set(), list(self.nodes.get(name, {}).get("outputs", ()))
            while stack:
                n = stack.pop()
                if n in seen or n not in self.nodes:
                    continue
                seen.add(n)
                stack += self.nodes[n]["outputs"]
            self._descendants[name] = seen
        return self._descendants[name]

    def envelope(self, node: dict) -> tuple[float, float]:
        """The static envelope of a node's frequency, which every configuration dependent limit lies within."""
        lo, hi = node.get("out_min") or 0, node.get("out_max") or math.inf
        if node["kind"] in ("fixed", "varied", "output"):
            lo, hi = max(lo, node.get("min") or 0), min(hi, node.get("max") or math.inf)
        return lo * (1 - 1e-9), hi * (1 + 1e-9)

    def clip(self, node: dict, lo: float, hi: float):
        a, b = self.envelope(node)
        lo, hi = max(lo, a, 5e-324), min(hi, b)
        return (lo, hi) if lo <= hi else None

    def rule_factor(self, node: dict, A: dict):
        """The factor the rules of a node give under A, None if a rule tests something A does not decide."""
        settings = dict(self.tree["options"])
        for key, value in self.config.items():
            if key not in self.nodes:
                settings[key] = str(value)
        for name, param in self.params.items():
            value = A.get(name, self.current(name))
            other = self.nodes[name]
            if other["kind"] == "mux":
                settings[param] = value
            else:
                found = [d["macro"] for d in other.get("domain", ()) if d.get("factor", d.get("value")) == value]
                settings[param] = found[0] if found else (f"{value:g}" if isinstance(value, (int, float)) else value)
        default = None
        for rule in node["rules"]:
            if "when" not in rule:
                default = rule["factor"]
                continue
            gate = rule["when"]
            if not self._known(gate, settings):
                return None
            if self._compiled.setdefault(id(gate), _compile(gate, self.tree["semaphores"]))(settings):
                return rule["factor"]
        return default

    def _known(self, gate, settings) -> bool:
        """Whether every name a condition tests has a setting, frequencies are not known during the search."""
        if gate[0] in ("var", "eq", "cmp"):
            return gate[1] in settings
        return gate[0] == "const" or all(self._known(g, settings) for g in gate[1:])

    def fits(self, name: str, k, f: float) -> bool:
        """:return: Whether factor k of a node suits its input frequency f."""
        ref = self.refs.get(name, {}).get(k)
        return ref is None or abs(f - ref) <= 1e-3

    def current(self, name: str):
        return choice_of(self.tree, name, self.config)

    def _base(self, locked) -> dict:
        """The locked variable nodes at their current setting. A node without one, e.g. the F105 PLLMUL without
        default, or a mux that stands at no input, e.g. a HAL2 PLL source at its default NoClock, is left free:
        evaluate() rejects that value when it is set."""
        base = {}
        for n in locked:
            if n in self.nodes and is_variable(node := self.nodes[n]):
                now = self.current(n)
                if node["kind"] == "mux":
                    known = now in {i.get("macro") or i["from"] for i in node["inputs"]}
                else:
                    known = now is not None
                if known:
                    base[n] = now
        return base

    def order(self, name: str, values: list, A: dict, F) -> list:
        """The candidates of a variable node, the assigned one only, else the current one first."""
        now = self.current(name)
        if name in A:
            return [v for v in values if v == A[name]]
        if name in F:
            return [v for v in values if v == now]
        return [v for v in values if v == now] + [v for v in values if v != now]

    def tick(self):
        self.steps += 1
        if self.steps % 2048 == 0 and time.monotonic() > self.deadline:
            raise _Timeout()

    def source(self, node: dict):
        return next(
            (i["from"] for i in node["inputs"] if i["from"] in self.nodes and self.nodes[i["from"]]["kind"] != "frac"),
            None,
        )

    def _frac_input(self, node: dict):
        return next(
            (i["from"] for i in node["inputs"] if i["from"] in self.nodes and self.nodes[i["from"]]["kind"] == "frac"),
            None,
        )

    def paths(self, name: str, lo: float, hi: float, aim: float, A: dict, F):
        """Every assignment extending A under which node `name` runs within [lo, hi], aiming at `aim`."""
        self.tick()
        node = self.nodes.get(name)
        span = node and self.clip(node, lo, hi)
        if not span:
            return
        lo, hi = span
        kind, src = node["kind"], self.source(node)
        if kind in ("fixed", "varied"):
            if lo <= (self.current(name) or 0) <= hi:
                yield A
        elif kind == "choice":
            if not node.get("domain"):
                if lo <= (self.current(name) or 0) <= hi:
                    yield A
                return
            for v in self.order(name, factors_of(node), A, F):
                if lo <= v <= hi:
                    yield {**A, name: v}
        elif kind == "mux":
            for macro in self.order(name, [_macro(i) for i in node["inputs"]], A, F):
                input = next(i for i in node["inputs"] if _macro(i) == macro)
                if input["from"] in self.nodes:
                    yield from self.paths(input["from"], lo, hi, aim, {**A, name: macro}, F)
        elif kind in ("output", "peripheral"):
            if src:
                yield from self.paths(src, lo, hi, aim, A, F)
        elif kind in ("div", "mul"):
            if not src:
                return
            if node.get("rules"):
                # A factor that follows from other settings: only the paths under which its rule holds,
                # the G0 timer x2 needs an APB prescaler other than 1
                for k in dict.fromkeys(r["factor"] for r in node["rules"]):
                    if kind == "div":
                        below = self.paths(src, lo * k, hi * k, aim * k, A, F)
                    else:
                        below = self.paths(src, lo / k, hi / k, aim / k, A, F)
                    for B in below:
                        if self.rule_factor(node, B) in (None, k):
                            yield B
            elif kind == "div":
                for k in self.order(name, factors_of(node), A, F):
                    yield from self.paths(src, lo * k, hi * k, aim * k, {**A, name: k}, F)
            else:
                yield from self.multiply(name, node, src, lo, hi, aim, A, F, None)
        elif kind == "mulfrac":
            yield from self.multiply(name, node, src, lo, hi, aim, A, F, self._frac_input(node))

    def multiply(self, name, node, src, lo, hi, aim, A, F, frac):
        """A multiplier: every input frequency it can reach and the factors that land in [lo, hi], fractional last."""
        if not src:
            return
        factors = set(factors_of(node))
        frac_free = frac and frac not in A and frac not in F
        frac_now = (A.get(frac, self.current(frac)) or 0) / 8192 if frac and not frac_free else 0
        reached = self.reach(src, A, F)
        now = self.current(name)
        # The STM32C5 PSI multiplies by 100 / 48 MHz
        fractional = any(not float(f).is_integer() for f in factors)
        for r in reached:
            klo, khi = lo / r[0] - frac_now - 1e-9, hi / r[0] - frac_now + 1e-9
            kmin, kmax = math.ceil(klo), math.floor(khi)
            if kmax < kmin and not fractional:
                continue
            if name in A:
                ks = [A[name]]
            elif name in F:
                ks = [now]
            elif fractional:
                ks = [now, *sorted(f for f in factors if klo <= f <= khi)]
            else:
                ks = [now, *range(kmin, kmin + min(kmax - kmin + 1, 1024))]
            seen = set()
            for k in ks:
                if k in seen or k is None or not klo <= k <= khi or k not in factors or not self.fits(name, k, r[0]):
                    continue
                seen.add(k)
                yield {**A, **r[1], name: k, **({frac: 0} if frac_free else {})}
        if not frac_free:
            return
        # Fractional-N lands close to a target, it only helps where the integer factors miss
        low, high = self.nodes[frac].get("range", (0, 8191))
        for r in reached:
            x = aim / r[0]
            k = math.floor(x)
            fr = round((x - k) * 8192)
            if (
                fr <= 0
                or fr < low
                or fr > high
                or (name in A and A[name] != k)
                or k not in factors
                or not self.fits(name, k, r[0])
            ):
                continue
            if lo <= r[0] * (k + fr / 8192) <= hi:
                yield {**A, **r[1], name: k, frac: fr}

    def reach(self, name: str, A: dict, F) -> list:
        """Every frequency a node can produce under A, with the settings it adds to A, a few per frequency."""
        key = (name, F.tag, tuple(sorted((n, A[n]) for n in self.ancestors(name) if n in A)))
        if key in self.memo:
            return self.memo[key]
        self.tick()
        node = self.nodes[name]
        out = []
        lo, hi = self.envelope(node)
        src = self.source(node)

        def push(f, d):
            if f and lo <= f <= hi and f > 0:
                out.append((f, d))

        kind = node["kind"]
        if kind in ("fixed", "varied"):
            push(self.current(name) or 0, {})
        elif kind == "choice":
            if not node.get("domain"):
                push(self.current(name) or 0, {})
            else:
                for v in self.order(name, factors_of(node), A, F):
                    push(v, {name: v})
        elif kind == "mux":
            for macro in self.order(name, [_macro(i) for i in node["inputs"]], A, F):
                input = next(i for i in node["inputs"] if _macro(i) == macro)
                if input["from"] in self.nodes:
                    out += [
                        (f, {**d, name: macro})
                        for f, d in self.reach(input["from"], {**A, name: macro}, F)
                        if lo <= f <= hi and f > 0
                    ]
        elif kind in ("output", "peripheral"):
            if src:
                for f, d in self.reach(src, A, F):
                    push(f, d)
        elif kind in ("div", "mul", "mulfrac") and src:
            upstream = self.reach(src, A, F)
            rules = node.get("rules")
            factors = (
                list(dict.fromkeys(r["factor"] for r in rules)) if rules else self.order(name, factors_of(node), A, F)
            )
            frac = self._frac_input(node)
            zero = {frac: 0} if frac and frac not in A and frac not in F else {}
            for k in factors:
                # The settings dict only for the frequencies within the envelope
                if kind == "div":
                    hits = [(f / k, d) for f, d in upstream if lo <= f / k <= hi and f > 0]
                else:
                    hits = [(f * k, d) for f, d in upstream if lo <= f * k <= hi and f > 0 and self.fits(name, k, f)]
                out += hits if rules else [(f, {**d, name: k, **zero}) for f, d in hits]
                if len(out) > 4 * REACH_CAP:
                    break
        # Deduplicate by frequency, keeping a few assignments in case one breaks a limit later
        buckets = {}
        for r in out:
            b = round(r[0] * 1000)
            if b not in buckets:
                if len(buckets) < REACH_CAP:
                    buckets[b] = [r]
            elif len(buckets[b]) < 3:
                buckets[b].append(r)
        out = [r for rs in buckets.values() for r in rs]
        self.memo[key] = out
        return out

    def tiers(self, name: str) -> list:
        """
        The variable nodes upstream of `name` in tiers of growing fan-out. The search
        first moves only the nodes that clock few others, so a peripheral target
        picks its own mux before it slows down a bus, and HCLK takes the AHB
        prescaler before the CPU prescaler. Tier t freezes every node of a later tier.
        """
        if name not in self._tiers:
            variables = [n for n in self.ancestors(name) if is_variable(self.nodes[n])]
            fanout = {n: len(self.descendants(n)) for n in variables}
            levels = sorted(set(fanout.values()))
            # ponytail: each tier re-searches the earlier ones, so the widest nodes share the last of at most 8 tiers
            if len(levels) > 8:
                levels = levels[:7] + levels[-1:]
            out = []
            for t, level in enumerate(levels):
                fresh = [n for n in variables if fanout[n] <= level and (t == 0 or fanout[n] > levels[t - 1])]
                out.append(_Frozen((n for n in variables if fanout[n] > level), f"{name}#{t}", fresh))
            self._tiers[name] = out or [_NONE]
        return self._tiers[name]

    def combine(self, constraints: list, i: int, A: dict):
        if i == len(constraints):
            yield A
            return
        # The constraints from i on only see the settings of their ancestors: a state that failed once fails again
        signature = tuple((c["id"], c["lo"], c["hi"]) for c in constraints[i:])
        relevant = self._relevant(signature)
        key = (signature, tuple((n, A[n]) for n in relevant if n in A))
        if key in self.nogood:
            return
        found = False
        c = constraints[i]
        for t, F in enumerate(self.tiers(c["id"])):
            for B in self.paths(c["id"], c["lo"], c["hi"], c["aim"], A, F):
                # A solution that leaves the nodes this tier freed as they are came up in an earlier tier
                if t == 0 or not F.fresh or any(n in B and B[n] != self.current(n) for n in F.fresh):
                    for C in self.combine(constraints, i + 1, B):
                        found = True
                        yield C
        if not found:
            self.nogood.add(key)

    def _relevant(self, signature: tuple) -> list:
        if signature not in self._relevant_cache:
            names = set().union(*(self.ancestors(c[0]) for c in signature))
            self._relevant_cache[signature] = sorted(names)
        return self._relevant_cache[signature]

    def problems(self, result: dict, constraints: list) -> tuple[list, list]:
        """The violations of a configuration, and the limits of the nodes that break one."""
        out, limits = [], []
        for name, r in result.items():
            if not r.get("used") or not r.get("errors"):
                continue
            out += [f"{name}: {e}" for e in r["errors"]]
            node, bounds = self.nodes.get(name), r.get("bounds", {})
            own = bounds.get("")
            key = (
                "" if node and node["kind"] in ("fixed", "varied", "output") and own and own != (None, None) else "out_"
            )
            if (b := bounds.get(key)) and any(" < " in e or " > " in e for e in r["errors"]):
                limits.append({"id": name, "lo": b[0] or 0, "hi": b[1] if b[1] is not None else math.inf})
        for c in constraints:
            f = result.get(c["id"], {}).get("freq")
            if f is None or f < c["lo"] or f > c["hi"]:
                out.append(f"{c['id']}: {fmt_hz(f)} instead of {fmt_hz(c['aim'])}")
        return out, limits

    def reachable(self, name: str, config: dict | None = None, locked=(), budget: float = 1) -> list[float]:
        """:return: The frequencies a node can reach with the locked nodes at their setting, fastest first."""
        self.config, self.memo, self.steps = dict(config or {}), {}, 0
        self.deadline = time.monotonic() + budget
        base = self._base(locked)
        try:
            return sorted({round(f, 3) for f, _ in self.reach(name, base, _NONE)}, reverse=True)
        except _Timeout:
            return []

    def _unreachable(self, target_list: list, base: dict, budget: float) -> list:
        """The targets no path reaches even alone, with the closest frequency they reach."""
        unmet = []
        for c in target_list:
            self.memo = {}
            self.deadline = time.monotonic() + min(budget / 10, 0.5)
            alone = True  # out of time counts as reachable, no claim without proof
            try:
                alone = next(self.paths(c["id"], c["lo"], c["hi"], c["aim"], base, _NONE), None)
            except _Timeout:
                pass
            if alone is not None:
                continue
            closest = None
            try:
                self.deadline = time.monotonic() + min(budget / 6, 1)
                for f, _ in self.reach(c["id"], base, _NONE):
                    if closest is None or abs(f - c["aim"]) < abs(closest - c["aim"]):
                        closest = f
            except _Timeout:
                pass
            unmet.append({"id": c["id"], "why": "unreachable", "closest": closest})
        return unmet

    def unreachable(self, config: dict, locked, targets: dict, budget: float = 2) -> list:
        """:return: The targets (lo, hi, aim) that no path reaches even alone, see `solve()`."""
        self.config, self.memo, self.steps = dict(config or {}), {}, 0
        base = self._base(locked)
        found = [{"id": n, "lo": lo, "hi": hi, "aim": aim if aim is not None else hi}
                 for n, (lo, hi, aim) in targets.items() if n in self.nodes]  # fmt: skip
        return self._unreachable(found, base, budget)

    def solve(
        self,
        config: dict | None = None,
        locked=(),
        targets: dict | None = None,
        use=None,
        tolerance: float = 0,
        budget: float = 10,
        diagnose: bool = True,
    ) -> dict:
        """
        :param config: current settings, kept wherever the targets do not need a change.
        :param locked: node names the solver must not move.
        :param targets: {name: Hz or (lo, hi, aim)}.
        :param use: peripherals in use, see `evaluate()`.
        :param tolerance: relative, 0 is exact.
        :param budget: seconds of search.
        :param diagnose: whether a failure finds out which targets cannot be reached and how close they get.
        :return: {ok, config, result, unmet: [{id, why, closest}], problems, timeout, ...}
        """
        config, targets = dict(config or {}), dict(targets or {})
        core = {n for n in self.core if is_variable(self.nodes[n])} - set(locked)
        if core and targets and not any(n in self.core for n in targets):
            # Kernel clock targets leave the core clocks alone where they can, else a PLL1Q target
            # retunes the VCO under SYSCLK and the limit repair may settle anywhere below the limits
            r = self.solve(config, set(locked) | core, targets, use, tolerance, budget / 2, diagnose=False)
            if r["ok"]:
                return r
            budget /= 2
        self.config, self.memo, self.steps = config, {}, 0
        self.nogood, self._relevant_cache = set(), {}
        self.deadline = time.monotonic() + budget
        # The core clocks keep their frequency when a repair has to move them, if they can
        buses = {node["bus"] for node in self.nodes.values() if "bus" in node} | {"SysCLKOutput"}
        try:
            # not below a target though, its frequency follows the target
            below = set().union(*(self.descendants(n) for n in targets if n in self.nodes))
            before = {n: r["freq"] for n, r in evaluate(self.tree, config, use).items() if n in buses - below}
        except ValueError:
            before = {}
        base = self._base(locked)

        def eps(f):
            return max(f * tolerance, f * 1e-9, 1e-6)

        # Upstream targets first, the core before the branches
        # A target is a frequency or a range (lo, hi, aim)
        constraints = [
            {"id": n, "lo": f[0], "hi": f[1], "aim": f[2], "target": True}
            if isinstance(f, (tuple, list))
            else {"id": n, "lo": f - eps(f), "hi": f + eps(f), "aim": f, "target": True}
            for n, f in targets.items()
            if n in self.nodes
        ]
        constraints.sort(key=lambda c: (c["id"] not in self.core, len(self.ancestors(c["id"]))))
        target_list = list(constraints)

        if diagnose and (unmet := self._unreachable(target_list, base, budget)):
            # A target that no path reaches alone needs no search to fail
            return {"ok": False, "config": config, "best": None, "unmet": unmet, "problems": [],
                    "candidates": 0, "timeout": False, "steps": self.steps}  # fmt: skip
        self.memo, self.deadline = {}, time.monotonic() + budget
        best, timeout, candidates = None, False, 0
        # The prescalers below SYSCLK that the search may pick slower than needed, the widest first
        prescalers = (core - set(config)) & self.descendants("SysCLKOutput")
        prescalers = [n for n in prescalers if self.nodes[n]["kind"] == "div"]
        prescalers.sort(key=lambda n: len(self.descendants(n)), reverse=True)

        def faster(found: dict) -> dict:
            """
            The first solution the search finds may divide more than needed, for example, the
            CPU of the STM32H7P by 4 where 2 meets the HCLK limit just as well. Each prescaler
            below SYSCLK takes the smallest factor that still breaks nothing.
            """
            trial, result = found["config"], found["result"]
            for i, name in enumerate(prescalers):
                below = [n for n in prescalers[i + 1 :] if n in self.descendants(name)]
                now = choice_of(self.tree, name, trial)
                for factor in sorted(f for f in factors_of(self.nodes[name]) if f < now):
                    # The prescalers below may have to divide more, the HCLK of the STM32H7P by 2
                    t = settle({**trial, name: _value(factor)}, below)
                    r = t and evaluate(self.tree, t, use)
                    if r and not self.problems(r, target_list)[0]:
                        trial, result = t, r
                        break
            return {**found, "config": trial, "result": result}

        def settle(trial: dict, names: list) -> dict | None:
            """Each prescaler in turn at the smallest factor under which the clocks only it divides break nothing."""
            for i, name in enumerate(names):
                later = set().union(*({n} | self.descendants(n) for n in names[i + 1 :]))
                own = ({name} | self.descendants(name)) - later
                for factor in sorted(factors_of(self.nodes[name])):
                    t = {**trial, name: _value(factor)}
                    r = evaluate(self.tree, t, use)
                    broken = any(r[n].get("used") and r[n].get("errors") for n in own)
                    freq = {c["id"]: r[c["id"]]["freq"] or 0 for c in target_list if c["id"] in own}
                    missed = any(not c["lo"] <= freq[c["id"]] <= c["hi"] for c in target_list if c["id"] in own)
                    if not broken and not missed:
                        trial = t
                        break
                else:
                    return None
            return trial

        ranged = [c for c in target_list if c["hi"] - c["lo"] > c["aim"] * 1e-6]
        best_ok, oks, soft = None, 0, time.monotonic() + budget / 4
        try:
            # A candidate that breaks the limits of a node gets those limits as another
            # constraint and the search restarts, so the solver also fixes prescalers it had no target for
            initial, end = constraints, self.deadline
            for keep in (True, False):
                constraints, kept = initial, False
                # The first phase gets a third of the time, the second the rest
                self.deadline = min(end, time.monotonic() + budget / 3) if keep else end
                try:
                    for _ in range(12):
                        added = False
                        for A in self.combine(constraints, 0, base):
                            candidates += 1
                            trial = {**config, **{k: _value(v) for k, v in A.items()}}
                            result = evaluate(self.tree, trial, use)
                            out, limits = self.problems(result, constraints)
                            if not out:
                                found = {"ok": True, "config": trial, "result": result, "unmet": [], "problems": [],
                                     "candidates": candidates, "steps": self.steps}  # fmt: skip
                                if not ranged:
                                    return faster(found)
                                # A range aims at one end: collect a few solutions, take the closest
                                score = sum(abs(result[c["id"]]["freq"] - c["aim"]) / c["aim"] for c in ranged)
                                if best_ok is None or score < best_ok[0]:
                                    best_ok = (score, found)
                                oks += 1
                                if score < 1e-9 or oks >= 64 or time.monotonic() > soft:
                                    return faster(best_ok[1])
                                continue
                            if not best or len(out) < len(best["problems"]):
                                best = {"config": trial, "result": result, "problems": out}
                            fresh = [lim for lim in limits if not any(c["id"] == lim["id"] for c in constraints)]
                            if fresh:
                                for lim in fresh:
                                    f0 = before.get(lim["id"]) if keep else None
                                    if f0 and lim["lo"] * (1 - 1e-9) <= f0 <= lim["hi"] * (1 + 1e-9):
                                        constraints = constraints + [
                                            {"id": lim["id"], "lo": f0 - eps(f0), "hi": f0 + eps(f0), "aim": f0}
                                        ]
                                        kept = True
                                    else:
                                        aim = min(lim["hi"], max(lim["lo"], result[lim["id"]]["freq"]))
                                        constraints = constraints + [{**lim, "aim": aim}]
                                added = True
                                break
                        if not added:
                            break
                except _Timeout:
                    if not keep:
                        raise
                    kept = True  # out of time keeping the core, try without
                if best_ok or not kept:
                    break
        except _Timeout:
            timeout = True
        if best_ok:
            return faster(best_ok[1])
        # No configuration meets everything: find out which targets are the problem
        unmet = self._unreachable(target_list, base, budget) if diagnose else []
        if not unmet and target_list:
            why = "search limit reached" if timeout else "only by breaking a limit" if best else "the targets conflict"
            unmet.append({"id": None, "why": why})
        return {"ok": False, "config": config, "best": best, "unmet": unmet,
                "problems": best["problems"] if best else [], "candidates": candidates,
                "timeout": timeout, "steps": self.steps}  # fmt: skip


def _value(v) -> str:
    """A setting as `evaluate()` takes it: macros as they are, numbers like `f"{x:g}"` without losing digits."""
    if isinstance(v, str):
        return v
    return str(int(v)) if float(v).is_integer() else repr(float(v))


def solve(tree: dict, targets: dict, config: dict | None = None, **kwargs) -> dict:
    """Shortcut for `Solver(tree).solve(...)`."""
    return Solver(tree).solve(config=config, targets=targets, **kwargs)


def max_performance(tree: dict, config: dict | None = None, locked=(), tolerance: float = 0, budget: float = 2) -> dict:
    """
    Highest SYSCLK from the HSE with every peripheral in use, else the highest with none.
    Every mux upstream of SYSCLK may only pick inputs that come from the HSE, the HSE frequency stays as
    configured, the solver picks the rest and repairs the bus limits. When the maximum is out of reach it
    tries bands of 10 % below it down to half the maximum, and the closest SYSCLK the solver reports.

    :return: The `solve()` result plus `use` (None: all peripherals, []: none) and `core`, the node it maximizes,
             or None without HSE, core clock or result.
    """
    nodes, config = tree["nodes"], dict(config or {})
    # The N6 has no SYSCLK, its core clock is the CPU clock
    core = next((name for name in ("SysCLKOutput", "CpuClockOutput", "AHBOutput") if name in nodes), None)
    # Some limit SYSCLK only per voltage scale, the fastest one counts, the F0 and F7 limit only HCLK
    maximum = None
    for name in (core, "AHBOutput"):
        node = nodes.get(name, {})
        maximum = (
            maximum or node.get("max") or max((v["max"] for v in node.get("limits", ()) if v.get("max")), default=None)
        )
    if not maximum or "HSEOSC" not in nodes:
        return None

    def upstream(name, seen=None):
        seen = set() if seen is None else seen
        if name in seen or name not in nodes:
            return seen
        seen.add(name)
        for i in nodes[name]["inputs"]:
            upstream(i["from"], seen)
        return seen

    # A copy where these muxes lose their other inputs, so the solver cannot pick HSI, MSI or CSI
    restricted = {**tree, "nodes": dict(nodes)}
    for name in upstream(core):
        node = nodes[name]
        hse = [i for i in node["inputs"] if "HSEOSC" in upstream(i["from"])]
        if node["kind"] == "mux" and hse:
            restricted["nodes"][name] = {**node, "inputs": hse}

    # Clock pins (I2S_CKIN, AUDIOCLK, SAI1_EXT, ...) need a signal on the board: no mux picks them
    def pin(name):
        return name in nodes and nodes[name]["kind"] == "varied" and name not in ("HSEOSC", "LSEOSC", "LSIRC")

    for name, node in list(restricted["nodes"].items()):
        pins = [pin(i["from"]) for i in node["inputs"]]
        if node["kind"] == "mux" and any(pins) and not all(pins):
            restricted["nodes"][name] = {**node, "inputs": [i for i in node["inputs"] if not pin(i["from"])]}

    keep = set(locked) | {"HSEOSC"}
    free = {k: v for k, v in config.items() if k in keep or restricted["nodes"].get(k) is nodes.get(k)}
    solver = Solver(restricted)
    # Every peripheral by name, so that the limits gated by their usage flags apply too
    everything = {name for name, node in nodes.items() if node["kind"] == "peripheral"}

    def run(target, use, diagnose=True, budget=budget):
        return solver.solve(free, keep, {core: target}, use, tolerance, budget, diagnose=diagnose)

    def freq(r):
        return r["result"][core]["freq"]

    # The maximum exactly, then bands of 10 % below it as ranges aiming at their top, e.g. 96 MHz in (90, 100]
    # ponytail: fixed bands, the range search takes the best of a few solutions, not the highest in the band
    steps = [maximum * f for f in (1, 0.9, 0.8, 0.7, 0.6, 0.5)]
    ladder = [steps[0], *((lo, hi, hi) for hi, lo in zip(steps, steps[1:]))]
    # A slower SYSCLK with every peripheral beats the fastest with none, e.g. the F411 runs USB only at 96 MHz:
    # the best result without peripherals waits until no step works with every one
    fallback, i, hard = None, 0, False
    while i < len(ladder):
        if not hard:
            # Proving that the maximum misses some peripheral can take long, 2 s in Pyodide for the F411
            if (r := run(ladder[i], everything, diagnose=False, budget=budget / 2 if i == 0 else budget))["ok"]:
                # A round MHz near what a range found, e.g. 168 instead of 167.97 MHz
                if isinstance(ladder[i], tuple):
                    for f in (math.ceil(freq(r) / 1e6) * 1e6, math.floor(freq(r) / 1e6) * 1e6):
                        if f != freq(r) and ladder[i][0] <= f <= ladder[i][1]:
                            if (exact := run(f, everything, diagnose=False))["ok"]:
                                r = exact
                                break
                return {**r, "use": None, "core": core}
            # Out of time proves nothing, but the bands below take as long, e.g. the H723: none from here on
            hard = bool(r.get("timeout")) and i > 0
        if fallback is None:
            if (r := run(ladder[i], []))["ok"]:
                fallback = {**r, "use": [], "core": core}
            # e.g. the C0 reaches only the HSE frequency without a PLL
            closest = next((u.get("closest") for u in r["unmet"] if u["id"] == core), None)
            if closest and closest not in ladder:
                ladder.insert(i + 1, closest)
        if fallback and hard:
            break
        i += 1
    return fallback

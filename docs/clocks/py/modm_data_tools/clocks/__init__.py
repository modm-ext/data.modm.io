# Copyright 2026, Niklas Hauser
# SPDX-License-Identifier: MPL-2.0

"""
# STM32 Clock Solver

Solves frequency targets on the clock trees of `modm_data.cubemx.clock_tree_from_partname`
and generates the modm SystemClock code. Pure Python except `modm_api` and `export`,
so the solver also runs in Pyodide on the clock solver page.
"""

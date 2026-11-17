# Copyright 2026, Niklas Hauser
# SPDX-License-Identifier: MPL-2.0

"""The errors of wrong input, whose message is meant for the user. Pure Python, the clock solver page loads it too."""

# seconds a regex from tool input may take on one text, Python's re would block the shared server for good
TIMEOUT = 2


class UserError(ValueError):
    """Wrong input to a tool, e.g. an unknown device, a value out of range or an invalid regex"""


class UserRegex:
    """A regex from tool input (needs the `regex` package): an invalid one and one that takes longer than TIMEOUT
    seconds on a text are a UserError. The flags are those of `re`, which `regex` shares."""

    # ponytail: the timeout is per text, a pattern just below it on every one of many texts still takes long

    def __init__(self, pattern: str, flags: int = 0):
        import regex

        try:
            self.regex = regex.compile(pattern, flags)
        except regex.error as e:
            raise UserError(f"invalid regex: {e}") from None

    def _run(self, call):
        try:
            return call()
        except TimeoutError:
            raise UserError(f"pattern too slow, simplify it: {self.regex.pattern}") from None

    def search(self, text: str):
        return self._run(lambda: self.regex.search(text, timeout=TIMEOUT))

    def fullmatch(self, text: str):
        return self._run(lambda: self.regex.fullmatch(text, timeout=TIMEOUT))

    def finditer(self, text: str) -> list:
        return self._run(lambda: list(self.regex.finditer(text, timeout=TIMEOUT)))

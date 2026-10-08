#!/usr/bin/env python3
"""myai-calendar: the calendar accounts on a box.

Each person who uses the calendar has an account (a name and a password) that their phone's
calendar app and the myAI calendar app sign in with; nobody sees anyone else's calendars. The
accounts live in one htpasswd file that the calendar server (Radicale) reads; passwords are stored
as SHA-512 crypt hashes, never as text. Python standard library only.

    myai-calendar users                      list the accounts
    myai-calendar add NAME                   add an account (asks for the password twice)
    myai-calendar passwd NAME                change a password
    myai-calendar remove NAME                remove an account (its calendars stay on disk)
    myai-calendar import FILE                add or update accounts from "name password" lines

`add` and `passwd` read the password from standard input instead of asking with --password-stdin.
Removing an account does not delete its calendars: they stay in input/calendar/collection-root/NAME/
until someone removes that folder, and adding the account again brings them back.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import os
import re
import secrets
import sys
import tempfile
from pathlib import Path

# The box sets MYAI_CALENDAR_USERS to the file its calendar server reads (stateDir/calendar/users).
DEFAULT_FILE = Path(os.environ.get("MYAI_CALENDAR_USERS") or "/var/lib/myai/calendar/users")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")
B64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
MIN_PASSWORD = 8


# ---- SHA-512 crypt ("$6$", Ulrich Drepper's SHA-crypt specification) ---------------------------------

def _b64_from_24bit(b2: int, b1: int, b0: int, n: int) -> str:
    w = (b2 << 16) | (b1 << 8) | b0
    out = []
    for _ in range(n):
        out.append(B64[w & 0x3F])
        w >>= 6
    return "".join(out)


_ORDER = [(0, 21, 42), (22, 43, 1), (44, 2, 23), (3, 24, 45), (25, 46, 4), (47, 5, 26), (6, 27, 48),
          (28, 49, 7), (50, 8, 29), (9, 30, 51), (31, 52, 10), (53, 11, 32), (12, 33, 54), (34, 55, 13),
          (56, 14, 35), (15, 36, 57), (37, 58, 16), (59, 17, 38), (18, 39, 60), (40, 61, 19), (62, 20, 41)]


def sha512_crypt(password: str, salt: str | None = None, rounds: int = 5000) -> str:
    """The crypt(3) "$6$" hash of a password, as `openssl passwd -6` and Radicale read it."""
    if salt is None:
        salt = "".join(secrets.choice(B64) for _ in range(16))
    salt_b = salt[:16].encode("ascii")
    key = password.encode("utf-8")
    rounds = max(1000, min(999_999_999, rounds))

    alt = hashlib.sha512(key + salt_b + key).digest()
    a = hashlib.sha512(key + salt_b)
    n = len(key)
    while n > 64:
        a.update(alt)
        n -= 64
    a.update(alt[:n])
    n = len(key)
    while n:
        a.update(alt if n & 1 else key)
        n >>= 1
    da = a.digest()

    dp = hashlib.sha512(key * len(key)).digest()
    p = (dp * (len(key) // 64 + 1))[:len(key)]
    ds = hashlib.sha512(salt_b * (16 + da[0])).digest()
    s = (ds * (len(salt_b) // 64 + 1))[:len(salt_b)]

    c = da
    for i in range(rounds):
        h = hashlib.sha512()
        h.update(p if i & 1 else c)
        if i % 3:
            h.update(s)
        if i % 7:
            h.update(p)
        h.update(c if i & 1 else p)
        c = h.digest()

    encoded = "".join(_b64_from_24bit(c[x], c[y], c[z], 4) for x, y, z in _ORDER)
    encoded += _b64_from_24bit(0, 0, c[63], 2)
    head = "$6$" if rounds == 5000 else f"$6$rounds={rounds}$"
    return f"{head}{salt_b.decode('ascii')}${encoded}"


def verify(password: str, hashed: str) -> bool:
    m = re.match(r"^\$6\$(rounds=(\d+)\$)?([^$]{1,16})\$([./0-9A-Za-z]{86})$", hashed)
    if not m:
        return False
    rounds = int(m.group(2)) if m.group(2) else 5000
    # "rounds=5000$" may be written out or left implicit; the hash itself is what counts.
    return secrets.compare_digest(sha512_crypt(password, m.group(3), rounds).rsplit("$", 1)[1], m.group(4))


# ---- the accounts file -----------------------------------------------------------------------------------

class Accounts:
    def __init__(self, path: Path = DEFAULT_FILE):
        self.path = path

    def read(self) -> list[tuple[str, str]]:
        try:
            text = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return []
        entries = []
        for line in text.splitlines():
            if not line.strip() or line.lstrip().startswith("#") or ":" not in line:
                continue
            name, digest = line.split(":", 1)
            entries.append((name.strip(), digest.strip()))
        return entries

    def names(self) -> list[str]:
        return [name for name, _ in self.read()]

    def write(self, entries: list[tuple[str, str]]) -> None:
        """Replaces the file in one step, keeping its owner, group and mode (the server reads it)."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            st = self.path.stat()
            mode, uid, gid = st.st_mode & 0o7777, st.st_uid, st.st_gid
        except FileNotFoundError:
            mode, uid, gid = 0o640, None, None
        fd, tmp = tempfile.mkstemp(prefix=".users.", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write("# myAI calendar accounts: name:sha512-crypt. Edit with myai-calendar.\n")
                for name, digest in entries:
                    fh.write(f"{name}:{digest}\n")
            os.chmod(tmp, mode)
            if uid is not None and os.geteuid() == 0:
                os.chown(tmp, uid, gid)
            os.replace(tmp, self.path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def set_password(self, name: str, password: str) -> bool:
        """Adds the account or changes its password; True when it was new."""
        check_name(name)
        check_password(password)
        entries = self.read()
        digest = sha512_crypt(password)
        for i, (existing, _) in enumerate(entries):
            if existing == name:
                entries[i] = (name, digest)
                self.write(entries)
                return False
        entries.append((name, digest))
        self.write(entries)
        return True

    def remove(self, name: str) -> bool:
        entries = self.read()
        kept = [(n, d) for n, d in entries if n != name]
        if len(kept) == len(entries):
            return False
        self.write(kept)
        return True


def check_name(name: str) -> None:
    if not NAME_RE.match(name or ""):
        raise ValueError("an account name is 1 to 32 letters, digits, dots, dashes or underscores, starting with a letter or digit")


def check_password(password: str) -> None:
    if len(password or "") < MIN_PASSWORD:
        raise ValueError(f"a password needs at least {MIN_PASSWORD} characters")
    if "\n" in password or "\r" in password:
        raise ValueError("a password cannot contain a line break")


def parse_import(text: str) -> list[tuple[str, str]]:
    """Accounts from lines of "name password" or "name:password"; blank lines and # comments skipped."""
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if ":" in line.split()[0]:
            name, password = line.split(":", 1)
        else:
            parts = line.split(None, 1)
            if len(parts) != 2:
                raise ValueError(f"no password given for {parts[0]!r}")
            name, password = parts
        out.append((name.strip(), password.strip()))
    return out


# ---- command line -------------------------------------------------------------------------------------------

def read_password(stdin: bool) -> str:
    if stdin:
        return sys.stdin.readline().rstrip("\r\n")
    first = getpass.getpass("Password: ")
    second = getpass.getpass("Password again: ")
    if first != second:
        raise ValueError("the two passwords are not the same")
    return first


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="myai-calendar", description="Calendar accounts on this myAI box.")
    ap.add_argument("--file", type=Path, default=DEFAULT_FILE, help="the accounts file the calendar server reads")
    sub = ap.add_subparsers(dest="command", required=True)
    sub.add_parser("users", help="list the accounts")
    for command in ("add", "passwd"):
        p = sub.add_parser(command)
        p.add_argument("name")
        p.add_argument("--password-stdin", action="store_true")
    p = sub.add_parser("remove")
    p.add_argument("name")
    p = sub.add_parser("import")
    p.add_argument("source", type=Path)
    args = ap.parse_args(argv)
    accounts = Accounts(args.file)
    try:
        if args.command == "users":
            names = accounts.names()
            print("\n".join(names) if names else "no calendar accounts yet: add one with  myai-calendar add NAME")
        elif args.command == "add":
            if args.name in accounts.names():
                raise ValueError(f"{args.name} already has an account; change its password with  myai-calendar passwd {args.name}")
            accounts.set_password(args.name, read_password(args.password_stdin))
            print(f"added {args.name}")
        elif args.command == "passwd":
            if args.name not in accounts.names():
                raise ValueError(f"there is no account {args.name}")
            accounts.set_password(args.name, read_password(args.password_stdin))
            print(f"password changed for {args.name}")
        elif args.command == "remove":
            if not accounts.remove(args.name):
                raise ValueError(f"there is no account {args.name}")
            print(f"removed {args.name}; its calendars stay on disk until their folder is deleted")
        elif args.command == "import":
            for name, password in parse_import(args.source.read_text(encoding="utf-8")):
                new = accounts.set_password(name, password)
                print(f"{'added' if new else 'updated'} {name}")
    except ValueError as exc:
        print(f"myai-calendar: {exc}", file=sys.stderr)
        return 2
    except PermissionError as exc:
        print(f"myai-calendar: cannot change {exc.filename or args.file}: run it as root (sudo myai-calendar ...)", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

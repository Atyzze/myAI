import io
import os
import stat
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import myai_calendar as cal  # noqa: E402


class HashTests(unittest.TestCase):
    def test_the_sha_crypt_specification_vectors(self):
        # Ulrich Drepper's SHA-crypt specification, the SHA-512 test vectors.
        self.assertEqual(cal.sha512_crypt("Hello world!", "saltstring"),
                         "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1")
        self.assertEqual(cal.sha512_crypt("Hello world!", "saltstringsaltstring", rounds=10000),
                         "$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.")
        # The default 5000 rounds are written without "rounds=5000$", as openssl passwd -6 does;
        # a hash that spells them out still verifies.
        spelled = "$6$rounds=5000$toolongsaltstrin$lQ8jolhgVRVhY4b5pZKaysCLi0QBxGoNeKQzQ3glMhwllF7oGDZxUhx1yxdYcz/e1JSbq3y6JMxxl8audkUEm0"
        self.assertEqual(cal.sha512_crypt("This is just a test", "toolongsaltstring", rounds=5000), spelled.replace("rounds=5000$", ""))
        self.assertTrue(cal.verify("This is just a test", spelled))

    def test_long_passwords_and_unicode(self):
        long = "x" * 200 + "é€"
        hashed = cal.sha512_crypt(long)
        self.assertTrue(hashed.startswith("$6$") and len(hashed.split("$")[2]) == 16)
        self.assertTrue(cal.verify(long, hashed))
        self.assertFalse(cal.verify(long[:-1], hashed))
        self.assertFalse(cal.verify("anything", "plain-text-not-a-hash"))

    def test_a_new_salt_each_time(self):
        self.assertNotEqual(cal.sha512_crypt("same password"), cal.sha512_crypt("same password"))


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.file = Path(self.td.name) / "calendar" / "users"
        self.accounts = cal.Accounts(self.file)

    def tearDown(self):
        self.td.cleanup()

    def test_add_change_and_remove(self):
        self.assertTrue(self.accounts.set_password("anna", "first-password"))
        self.assertTrue(self.accounts.set_password("bob", "bobs-password"))
        self.assertFalse(self.accounts.set_password("anna", "second-password"))
        entries = dict(self.accounts.read())
        self.assertEqual(sorted(entries), ["anna", "bob"])
        self.assertTrue(cal.verify("second-password", entries["anna"]))
        self.assertFalse(cal.verify("first-password", entries["anna"]))
        self.assertNotIn("second-password", self.file.read_text())
        self.assertTrue(self.accounts.remove("anna"))
        self.assertFalse(self.accounts.remove("anna"))
        self.assertEqual(self.accounts.names(), ["bob"])

    def test_the_file_keeps_its_mode_when_rewritten(self):
        self.accounts.set_password("anna", "first-password")
        os.chmod(self.file, 0o640)
        self.accounts.set_password("bob", "bobs-password")
        self.assertEqual(stat.S_IMODE(self.file.stat().st_mode), 0o640)
        self.assertEqual(list(self.file.parent.glob(".users.*")), [], "no temporary file is left behind")

    def test_names_and_passwords_that_are_refused(self):
        for name in ["", "-dash", "has space", "a/b", "x" * 33, "colon:name"]:
            with self.assertRaises(ValueError, msg=name):
                self.accounts.set_password(name, "long-enough-password")
        with self.assertRaises(ValueError):
            self.accounts.set_password("anna", "short")
        with self.assertRaises(ValueError):
            self.accounts.set_password("anna", "line\nbreak-password")
        self.assertFalse(self.file.exists())

    def test_import_lines(self):
        entries = cal.parse_import("# family\nanna  correct horse battery\nbob:pass:with:colons\n\n")
        self.assertEqual(entries, [("anna", "correct horse battery"), ("bob", "pass:with:colons")])
        with self.assertRaises(ValueError):
            cal.parse_import("carol\n")


class CommandTests(unittest.TestCase):
    def run_cli(self, args, stdin=""):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch("sys.stdin", io.StringIO(stdin)), redirect_stdout(out), redirect_stderr(err):
            code = cal.main(args)
        return code, out.getvalue(), err.getvalue()

    def test_the_commands(self):
        with tempfile.TemporaryDirectory() as td:
            users = str(Path(td) / "users")
            self.assertIn("no calendar accounts yet", self.run_cli(["--file", users, "users"])[1])
            self.assertEqual(self.run_cli(["--file", users, "add", "anna", "--password-stdin"], "anna-password\n")[0], 0)
            code, _, err = self.run_cli(["--file", users, "add", "anna", "--password-stdin"], "other-password\n")
            self.assertEqual(code, 2)
            self.assertIn("already has an account", err)
            self.assertEqual(self.run_cli(["--file", users, "passwd", "anna", "--password-stdin"], "new-anna-password\n")[0], 0)
            self.assertEqual(self.run_cli(["--file", users, "passwd", "nobody", "--password-stdin"], "whatever-password\n")[0], 2)
            source = Path(td) / "calendar-users.txt"
            source.write_text("bob bobs-password\nanna third-password\n")
            code, out, _ = self.run_cli(["--file", users, "import", str(source)])
            self.assertEqual((code, out.split("\n")[:2]), (0, ["added bob", "updated anna"]))
            self.assertEqual(self.run_cli(["--file", users, "users"])[1].split(), ["anna", "bob"])
            self.assertEqual(self.run_cli(["--file", users, "remove", "bob"])[0], 0)
            self.assertIn("stay on disk", self.run_cli(["--file", users, "remove", "anna"])[1])

    def test_the_box_tells_it_where_the_accounts_are(self):
        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / "elsewhere" / "users"
            with mock.patch.dict(os.environ, {"MYAI_CALENDAR_USERS": str(target)}):
                import importlib
                reloaded = importlib.reload(cal)
                self.assertEqual(reloaded.DEFAULT_FILE, target)
            importlib.reload(cal)


if __name__ == "__main__":
    unittest.main()

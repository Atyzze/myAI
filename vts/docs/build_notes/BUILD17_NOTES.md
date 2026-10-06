# VTS Build 17

Build 17 fixes the installation audit trail introduced in build 16, which was
written to the wrong directory, and makes it reliable for interrupted runs.

- the audit log is now written to `/var/log/install.log`; build 16 wrote to the
  misspelled `/var/logs/install.log`, and its tests asserted that path, so the
  release gate passed while nothing reached `/var/log`;
- the installer no longer runs `install -d -m 0755` and `chmod 0640` on every run:
  those commands rewrite the mode of objects that already exist, and against
  `/var/log` they would have changed host policy (Ubuntu ships it as
  `0775 root:syslog`); only a missing directory or file is created, and existing
  ones keep their owner and mode;
- the first `install` or `update` on a host that ran build 16 appends the old
  `/var/logs/install.log` lines unchanged to `/var/log/install.log`, records
  `event=legacy_audit_imported` with the old file's SHA-256, deletes the old file
  and removes `/var/logs/` when it is empty; a file that is not entirely VTS audit
  lines is left untouched with a warning, and the SHA-256 marker prevents a second
  import if cleanup is interrupted;
- the log writer is now `tee -a -i`; in build 16 Ctrl-C also reached and killed
  the writer, so an interrupted run lost its failure record and `session_end` and
  the console showed `lost sys.stderr`; an interrupted run now records the
  interrupted command's final output, `exit=<code> interrupted=true`, a failure
  line and `event=session_end exit_code=130`, and the installer exits 130;
- console streams are restored even when the log writer fails, so errors are
  still reported;
- every `install` and `update` run prints the audit log path and session ID;
- replaces the string-only audit tests with tests that write through the real
  `tee` sink: session content, file and directory permissions, append-only
  behaviour, build 16 history import, foreign files and both Ctrl-C paths; the
  audit test class was also defined after `unittest.main()` in
  `tests/test_installer.py`, so running that file directly skipped it;
- README, OPERATIONS and PRIVACY document the corrected path, when recording
  starts, and the build 16 history import.

Release gate: 59 tests passed.

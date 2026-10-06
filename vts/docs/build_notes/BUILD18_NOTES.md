# VTS Build 18

Build 18 puts the installation audit log where it was meant to be: a folder inside
the VTS directory, next to `install.py`.

- `install` and `update` runs append to `var/log/install.log` inside the VTS
  directory; builds 16 and 17 wrote to the system paths `/var/logs/install.log`
  and `/var/log/install.log`, which misread the requested location;
- the log is opened in append mode by the installing user: no sudo, no `tee`
  subprocess, and nothing under the system `/var/log` is created, read or changed;
- the folders are created when missing and a new log file gets mode `0640`;
- removes build 17's system-path handling (preserving `/var/log` permissions and
  importing build 16's `/var/logs/install.log`), which no longer applies; build 18
  leaves any such system files untouched;
- keeps build 17's interrupted-run handling: Ctrl-C is recorded with the
  interrupted command's final output and `event=session_end exit_code=130`, where
  build 16 lost the end of the session;
- `var/` is excluded from release archives and ignored by git, so install logs
  never ship;
- each run still prints the audit log path and session ID;
- tests write real sessions to a temporary `var/log/install.log` and cover folder
  creation, file mode, append-only behaviour, Ctrl-C handling and the release
  exclusion.

Release gate: 56 tests passed.

# VTS Build 19

Build 19 shows progress during long installer steps, so the terminal no longer
looks hung while nothing else is printed.

- model downloads show a live status line with downloaded size, percentage of the
  expected total, speed and elapsed time; the expected total comes from the same
  Hugging Face model lookup the download already performs;
- dependency installs and the wait for `/healthz` show elapsed time the same way;
- on a terminal the line is redrawn in place and erased before any other output;
  without a terminal a plain status line is printed every 30 seconds instead;
- status lines are terminal only and never written to `var/log/install.log`;
- adds tests for in-place redraw and erasing, the size and percentage text, plain
  output without a terminal, and the wiring of the three long steps.

Release gate: 60 tests passed.

# VTS build 11

Build 11 fixes the uv wheel-only dependency-install invocation exposed by Build 10.

Changes:

- removes the invalid combination of `--only-binary :all:` and `--no-build`;
- uses `uv pip install --only-binary :all:` as the single source-build prohibition,
  matching uv's own CLI contract (the option already means wheels only / no sdist
  builds);
- keeps the existing policy unchanged: if a dependency has no compatible wheel,
  installation fails rather than compiling it locally;
- adds an installer regression contract asserting the exact wheel-only argument
  tuple and forbidding `--no-build` from the installer source;
- updates operations documentation to explain why the redundant flag must not be
  reintroduced.

Gate: 20 tests passed

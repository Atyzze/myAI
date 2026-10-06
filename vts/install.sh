#!/bin/sh
# Compatibility shim. All installer logic lives in install.py.
exec python3 "$(dirname "$0")/install.py" "$@"

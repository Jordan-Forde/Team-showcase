#!/bin/sh
# Start Team Showcase on macOS/Linux. Uses python3 unless PYTHON is set.
cd "$(dirname "$0")" || exit 1
exec "${PYTHON:-python3}" server.py

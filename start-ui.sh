#!/usr/bin/env sh
# LABraDT UI: create the virtual environment once, then start the UI controller on http://localhost:8090
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "Creating virtual environment ..."
  python3 -m venv .venv
  .venv/bin/python -m pip install -r requirements.txt paho-mqtt
fi
echo "Starting LABraDT UI on http://localhost:8090  (Ctrl+C to stop)"
exec .venv/bin/python app.py

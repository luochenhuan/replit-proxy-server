#!/bin/bash
# Starts the local Ollama server (if not already running) and then the proxy.
set -e

if ! curl -s http://127.0.0.1:11434/api/version > /dev/null 2>&1; then
  ollama serve > /tmp/ollama.log 2>&1 &
  for i in $(seq 1 30); do
    curl -s http://127.0.0.1:11434/api/version > /dev/null 2>&1 && break
    sleep 1
  done
fi

exec npm start

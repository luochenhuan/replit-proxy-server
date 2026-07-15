#!/bin/bash
# Starts the local Ollama server (if not already running), ensures the required
# models are present, and then starts the proxy.
set -e

# This script is the explicit local mode. Ignore cloud configuration that may
# have been inherited from a shell or synced into a development environment.
export OLLAMA_BASE_URL=http://127.0.0.1:11434
unset OLLAMA_API_KEY

if [[ "${1:-}" == "--seed" ]]; then
  npm run seed
fi

if ! curl -s http://127.0.0.1:11434/api/version > /dev/null 2>&1; then
  ollama serve > /tmp/ollama.log 2>&1 &
  for i in $(seq 1 30); do
    curl -s http://127.0.0.1:11434/api/version > /dev/null 2>&1 && break
    sleep 1
  done
fi

# Ensure the models the e2e suite and demo dashboards rely on are available.
# Pulling is a one-time cost; after the first run this check is fast.
for model in llama3.2:1b moondream; do
  if ! ollama list | grep -q "^${model}\b"; then
    ollama pull "$model"
  fi
done

exec npm start

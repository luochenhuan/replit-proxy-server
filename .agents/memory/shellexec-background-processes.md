---
name: Background processes across ShellExec calls
description: Why backgrounding a long-running process (e.g. a local Ollama server) inside a ShellExec call doesn't work, and what to do instead.
---

Each ShellExec call appears to run in a session that gets torn down (along with
its child/background processes) once the call returns — `command &`, `nohup
... &`, and even `setsid nohup ... & disown` all got killed by the time the
next ShellExec call ran and checked on them.

**Why:** confirmed empirically while setting up a local Ollama server: the
process answered curl checks within the same call, but was gone (no process,
connection refused) in the very next call, despite disowning/setsid.

**How to apply:** for anything that needs to keep running (dev servers,
local model servers, daemons), start it via a Replit workflow
(`configureWorkflow`), not by backgrounding it in a ShellExec command. Workflows
are supervised long-running processes and survive between tool calls. It's fine
to background something transiently *within* a single ShellExec call to run a
few sequential commands against it (e.g. pull models) before the call ends.

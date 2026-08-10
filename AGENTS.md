# Working on this repo

This is a dependency-free Node starter for the AssemblyAI Voice Agent API. `server.mjs` picks one of five complete one-file web apps in `agents/` via the `USE_CASE` env var. Each agent file serves a small browser app, mints short-lived session tokens server-side, and streams microphone audio to a real-time agent with tool calling.

## Run

```sh
ASSEMBLYAI_API_KEY=<key> USE_CASE=receptionist node server.mjs
```

Node 18+, no installs. `PORT` is respected (defaults to 3000 and hops if busy). Use cases: `receptionist`, `general`, `interview-screener`, `appointment-booking`, `order-taking`.

## Architecture, per agent file

- The `SESSION` object at the top is the whole agent definition: `system_prompt`, `greeting`, `input` (format, `keyterms`, optional `turn_detection`), `output` (voice, format), `tools`.
- `/token` proxies `GET https://agents.assemblyai.com/v1/token?product=voice_agent&expires_in_seconds=60` with the server-side API key. The browser only ever sees these short-lived tokens.
- The client connects to `wss://agents.assemblyai.com/v1/ws?token=...`, sends `session.update` first, then streams base64 PCM16 at 24 kHz as `input.audio` and plays `reply.audio` frames back.
- `TOOL_RESULTS` holds stubbed tool answers with simulated latency. A real integration replaces the stub lookup inside the `tool.call` handler with a backend call, then sends `tool.result` with `call_id` and a JSON-string `result`.

## Rules

- Voices: only use IDs from the documented catalog at https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices. Never invent or suggest undocumented voice IDs.
- Never move the API key into client code, commit it, or log it. It belongs in the `ASSEMBLYAI_API_KEY` env var.
- Only use documented endpoints. Session configuration reference: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/create-agent. Tools: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/overview. Turn detection: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/turn-detection-and-interruptions.
- Keep each agent a single self-contained file; that is the point of the starter.
- Voice-first prompt style: short spoken sentences, no visual formatting references, no exclamation marks.

## Deploying

`render.yaml` and `railway.json` are wired for one-click deploys; both platforms set `PORT` and prompt for `ASSEMBLYAI_API_KEY`. Anyone with the deployed URL runs sessions billed to that key.

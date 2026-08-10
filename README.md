# Voice Agent Starter

A deployable voice agent built on the [AssemblyAI Voice Agent API](https://www.assemblyai.com/docs/voice-agents/voice-agent-api). One Node process, no dependencies: it serves a small web app, mints short-lived session tokens server-side, and streams your microphone to a real-time agent with tool calling.

Pick a use case with the `USE_CASE` env var:

| USE_CASE | Agent |
| --- | --- |
| `receptionist` (default) | Inbound receptionist for a dental practice |
| `appointment-booking` | Salon booking with availability checks |
| `order-taking` | Pizza orders with a read-back total |
| `interview-screener` | Structured phone screen |
| `general` | Open-ended assistant, the blank canvas |

## Deploy

You need an [AssemblyAI API key](https://www.assemblyai.com/dashboard). Render prompts for it during setup; it stays server-side.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/dan-ince-aai/voice-agent-starter)

Railway deploys published templates rather than repo links; publish this repo as a template from your Railway workspace to get a button for it.

Once it's live, open the URL and start the call. Share the link with anyone; they talk to your agent from the browser, and your API key never reaches the page.

## Run locally

```sh
ASSEMBLYAI_API_KEY=your-key USE_CASE=receptionist node server.mjs
```

Then open http://localhost:3000.

## Make it yours

Each agent in `agents/` is a single readable file. Edit the `SESSION` object at the top for the prompt, greeting, voice, keyterms, and tools, then redeploy. The full session reference lives in the [API docs](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/create-agent).

## A note on cost

Anyone with your deployed URL can start sessions billed to your API key. Share it with friends and colleagues, not the whole internet; rotate the key from the dashboard if a link gets away from you.

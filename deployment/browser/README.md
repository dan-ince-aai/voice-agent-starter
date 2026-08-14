# Browser

Serves a page with a call button. Useful for iterating on an agent before putting it on a phone number.

## 1. Publish an agent

```sh
AGENT=http-tools npm run publish
```

## 2. Run it

```sh
npm start
```

Open http://localhost:3000 and start the call.

## 3. Iterate

Edit the file in [agents/](../../agents/), run `npm run publish`, and start another call. When the agent behaves the way you want, see [deployment/telephony](../telephony/).

---

## What it does

Publishes `agents/<AGENT>.jsonc` on startup if it has no id yet, so a fresh clone works with only an API key.

`GET /token` proxies AssemblyAI's token endpoint using your key and returns a 60 second session token. The key is never sent to the page.

The page streams the microphone as 24 kHz PCM16 over `wss://agents.assemblyai.com/v1/ws`, plays the reply back, and discards queued audio when you interrupt. Capture and playback each run in their own AudioContext with a resampling worklet, so a browser that refuses to open a context at 24 kHz still sounds right.

The side pane has two tabs. Events lists every websocket frame in both directions, with audio runs collapsed into counts. Agent shows the published agent as the API stored it, read only, served by `GET /agent`. Tool header values and LLM keys are stripped from that response, but the system prompt is in it, so on a public deployment anyone opening the page can read it.

The session message contains only `{ agent_id }`. Prompt, voice, tools and turn detection are read from the stored agent, which is why the browser and the phone behave the same.

## Environment

| | |
| --- | --- |
| `ASSEMBLYAI_API_KEY` | Required. Stays in this process. |
| `AGENT` | Which file in `agents/` to serve. Defaults to `minimal`. |
| `AGENT_ID_<NAME>` | The id `npm run publish` saved for that file. Connected to as it is. |
| `AGENT_ID` | Overrides the per-file keys, for serving one specific agent. |
| `PORT` | Defaults to 3000, moves to the next free port if taken. |

## Editing the page

Everything is in [server.mjs](server.mjs). The client is the `clientApp` function, stringified and served as `/app.js`, so there is no build step. Save and refresh.

## Hosting

`render.yaml` is configured for one-click deploys. Render prompts for `ASSEMBLYAI_API_KEY` during Blueprint creation, since that is the only variable marked `sync: false`, and sets `PORT` itself. `AGENT` and `AGENT_ID` arrive with defaults and are editable under Environment on the service.

With no id set the service publishes `AGENT` on boot and updates the agent of that name on later restarts, so restarts do not pile up duplicate agents. Setting `AGENT_ID` to the id from your `.env` is still better: the deployment then serves the same agent you tested locally.

Anyone with the URL can start sessions billed to your key.

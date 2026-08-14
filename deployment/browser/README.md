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

Publishes `agents/<AGENT>.jsonc` on startup if `AGENT_ID` is unset, so a fresh clone works with only an API key.

`GET /token` proxies AssemblyAI's token endpoint using your key and returns a 60 second session token. The key is never sent to the page.

The page streams the microphone as 24 kHz PCM16 over `wss://agents.assemblyai.com/v1/ws`, plays the reply back, and discards queued audio when you interrupt.

The session message contains only `{ agent_id }`. Prompt, voice, tools and turn detection are read from the stored agent, which is why the browser and the phone behave the same.

## Environment

| | |
| --- | --- |
| `ASSEMBLYAI_API_KEY` | Required. Stays in this process. |
| `AGENT_ID` | Connect to this agent as it is. Written by `npm run publish`. |
| `AGENT` | Which file in `agents/` to publish when `AGENT_ID` is unset. Defaults to `minimal`. |
| `PORT` | Defaults to 3000, moves to the next free port if taken. |

## Editing the page

Everything is in [server.mjs](server.mjs). The client is the `clientApp` function, stringified and served as `/app.js`, so there is no build step. Save and refresh.

## Hosting

`render.yaml` is configured for one-click deploys. Set `AGENT_ID` there as well, so the deployment connects to your published agent rather than creating its own. Anyone with the URL can start sessions billed to your key.

# Browser

A page with a call button. Where you shape the agent before it goes on a phone number.

## 1. Publish an agent

```sh
AGENT=http-tools npm run publish
```

## 2. Run it

```sh
npm start
```

Open http://localhost:3000 and hit the call button.

## 3. Iterate

Edit the file in [agents/](../../agents/), `npm run publish`, call again. When it sounds right → [deployment/telephony](../telephony/).

---

## What it does

- Publishes `agents/<AGENT>.jsonc` on boot if `AGENT_ID` isn't set, so a fresh clone works with just a key.
- `GET /token` proxies AssemblyAI's token endpoint with your key and returns a 60-second session token. The key never reaches the page.
- Streams the mic as 24 kHz PCM16 over `wss://agents.assemblyai.com/v1/ws`, plays the reply back, and drops queued audio the moment you interrupt.

The session sends nothing but `{ agent_id }` — prompt, voice, tools and turn detection all live on the stored agent. That's why the browser and the phone behave identically.

## Env

| | |
| --- | --- |
| `ASSEMBLYAI_API_KEY` | Required. Stays in this process. |
| `AGENT_ID` | Connect to this agent as-is. Written by `npm run publish`. |
| `AGENT` | Which file in `agents/` to publish when `AGENT_ID` is unset. Default `minimal`. |
| `PORT` | Default 3000, hops if busy. |

## Editing the page

It's one file: [server.mjs](server.mjs). The client is the `clientApp` function, stringified and served as `/app.js` — no build step. Save and refresh.

## Hosting it

`render.yaml` and `railway.json` are wired up. Set `AGENT_ID` there too, so the deploy connects to your published agent instead of creating its own copy. Anyone with the URL can start sessions billed to your key.

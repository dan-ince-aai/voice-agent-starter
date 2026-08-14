<img src="assemblyai.png" width="500"/>

---

[![Voice Agent API](https://img.shields.io/badge/docs-Voice%20Agent%20API-2545E6)](https://www.assemblyai.com/docs/voice-agents/voice-agent-api)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)](package.json)
[![AssemblyAI Twitter](https://img.shields.io/twitter/follow/AssemblyAI?label=%40AssemblyAI&style=social)](https://twitter.com/AssemblyAI)
[![AssemblyAI YouTube](https://img.shields.io/youtube/channel/subscribers/UCtatfZMf-8EkIwASXM4ts0A)](https://www.youtube.com/@AssemblyAI)

# AssemblyAI Voice Agent Starter for JS

Voice agents defined as JSON files. Publish one to your AssemblyAI account, then talk to it in a browser tab or by calling a phone number.

Each file in [agents/](agents/) is the request body for `POST /v1/agents`. The starter sends it unchanged, saves the agent ID it gets back to `.env`, and both deployments connect using that ID. Built on the [AssemblyAI Voice Agent API](https://www.assemblyai.com/products/voice-agent-api). Node 18 or later, no dependencies.

There is a [Python version of this repo](https://github.com/dan-ince-aai/voice-agent-starter-python) with the same agents and the same steps.

## Quickstart

### 1. Clone

```sh
git clone https://github.com/dan-ince-aai/voice-agent-starter-js
cd voice-agent-starter-js
cp .env.example .env
```

### 2. Add your key

From [assemblyai.com/dashboard/api-keys](https://www.assemblyai.com/dashboard/api-keys):

```sh
# .env
ASSEMBLYAI_API_KEY=your_key_here
```

### 3. Publish an agent

```sh
npm run publish                       # agents/minimal.jsonc
# AGENT=http-tools npm run publish    # or any other file in agents/
```

Writes `AGENT_ID` back to `.env`. Later runs update that agent instead of creating another.

### 4. Talk to it

```sh
npm start
```

Open http://localhost:3000 and start the call.

### 5. Put it on a phone number

```sh
# .env
TWILIO_ACCOUNT_SID=AC...                          # console.twilio.com, top of the page
TWILIO_AUTH_TOKEN=your_token_here                 # same place, hidden until you click it
TWILIO_PHONE_NUMBER=+15551234567                  # a number already in your account, E.164
TWILIO_TRUNK_DOMAIN=acme-agent.pstn.twilio.com    # a name you invent, must end .pstn.twilio.com
```

The trunk domain does not exist yet. You are naming the SIP trunk that gets created for you, and the name has to be unique across all of Twilio, so put something specific to you in front of `.pstn.twilio.com`. The phone number does have to exist already: buy one under Phone Numbers in the Twilio console first.

```sh
npm run phone
```

This creates the trunk, routes it to AssemblyAI, attaches your number to it, and binds the agent. Then call the number. Details in [deployment/telephony](deployment/telephony/).

---

## Core examples

Nine agent files. Four demonstrate a parameter, five demonstrate an integration.

| `AGENT=` | Demonstrates | Requires |
| --- | --- | --- |
| [`minimal`](agents/minimal.jsonc) | the three required fields, and the defaults applied to the rest | |
| [`keyterms`](agents/keyterms.jsonc) | biasing transcription toward names and jargon | |
| [`turn-taking`](agents/turn-taking.jsonc) | silence thresholds and interruption handling | |
| [`byo-llm`](agents/byo-llm.jsonc) | Claude through the AssemblyAI gateway, or your own endpoint | |
| [`http-tools`](agents/http-tools.jsonc) | tools that AssemblyAI calls on the agent's behalf | |
| [`exa-search`](agents/exa-search.jsonc) | web search during a call | `EXA_API_KEY` |
| [`airtable-crm`](agents/airtable-crm.jsonc) | reading a caller record and writing one back | `AIRTABLE_*` |
| [`cal-booking`](agents/cal-booking.jsonc) | checking availability, then booking a slot | `CAL_*` |
| [`dtmf`](agents/dtmf.jsonc) | PCI compliance: card entry on the keypad, never in the transcript, the logs or the model | `DTMF_WEBHOOK_URL` |

```sh
AGENT=exa-search npm run publish
npm start
```

To write your own, copy the closest file: `cp agents/http-tools.jsonc agents/my-agent.jsonc`. Every field is commented, with a link to the documentation page that defines it.

## Where it answers

| | | |
| --- | --- | --- |
| [Browser](deployment/browser/) | `npm start` | Serves a page with a call button and mints session tokens. The API key stays on the server. |
| [Phone](deployment/telephony/) | `npm run phone` | Configures a Twilio SIP trunk and attaches the agent to your number. |

Twilio passes the call to AssemblyAI over SIP, so nothing in this repo sits in the audio path.

## Hosting the browser app

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/dan-ince-aai/voice-agent-starter-js)

Render reads [render.yaml](render.yaml) and prompts for exactly one value, `ASSEMBLYAI_API_KEY`, because that is the only variable marked `sync: false`. It sets `PORT` itself. The other two arrive with defaults you can change under Environment on the service:

| Variable | Default | What it does |
| --- | --- | --- |
| `ASSEMBLYAI_API_KEY` | prompted | Stays on the server. Never sent to the page. |
| `AGENT` | `minimal` | Which `agents/<name>.jsonc` the service publishes when it boots. |
| `AGENT_ID` | empty | Paste the id from your `.env` to connect to an agent you already published. |

Leaving `AGENT_ID` empty is fine. The service publishes `AGENT` on boot, and on later restarts it updates the agent of that name rather than creating another one. Setting it is still better, since the deployment then uses the same agent you tested locally and your phone number answers with.

Anyone with the URL can start sessions billed to that key.

## How it works

```
agents/exa-search.jsonc     body of POST /v1/agents
        + .env              the ${VARS} it references
           │
           ▼  npm run publish
        AGENT_ID
           ├──  npm start        browser tab
           └──  npm run phone    phone number
```

The first publish sends `POST /v1/agents` and stores the returned ID in `.env`. With `AGENT_ID` set, later publishes send `PUT /v1/agents/{id}`, so the browser tab and the phone number both pick up the change on the next call.

Values written as `${VAR}` anywhere in an agent file are substituted at publish time from `.env`, or from `agents/<name>.env` for credentials only one agent uses. Both files are gitignored, so the JSON can be committed.

## Build with AI coding agents

This repo includes [AGENTS.md](AGENTS.md), which Claude Code, Cursor and Copilot read for its conventions. The Voice Agent API changes, so point coding tools at the current documentation rather than letting them work from memory:

> Always fetch https://assemblyai.com/docs/llms.txt before writing AssemblyAI code. The API has changed, do not rely on memorized parameter names.

```sh
claude mcp add --transport http --scope user assemblyai-docs https://mcp.assemblyai.com/docs
npx skills add AssemblyAI/assemblyai-skill --global
```

See [Build with AI tools](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/build-with-ai-tools) and [Coding agent prompts](https://www.assemblyai.com/docs/coding-agent-prompts).

## Voice Agent API

Product: [Voice Agent API](https://www.assemblyai.com/products/voice-agent-api) · [Pricing](https://www.assemblyai.com/pricing) · [Dashboard](https://www.assemblyai.com/dashboard)

Start here: [Documentation](https://www.assemblyai.com/docs/voice-agents/voice-agent-api) · [Create an agent](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/create-agent) · [Manage agents](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/manage-agents) · [Prompting guide](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/prompting-guide) · [Best practices](https://www.assemblyai.com/docs/voice-agents/best-practices)

Configuration: [Voices](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices) · [Greeting](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/greeting) · [Turn detection](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/turn-detection-and-interruptions) · [Keyterms](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/transcription-prompt) · [Languages](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/supported-languages) · [Noise suppression](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/noise-suppression) · [Custom LLM](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-your-own-llm)

Tools: [Overview](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/overview) · [HTTP tools](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/http-tools) · [Client-side tools](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/client-side-tools)

Deployment: [Deploy](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/deploy) · [Browser integration](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/browser-integration) · [Connect to Twilio](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-to-twilio) · [Use your own number](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/twilio-own-number) · [Webhooks](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/webhooks)

Reference: [Session configuration](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/session-configuration) · [Events](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference) · [Message sequence](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/message-sequence) · [Session history](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/session-history) · [Troubleshooting](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/troubleshooting)

## Cost

Sessions are billed to the API key that published the agent. Anyone with the deployed URL or the phone number can start a session on that key.

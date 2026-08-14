# Voice Agent Starter

An agent is one JSON file. Test it in a browser tab, then put it on a real phone number.

Node 18+, no dependencies. Built on the [AssemblyAI Voice Agent API](https://www.assemblyai.com/docs/voice-agents/voice-agent-api).

## 1. Clone

```sh
git clone https://github.com/dan-ince-aai/voice-agent-starter
cd voice-agent-starter
```

## 2. Add your key

```sh
cp .env.example .env
```

Put your key from [assemblyai.com/dashboard](https://www.assemblyai.com/dashboard) in `ASSEMBLYAI_API_KEY`.

## 3. Pick an agent

Set `AGENT=` in `.env` to any file in [agents/](agents/) — [the lineup](#the-lineup) is below — then:

```sh
npm run publish
```

Creates the agent and writes `AGENT_ID` back to `.env`. That pair, the file plus the id, is your agent.

## 4. Test it in the browser

```sh
npm start
```

Open localhost:3000 and hit the call button. Edit the agent file, `npm run publish` again, call again — that's the loop.

## 5. Put it on a phone number

```sh
npm run phone
```

Add your Twilio credentials to `.env` first — [deployment/telephony](deployment/telephony/) walks through it. Twilio hands the call straight to AssemblyAI over SIP, so there's no media server, no bridge and no webhook to host.

---

## The lineup

One file per idea, in [agents/](agents/).

| `AGENT=` | Shows | Needs |
| --- | --- | --- |
| `minimal` | the three required fields | — |
| `keyterms` | hard words transcribed right | — |
| `turn-taking` | when your turn ends, interruptions | — |
| `byo-llm` | Claude via the AssemblyAI gateway, or your own endpoint | — |
| `http-tools` | tools AssemblyAI calls for you | — |
| `exa-search` | live web search | `EXA_API_KEY` |
| `airtable-crm` | look the caller up, log the call | `AIRTABLE_*` |
| `cal-booking` | check availability, book the slot | `CAL_*` |
| `dtmf` | keypad input, hidden from the transcript and the model | `DTMF_WEBHOOK_URL` |

## How it fits together

```
agents/exa-search.jsonc     body of POST /v1/agents
        + .env              the ${VARS} it names
           │
           ▼  npm run publish
        AGENT_ID
           ├──  npm start        browser tab
           └──  npm run phone    real phone number
```

The first publish creates the agent; every one after updates it in place. Both front doors read the same `AGENT_ID`, so what you heard in the browser is what callers get.

Secrets go in `.env` (or `agents/my-agent.env`) and get referenced as `${VAR}` — both gitignored, so the JSON stays committable. Every field is commented in the file with a link to the docs page that defines it.

## Deploy the browser app

Render prompts for your key during setup:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/dan-ince-aai/voice-agent-starter)

## Cost

Sessions bill to the key that published the agent. A live URL or phone number is an open line to your account — share it with colleagues, not the internet.

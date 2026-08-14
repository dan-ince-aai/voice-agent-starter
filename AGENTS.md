# Working on this repo

A dependency-free Node starter for the AssemblyAI Voice Agent API. An agent is one file in `agents/`; `publish.mjs` pushes it to the account; the two front doors in `deployment/` decide where it answers.

```
agents/<name>.jsonc        the agent — literally the body of POST /v1/agents
lib.mjs                    env loading, JSONC parsing, AssemblyAI + Twilio calls
publish.mjs                npm run publish
deployment/browser/        npm start — serves a page, mints session tokens
deployment/telephony/      npm run phone — Twilio SIP trunk, number, attach
```

## Run

```sh
cp .env.example .env    # ASSEMBLYAI_API_KEY
npm run publish         # AGENT=<name> to pick one
npm start
```

Node 18+, no installs. Agents: `minimal`, `keyterms`, `turn-taking`, `byo-llm`, `http-tools`, `exa-search`, `airtable-crm`, `cal-booking`, `dtmf`.

## How it fits together

- **Agent files are API request bodies.** No wrapper fields, no starter-only keys. If a field isn't in the [create-agent reference](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/create-agent), it doesn't belong in the file. They're `.jsonc` so each field can carry a comment and a doc link; `parseJsonc` in `lib.mjs` strips comments and trailing commas before the file is sent.
- **`${VAR}` in an agent file** is filled from the environment, the root `.env`, or `agents/<name>.env`, in that order of precedence. Secrets never live in the JSON. Unresolved variables are a hard error naming the variable.
- **`AGENT_ID` decides create vs update.** Unset: POST a new agent and write the id to `.env`. Set: PUT the config over that agent. A 404 on the PUT falls back to creating one.
- **Both deployments read the same `AGENT_ID`.** The browser session sends nothing but `{ agent_id }`; the phone number is bound to the same id. That's what keeps the two paths identical, and it's why behaviour changes belong in the agent file, never in a deployment.

## Rules

- Behaviour goes in `agents/*.jsonc`. Runtime changes go in the deployment that owns them. Anything shared goes in `lib.mjs` — it's the only thing both deployments import.
- Keep each deployment a single self-contained file plus its README.
- Prefer `http` tools. Client-executed tools can't be answered on a phone call, and `publish.mjs` warns about them.
- Voices: only IDs from the documented catalog at https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices. Never invent one.
- Never move the API key into client code, commit it, or log it. `.env` and `agents/*.env` are gitignored; keep them that way.
- Only use documented endpoints, and keep the doc links in the agent files accurate — they are the discovery path for anyone reading the repo.
- Voice-first prompt style: short spoken sentences, no visual formatting, no exclamation marks.
- New agent file: name it after the parameter or integration it demonstrates, not the persona. Comment every non-obvious field with a link to the page that defines it, and add a row to `README.md` and `agents/README.md`.

## Reference

- [Create an agent](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/create-agent) · [Manage agents](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/manage-agents)
- [Tools overview](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/overview) · [HTTP tools](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/http-tools)
- [Turn detection and interruptions](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/turn-detection-and-interruptions)
- [Connect your own LLM](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-your-own-llm)
- [Connect to Twilio](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-to-twilio) · [Use your own number](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/twilio-own-number)

## Deploying

`render.yaml` and `railway.json` run the browser deployment; both platforms set `PORT` and prompt for `ASSEMBLYAI_API_KEY`. Set `AGENT_ID` there so the deploy connects to a published agent instead of creating its own. Anyone with the deployed URL, or the phone number, runs sessions billed to that key.

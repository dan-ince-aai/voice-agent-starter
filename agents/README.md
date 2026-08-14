# agents/

One file, one agent. The JSON is exactly the body of `POST /v1/agents` — no wrapper fields, no starter-only keys.

They're `.jsonc` so every field carries a comment and a link to the docs page that defines it. Comments are stripped before the file is sent.

## Make your own

```sh
cp http-tools.jsonc my-agent.jsonc
AGENT=my-agent npm run publish
```

Needs a credential? Write `${MY_KEY}` anywhere in the file and put the value in `.env`, or in `agents/my-agent.env` if it belongs to this agent alone. Both are gitignored. Miss one and publishing tells you which variable to add.

```jsonc
"headers": [{ "name": "x-api-key", "value": "${EXA_API_KEY}" }]
```

---

## The lineup

| File | The one thing it shows |
| --- | --- |
| [minimal.jsonc](minimal.jsonc) | `name`, `system_prompt`, `voice` — and what the defaults give you |
| [keyterms.jsonc](keyterms.jsonc) | `input.keyterms`: words a transcriber would otherwise guess at |
| [turn-taking.jsonc](turn-taking.jsonc) | `input.turn_detection`: when your turn ends, and interruptions |
| [byo-llm.jsonc](byo-llm.jsonc) | `llm`: Claude via the AssemblyAI gateway, or any OpenAI-compatible endpoint |
| [http-tools.jsonc](http-tools.jsonc) | `tools[].http`: AssemblyAI calls the API for you. No keys needed |
| [exa-search.jsonc](exa-search.jsonc) | the same, with a credential attached |
| [airtable-crm.jsonc](airtable-crm.jsonc) | a read tool and a write tool |
| [cal-booking.jsonc](cal-booking.jsonc) | two tools in sequence: check, then book |
| [dtmf.jsonc](dtmf.jsonc) | `dtmf_collected_arguments`: keypad digits the model never sees |

## Two rules

**Prefer `http` tools.** They're called by AssemblyAI, so they work in a browser tab and on a phone call alike. Anything else has to be answered by whatever holds the session — and a phone call has nothing to answer it. `npm run publish` warns you.

**Prompt for speech.** Short sentences, no bullet points, no headings. Say what the agent is, what it must not do, and what to do when it doesn't know.

## Docs

[Create an agent](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/create-agent) · [Voices](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices) · [Turn detection](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/turn-detection-and-interruptions) · [HTTP tools](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/http-tools) · [Own LLM](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-your-own-llm) · [Prompting guide](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/prompting-guide)

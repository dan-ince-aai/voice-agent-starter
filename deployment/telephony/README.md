# Phone

Your agent answers a real phone number. Twilio hands the call to AssemblyAI over SIP — no media server, no bridge, no transcoding, no webhook to host.

## 1. Clone

```sh
git clone https://github.com/dan-ince-aai/voice-agent-starter
cd voice-agent-starter
```

## 2. Add credentials

```sh
cp .env.example .env
```

```sh
ASSEMBLYAI_API_KEY=…                              # assemblyai.com/dashboard
TWILIO_ACCOUNT_SID=AC…                            # twilio console
TWILIO_AUTH_TOKEN=…                               # twilio console
TWILIO_PHONE_NUMBER=+15551234567                  # a number you already own, E.164
TWILIO_TRUNK_DOMAIN=acme-agent.pstn.twilio.com    # you pick it, must end .pstn.twilio.com
```

## 3. Pick an agent

```sh
AGENT=cal-booking
```

Any file in [agents/](../../agents/), or your own: `cp agents/http-tools.jsonc agents/my-agent.jsonc`. On the phone, use `http` tools — a call has no browser to answer anything else.

## 4. Deploy

```sh
npm run phone
```

```
Agent: 8f3c…  published "Cal.com booking showcase"
Trunk: TK7a…  (created)
Origination: routed to sip:sip.assemblyai.com
Number: +15551234567 attached to trunk
Registered: +15551234567 imported
Attached: agent 8f3c… answers +15551234567
```

Call the number.

---

## What that did

1. Published the agent, or used `AGENT_ID` if you already had one.
2. Created a SIP trunk on your domain.
3. Pointed its origination URL at `sip:sip.assemblyai.com`.
4. Attached your number to the trunk.
5. Registered the number with AssemblyAI and bound the agent to it.

Safe to re-run. To change behaviour, edit the agent and `npm run publish` — the number already points at that id, so Twilio doesn't need touching again.

## Worth knowing

- **The trunk takes over the number.** Voice webhooks set on the number itself stop applying.
- **DTMF is phone-only.** [dtmf.jsonc](../../agents/dtmf.jsonc) takes card digits from the keypad, hidden from the transcript, the logs and the model.
- **Two meters run.** Twilio bills the minutes, AssemblyAI bills the session.

## When it breaks

| Message | Fix |
| --- | --- |
| `is not on this Twilio account` | Buy the number in Twilio first; check it's E.164. |
| `is attached to a different trunk` | Detach it in the Twilio console, re-run. |
| `Twilio POST /v1/Trunks failed (400)` | Domain taken or malformed. Pick another `*.pstn.twilio.com`. |
| Connects, then silence | Origination URL must be exactly `sip:sip.assemblyai.com`, enabled. |

## Docs

[Connect to Twilio](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-to-twilio) · [Use your own number](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/twilio-own-number)

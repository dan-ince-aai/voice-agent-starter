# deployment/

Where the agent answers. Both read the same `AGENT_ID`, so publishing once serves both.

| | | |
| --- | --- | --- |
| [browser/](browser/) | `npm start` | Page with a call button. Where you shape it. |
| [telephony/](telephony/) | `npm run phone` | Real phone number over SIP. Where it ships. |

Behaviour lives in [agents/](../agents/) — nothing here defines the agent.

#!/usr/bin/env node
// Put your agent on a phone number.
//
//   npm run phone
//
// Points a Twilio SIP trunk at AssemblyAI, hands your number to that trunk,
// registers the number, and attaches the agent to it. Every step checks
// before it creates, so re-running is safe.

import {
  ApiError,
  aai,
  loadEnv,
  publishAgent,
  readAgent,
  reportErrors,
  required,
  storedAgentId,
  twilio,
} from '../../lib.mjs'

reportErrors()
loadEnv()
required('ASSEMBLYAI_API_KEY', 'get one at https://www.assemblyai.com/dashboard/api-keys')
required('TWILIO_ACCOUNT_SID', 'find it on your Twilio console dashboard')
required('TWILIO_AUTH_TOKEN', 'find it on your Twilio console dashboard')
const number = required('TWILIO_PHONE_NUMBER', 'E.164 format, like +15551234567')
const trunkDomain = required(
  'TWILIO_TRUNK_DOMAIN',
  'a name you choose, ending in .pstn.twilio.com'
)

if (!/^\+[1-9]\d{6,14}$/.test(number)) {
  console.error(`TWILIO_PHONE_NUMBER must be E.164, like +15551234567 (got ${number})`)
  process.exit(1)
}
if (!trunkDomain.endsWith('.pstn.twilio.com')) {
  console.error(`TWILIO_TRUNK_DOMAIN must end in .pstn.twilio.com (got ${trunkDomain})`)
  process.exit(1)
}

const TRUNKING = 'https://trunking.twilio.com/v1/Trunks'
const CORE = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}`
// Where Twilio sends the call. A fixed AssemblyAI address, not something to
// customise.
const SIP_URL = 'sip:sip.assemblyai.com'

// 1. The agent. A published id means one already exists; otherwise publish the
// file now, which also writes the new id to .env.
const agentName = process.env.AGENT || 'minimal'
let agentId = storedAgentId(agentName)
if (agentId) {
  console.log(`Agent: ${agentId} (already published)`)
} else {
  const agent = readAgent(agentName)
  agentId = (await publishAgent(agent, { name: agentName })).id
  console.log(`Agent: ${agentId}, published "${agent.name}" from agents/${agentName}.jsonc`)
}

// 2. The number has to be one you already bought in Twilio.
const owned = await twilio(
  `${CORE}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`
)
const incoming = owned.incoming_phone_numbers?.[0]
if (!incoming) {
  console.error(`${number} is not on this Twilio account. Buy it in the console first.`)
  process.exit(1)
}

// 3. The trunk, matched by the domain you picked.
const trunks = await twilio(TRUNKING)
let trunk = (trunks.trunks ?? []).find((t) => t.domain_name === trunkDomain)
if (trunk) {
  console.log(`Trunk: ${trunk.sid} (existing)`)
} else {
  trunk = await twilio(TRUNKING, {
    FriendlyName: 'AssemblyAI voice agent',
    DomainName: trunkDomain,
  })
  console.log(`Trunk: ${trunk.sid} (created)`)
}

// 4. Origination sends incoming calls to AssemblyAI.
const origination = await twilio(`${TRUNKING}/${trunk.sid}/OriginationUrls`)
if ((origination.origination_urls ?? []).some((u) => u.sip_url === SIP_URL)) {
  console.log(`Origination: already routed to ${SIP_URL}`)
} else {
  await twilio(`${TRUNKING}/${trunk.sid}/OriginationUrls`, {
    FriendlyName: 'AssemblyAI SIP',
    SipUrl: SIP_URL,
    Priority: 1,
    Weight: 1,
    Enabled: true,
  })
  console.log(`Origination: routed to ${SIP_URL}`)
}

// 5. Hand the number to the trunk. From here the trunk controls it, and any
// Voice webhook set on the number itself stops applying.
if (incoming.trunk_sid === trunk.sid) {
  console.log(`Number: ${number} already on this trunk`)
} else if (incoming.trunk_sid) {
  console.error(
    `${number} is attached to a different trunk (${incoming.trunk_sid}). ` +
      'Detach it in the Twilio console and re-run.'
  )
  process.exit(1)
} else {
  await twilio(`${TRUNKING}/${trunk.sid}/PhoneNumbers`, { PhoneNumberSid: incoming.sid })
  console.log(`Number: ${number} attached to trunk`)
}

// 6. Register the number with AssemblyAI, unless it already knows it.
const encoded = encodeURIComponent(number)
let known = true
try {
  await aai(`/phone-numbers/${encoded}`)
  console.log(`Registered: ${number} already known to AssemblyAI`)
} catch (error) {
  if (!(error instanceof ApiError) || error.status !== 404) throw error
  known = false
}
if (!known) {
  await aai('/phone-numbers/import', {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: { phone_number: number, termination_uri: trunkDomain },
  })
  console.log(`Registered: ${number} imported`)
}

// 7. Attach the agent to the number, then read it back.
await aai(`/phone-numbers/${encoded}/agent`, {
  method: 'PUT',
  body: { agent_id: agentId },
})
const verified = await aai(`/phone-numbers/${encoded}`)
console.log(`Attached: agent ${verified.agent_id ?? agentId} answers ${number}`)
console.log(`\nCall ${number}.`)

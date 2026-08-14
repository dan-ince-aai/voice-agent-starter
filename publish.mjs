#!/usr/bin/env node
// Pushes agents/<name>.jsonc to your AssemblyAI account.
//
//   npm run publish
//   AGENT=exa-search npm run publish
//
// The first run creates the agent and writes AGENT_ID to .env. Every run
// after that updates that same agent in place, so the id stays valid and
// a browser tab or phone number pointed at it picks up the change on the
// next call.

import { loadEnv, publishAgent, readAgent, reportErrors, required } from './lib.mjs'

reportErrors()
loadEnv()
required('ASSEMBLYAI_API_KEY', 'get one at https://www.assemblyai.com/dashboard/api-keys')

const name = process.env.AGENT || 'minimal'
const agent = readAgent(name)
const { id, created, saved } = await publishAgent(agent)

console.log(`${created ? 'Created' : 'Updated'} "${agent.name}" from agents/${name}.jsonc`)
console.log(`AGENT_ID=${id}`)
if (created && !saved) {
  console.log('Could not write .env. Set AGENT_ID yourself to keep updating this agent.')
} else if (created) {
  console.log('Saved to .env.')
}

// Tools with an http block are called by AssemblyAI itself, so they work the
// same in a browser tab and on a phone call. Anything else has to be answered
// by whoever holds the session, and a phone call has nobody to answer it.
const unanswered = (agent.tools ?? []).filter((tool) => !tool.http).map((t) => t.name)
if (unanswered.length) {
  console.log(
    `\nWarning: ${unanswered.join(', ')} ${unanswered.length > 1 ? 'have' : 'has'} no http block, ` +
      'so nothing answers it on a phone call.'
  )
}

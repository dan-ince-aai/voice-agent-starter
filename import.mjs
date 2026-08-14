#!/usr/bin/env node
// Pull an agent you already have into this repo as a file.
//
//   npm run import 8f3c1e2a-...
//   AGENT_ID=8f3c1e2a-... npm run import
//
// Fetches the agent, writes agents/<name>.jsonc from it, and records the id in
// .env so `npm run publish` updates that agent rather than creating another.
// Useful when the agent started life in the AssemblyAI playground.

import { writeFileSync, existsSync } from 'node:fs'
import { aai, agentIdKey, loadEnv, reportErrors, required, saveEnv } from './lib.mjs'

reportErrors()
loadEnv()
required('ASSEMBLYAI_API_KEY', 'get one at https://www.assemblyai.com/dashboard/api-keys')

const id = process.argv[2] || process.env.AGENT_ID
if (!id) {
  console.error('Usage: npm run import <agent-id>')
  console.error('The id is in the URL of the agent in the AssemblyAI dashboard.')
  process.exit(1)
}

const agent = await aai(`/agents/${id}`)

// Fields the API fills in are not part of a create request, so they would be
// noise in the file.
const { id: _id, created_at, updated_at, ...body } = agent

const slug =
  process.env.AGENT ||
  (body.name || 'imported-agent')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') ||
  'imported-agent'

const path = new URL(`./agents/${slug}.jsonc`, import.meta.url)
if (existsSync(path) && !process.env.OVERWRITE) {
  console.error(`agents/${slug}.jsonc already exists. Set AGENT=<other-name> or OVERWRITE=1.`)
  process.exit(1)
}

const header = `// Imported from agent ${id}.
//
// This is the body of POST /v1/agents, so every field is documented at
// https://www.assemblyai.com/docs/voice-agents/voice-agent-api/create-agent
// Edit it and run \`npm run publish\` to push the change back to the same agent.
`
writeFileSync(path, header + JSON.stringify(body, null, 2) + '\n')
const key = agentIdKey(slug)
const saved = saveEnv(key, id)

console.log(`Wrote agents/${slug}.jsonc from "${body.name}"`)
console.log(saved ? `Saved ${key} to .env.` : `Could not write .env. Set ${key}=${id} yourself.`)
console.log(`\n  AGENT=${slug} npm start`)

// Credentials are write-only on the API, so they cannot come back with the
// agent. Anything that needs one has to be filled in again, as a ${VAR}.
const blanked = (body.tools ?? []).filter((tool) =>
  (tool.http?.headers ?? []).some((header) => !header.value)
)
if (blanked.length) {
  console.log(
    `\nHeader values are write-only and did not come back for: ${blanked
      .map((tool) => tool.name)
      .join(', ')}. Put them in .env and reference them as \${VARS}.`
  )
}
if (body.llm?.length) {
  console.log('\nThe llm entry came back without its api_key. Add it back as a ${VAR}.')
}

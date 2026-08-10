#!/usr/bin/env node
// Runs the voice agent picked by the USE_CASE env var.
//
//   ASSEMBLYAI_API_KEY=... USE_CASE=receptionist node server.mjs
//
// The agent itself is app.mjs; its behavior comes entirely from
// config/<use-case>.json, so a single deploy button serves any use case.

const USE_CASES = [
  'receptionist',
  'general',
  'interview-screener',
  'appointment-booking',
  'order-taking',
]

const useCase = process.env.USE_CASE || 'receptionist'
if (!USE_CASES.includes(useCase)) {
  console.error(
    `Unknown USE_CASE "${useCase}". Pick one of: ${USE_CASES.join(', ')}`
  )
  process.exit(1)
}
if (!process.env.ASSEMBLYAI_API_KEY) {
  console.error(
    'Set ASSEMBLYAI_API_KEY. Get one at https://www.assemblyai.com/dashboard'
  )
  process.exit(1)
}

await import('./app.mjs')

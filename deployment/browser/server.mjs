#!/usr/bin/env node
// Talk to your agent from a browser tab.
//
//   npm start
//
// Serves one page with a call button, mints short-lived session tokens, and
// streams the microphone to the agent. There is nothing to configure here:
// the agent is whatever agents/<name>.jsonc says, or whatever AGENT_ID points
// at. Your API key stays in this process; the page only ever gets a
// 60-second token.

import http from 'node:http'
import { aai, loadEnv, publishAgent, readAgent, required } from '../../lib.mjs'

loadEnv()
required('ASSEMBLYAI_API_KEY', 'get one at https://www.assemblyai.com/dashboard')

// AGENT_ID set means the agent is managed elsewhere — `npm run publish`, or
// the AssemblyAI dashboard — so connect to it as-is. Unset means publish the
// config file now and remember the id it gets.
const AGENT = await (async () => {
  if (process.env.AGENT_ID) {
    try {
      const agent = await aai(`/agents/${process.env.AGENT_ID}`)
      return { id: process.env.AGENT_ID, name: agent.name || 'Your agent' }
    } catch (error) {
      console.error(`Could not load AGENT_ID ${process.env.AGENT_ID}: ${error.message}`)
      process.exit(1)
    }
  }
  const name = process.env.AGENT || 'minimal'
  const agent = readAgent(name)
  try {
    const { id, created } = await publishAgent(agent)
    console.log(`${created ? 'Created' : 'Updated'} "${agent.name}" from agents/${name}.jsonc`)
    return { id, name: agent.name }
  } catch (error) {
    console.error(`Could not publish agents/${name}.jsonc: ${error.message}`)
    process.exit(1)
  }
})()

console.log(`Agent: ${AGENT.id}`)

// --- client ----------------------------------------------------------------
// Served as /app.js. The server stringifies this function, so what you read
// here is what the page runs.
function clientApp() {
const $ = (id) => document.getElementById(id)
const RATE = 24_000
const AGENT = window.AGENT

// Captures the mic as PCM16 and posts it to the main thread.
const workletUrl = URL.createObjectURL(new Blob([`
  class P extends AudioWorkletProcessor {
    process(inputs) {
      const ch = inputs[0]?.[0];
      if (ch) {
        const buf = new Int16Array(ch.length);
        for (let i = 0; i < ch.length; i++)
          buf[i] = Math.max(-32768, Math.min(32767, ch[i] * 32767));
        this.port.postMessage(buf.buffer, [buf.buffer]);
      }
      return true;
    }
  }
  registerProcessor("pcm", P);
`], { type: 'application/javascript' }))

let ws, ctx, mic

$('btn').onclick = () => (ws?.readyState <= 1 ? stop() : start())

async function start() {
  $('btn').disabled = true
  setStatus('connecting', '')

  try {
    // The API key never reaches the page; this token expires in 60 seconds.
    const res = await fetch('/token')
    if (!res.ok) {
      setStatus('error', 'could not mint a token — check the API key')
      reset()
      return
    }
    const { token } = await res.json()

    ctx = new AudioContext({ sampleRate: RATE })
    await ctx.resume()
    await ctx.audioWorklet.addModule(workletUrl)
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    })
    const source = ctx.createMediaStreamSource(mic)
    const worklet = new AudioWorkletNode(ctx, 'pcm')

    const url = new URL('wss://agents.assemblyai.com/v1/ws')
    url.searchParams.set('token', token)
    ws = new WebSocket(url)
    let ready = false
    let playAt = 0
    const scheduled = []

    worklet.port.onmessage = ({ data }) => {
      if (!ready || ws.readyState !== 1) return
      const bytes = new Uint8Array(data)
      let binary = ''
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
      ws.send(JSON.stringify({ type: 'input.audio', audio: btoa(binary) }))
    }
    source.connect(worklet).connect(ctx.destination)

    // Everything about the agent lives server-side; the session just names it.
    ws.onopen = () =>
      ws.send(JSON.stringify({ type: 'session.update', session: { agent_id: AGENT.id } }))

    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data)
      switch (msg.type) {
        case 'session.ready':
          ready = true
          setStatus('listening', '')
          $('btn').disabled = false
          $('btn').textContent = 'End call'
          $('btn').classList.add('live')
          break

        case 'input.speech.started':
          // Barge-in: drop queued agent audio the moment the caller speaks.
          setStatus('listening', '')
          scheduled.forEach((src) => {
            try { src.stop() } catch {}
          })
          scheduled.length = 0
          playAt = ctx.currentTime
          break

        case 'reply.started':
          setStatus('speaking', '')
          break

        case 'reply.audio': {
          const raw = atob(msg.data)
          const pcm = new Int16Array(raw.length / 2)
          for (let i = 0; i < pcm.length; i++)
            pcm[i] = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8)
          const buffer = ctx.createBuffer(1, pcm.length, RATE)
          const channel = buffer.getChannelData(0)
          for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768
          const src = ctx.createBufferSource()
          src.buffer = buffer
          src.connect(ctx.destination)
          playAt = Math.max(playAt, ctx.currentTime)
          src.start(playAt)
          playAt += buffer.duration
          scheduled.push(src)
          src.onended = () => {
            const i = scheduled.indexOf(src)
            if (i >= 0) scheduled.splice(i, 1)
          }
          break
        }

        case 'reply.done':
          setStatus('listening', '')
          if (msg.status === 'interrupted') playAt = ctx.currentTime
          break

        case 'transcript.user':
          addLine('you', msg.text)
          break

        case 'transcript.agent':
          addLine('agent', msg.text)
          break

        case 'tool.call':
          // http tools run on AssemblyAI's side; this is just so you can see
          // them fire.
          addLine('tool', msg.name)
          break

        case 'session.ended':
          ws.close()
          break

        case 'session.error':
          setStatus('error', msg.message)
          break
      }
    }

    ws.onclose = () => { setStatus('idle', ''); reset() }
    ws.onerror = () => { setStatus('error', 'connection failed'); reset() }
  } catch (error) {
    setStatus('error', error.message)
    reset()
  }
}

function stop() {
  // Ask for a clean close so the session record ends properly, then fall back
  // to closing the socket if the acknowledgement never lands.
  if (ws?.readyState === 1) {
    ws.send(JSON.stringify({ type: 'session.end' }))
    const socket = ws
    setTimeout(() => { if (socket.readyState === 1) socket.close() }, 3000)
  } else {
    ws?.close()
  }
  mic?.getTracks().forEach((track) => track.stop())
  ctx?.close()
  ctx = mic = null
  reset()
  setStatus('idle', '')
}

function reset() {
  $('btn').disabled = false
  $('btn').textContent = 'Start call'
  $('btn').classList.remove('live')
}

function setStatus(state, detail) {
  $('status').className = 'status ' + state
  $('status-text').textContent = detail || state
}

function addLine(who, text) {
  const empty = $('log').querySelector('.empty')
  if (empty) empty.remove()
  const line = document.createElement('div')
  line.className = 'line ' + who
  const label = document.createElement('span')
  label.className = 'who'
  label.textContent = who === 'agent' ? AGENT.name : who
  const body = document.createElement('span')
  body.textContent = text
  line.append(label, body)
  $('log').append(line)
  $('log').scrollTop = $('log').scrollHeight
}
}

// --- page ------------------------------------------------------------------
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${AGENT.name}</title>
<style>
  :root {
    --paper: #F6F4EE; --panel: #FBFAF6; --ink: #17171B; --muted: #6F6B60;
    --line: #E2DFD4; --brand: #364DEA; --green: #2F7D52; --red: #C6403E;
    --mono: ui-monospace, "SF Mono", Menlo, monospace;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: system-ui, -apple-system, sans-serif; color: var(--ink);
    background: var(--paper); display: flex; flex-direction: column;
    align-items: center; padding: 2rem 1.25rem;
  }
  main { width: 100%; max-width: 40rem; flex: 1; display: flex;
         flex-direction: column; min-height: 0; gap: 1rem; }
  header { display: flex; align-items: baseline; justify-content: space-between;
           gap: 1rem; padding-bottom: .875rem; border-bottom: 1px solid var(--line); }
  h1 { font-size: 1rem; font-weight: 600; }
  .status { display: flex; align-items: center; gap: .5rem; color: var(--muted);
            font-family: var(--mono); font-size: .6875rem; letter-spacing: .12em;
            text-transform: uppercase; }
  .status::before { content: ""; width: 7px; height: 7px; border-radius: 50%;
                    background: currentColor; }
  .status.listening { color: var(--green); }
  .status.speaking { color: var(--brand); }
  .status.error { color: var(--red); text-transform: none; letter-spacing: .04em; }
  .status.listening::before, .status.speaking::before {
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: .25 } }
  #log { flex: 1; overflow-y: auto; background: var(--panel);
         border: 1px solid var(--line); border-radius: .625rem;
         padding: 1rem; display: flex; flex-direction: column; gap: .625rem; }
  .empty { color: var(--muted); font-size: .875rem; }
  .line { display: flex; gap: .75rem; font-size: .9375rem; line-height: 1.5; }
  .who { font-family: var(--mono); font-size: .625rem; letter-spacing: .1em;
         text-transform: uppercase; color: var(--muted); padding-top: .28rem;
         flex-shrink: 0; min-width: 5.5rem; }
  .line.tool { color: var(--muted); font-family: var(--mono); font-size: .75rem; }
  button { font: inherit; font-weight: 600; color: #fff; background: var(--brand);
           border: none; border-radius: .625rem; padding: .875rem 1rem;
           cursor: pointer; width: 100%; }
  button:disabled { opacity: .55; cursor: default; }
  button.live { background: var(--red); }
  footer { color: var(--muted); font-size: .75rem; text-align: center; }
  a { color: inherit; }
</style>
</head>
<body>
<main>
  <header>
    <h1>${AGENT.name}</h1>
    <span class="status idle" id="status"><span id="status-text">idle</span></span>
  </header>
  <div id="log"><div class="empty">Start the call and talk. The transcript shows up here.</div></div>
  <button id="btn">Start call</button>
  <footer>Edit the agent in <code>agents/</code>, then <code>npm run publish</code></footer>
</main>
<script>window.AGENT = ${JSON.stringify(AGENT).replace(/</g, '\\u003c')}</script>
<script src="/app.js"></script>
</body>
</html>`

// --- server ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.url === '/token') {
    try {
      const token = await aai('/token?product=voice_agent&expires_in_seconds=60')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(token))
    } catch (error) {
      console.error(error.message)
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'token request failed' }))
    }
    return
  }
  if (req.url === '/app.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end('(' + clientApp.toString() + ')();')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(HTML)
})

// Uses PORT when set; otherwise starts at 3000 and hops to the next free port,
// since dev machines usually have something on 3000 already.
let port = Number(process.env.PORT) || 3000
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && !process.env.PORT && port < 3010) {
    port += 1
    server.listen(port)
    return
  }
  throw err
})
server.on('listening', () => console.log(`Talk to it: http://localhost:${port}`))
server.listen(port)

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
required('ASSEMBLYAI_API_KEY', 'get one at https://www.assemblyai.com/dashboard/api-keys')

// AGENT_ID set means the agent is managed elsewhere, by `npm run publish` or
// the AssemblyAI dashboard, so connect to it as it is. Unset means publish
// the agent file now and remember the id it gets.
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
    const { id, created } = await publishAgent(agent, { reuseByName: true })
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

let ws, ctx, mic, callStart, timer

// --- microphones ---
// Labels are empty until the user grants permission, so this runs again after
// getUserMedia and whenever a device is plugged in.
async function listMics() {
  if (!navigator.mediaDevices?.enumerateDevices) return
  const devices = await navigator.mediaDevices.enumerateDevices()
  const inputs = devices.filter((device) => device.kind === 'audioinput')
  const select = $('mic')
  const chosen = select.value
  select.replaceChildren()
  const auto = document.createElement('option')
  auto.value = ''
  auto.textContent = 'Default microphone'
  select.append(auto)
  inputs.forEach((device, i) => {
    const option = document.createElement('option')
    option.value = device.deviceId
    option.textContent = device.label || `Microphone ${i + 1}`
    select.append(option)
  })
  if (chosen && inputs.some((device) => device.deviceId === chosen)) select.value = chosen
}
listMics()
navigator.mediaDevices?.addEventListener?.('devicechange', listMics)

$('btn').onclick = () => (ws?.readyState <= 1 ? stop() : start())
$('log-toggle').onclick = () => {
  const hidden = document.body.classList.toggle('no-log')
  $('log-toggle').textContent = hidden ? 'Show' : 'Hide'
}

async function start() {
  $('btn').disabled = true
  $('mic').disabled = true
  setStatus('connecting')

  try {
    // The API key never reaches the page; this token expires in 60 seconds.
    const res = await fetch('/token')
    if (!res.ok) {
      setStatus('error', 'could not mint a token, check the API key')
      reset()
      return
    }
    const { token } = await res.json()

    ctx = new AudioContext({ sampleRate: RATE })
    await ctx.resume()
    await ctx.audioWorklet.addModule(workletUrl)
    const deviceId = $('mic').value
    mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    })
    // Device labels are only readable once permission is granted.
    listMics()
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
      logEvent('up', 'input.audio')
    }
    source.connect(worklet).connect(ctx.destination)

    // Everything about the agent lives server-side; the session just names it.
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'session.update', session: { agent_id: AGENT.id } }))
      logEvent('up', 'session.update', AGENT.id)
    }

    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data)
      switch (msg.type) {
        case 'session.ready':
          ready = true
          callStart = Date.now()
          timer = setInterval(tick, 1000)
          tick()
          setStatus('listening')
          $('btn').disabled = false
          $('btn').textContent = 'End call'
          $('btn').classList.add('live')
          logEvent('down', msg.type, msg.session_id)
          break

        case 'input.speech.started':
          // Barge-in: drop queued agent audio the moment the caller speaks.
          setStatus('listening')
          scheduled.forEach((src) => {
            try { src.stop() } catch {}
          })
          scheduled.length = 0
          playAt = ctx.currentTime
          logEvent('down', msg.type)
          break

        case 'reply.started':
          setStatus('speaking')
          logEvent('down', msg.type)
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
          logEvent('down', msg.type)
          break
        }

        case 'reply.done':
          setStatus('listening')
          if (msg.status === 'interrupted') playAt = ctx.currentTime
          logEvent('down', msg.type, msg.status)
          break

        // text carries the full transcript so far, so it replaces the partial.
        case 'transcript.user.delta':
          partial('you', msg.text)
          logEvent('down', msg.type, msg.text)
          break

        // delta carries the next word only, so it appends.
        case 'transcript.agent.delta':
          partial('agent', (partialText.agent || '') + msg.delta)
          logEvent('down', msg.type, msg.delta)
          break

        case 'transcript.user':
          addLine('you', msg.text)
          logEvent('down', msg.type, msg.text)
          break

        case 'transcript.agent':
          addLine('agent', msg.text)
          logEvent('down', msg.type, msg.text)
          break

        case 'tool.call': {
          // Tools with an http block are executed by AssemblyAI, so no result
          // comes back through this socket. A tool without one is yours to
          // answer with a tool.result message.
          const args = JSON.stringify(msg.arguments ?? {})
          addLine('tool', `${msg.name}(${args})`)
          logEvent('down', msg.type, `${msg.name} ${args}`)
          break
        }

        case 'session.ended':
          logEvent('down', msg.type)
          ws.close()
          break

        case 'session.error':
          setStatus('error', msg.message)
          logEvent('down', msg.type, `${msg.code}: ${msg.message}`)
          break

        default:
          logEvent('down', msg.type)
      }
    }

    ws.onclose = () => { setStatus('idle'); reset() }
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
    logEvent('up', 'session.end')
    const socket = ws
    setTimeout(() => { if (socket.readyState === 1) socket.close() }, 3000)
  } else {
    ws?.close()
  }
  mic?.getTracks().forEach((track) => track.stop())
  ctx?.close()
  ctx = mic = null
  reset()
  setStatus('idle')
}

function reset() {
  clearInterval(timer)
  clearPartials()
  $('btn').disabled = false
  $('mic').disabled = false
  $('btn').textContent = 'Start call'
  $('btn').classList.remove('live')
}

function setStatus(state, detail) {
  $('status').className = 'status ' + state
  $('status-text').textContent = detail || state
}

function tick() {
  const seconds = Math.floor((Date.now() - callStart) / 1000)
  $('elapsed').textContent =
    Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
}

// --- transcript ---
// Partials stream in while someone is still talking; the final transcript
// event replaces them.
const partialText = {}
const partialEl = {}

function transcriptLine(who, text, cls) {
  const line = document.createElement('div')
  line.className = 'line ' + who + (cls ? ' ' + cls : '')
  const label = document.createElement('span')
  label.className = 'who'
  label.textContent = who === 'agent' ? AGENT.name : who
  const body = document.createElement('span')
  body.className = 'said'
  body.textContent = text
  line.append(label, body)
  return line
}

function clearEmpty(el) {
  const empty = el.querySelector('.empty')
  if (empty) empty.remove()
}

function scroll(el) {
  el.scrollTop = el.scrollHeight
}

function partial(who, text) {
  clearEmpty($('transcript'))
  partialText[who] = text
  if (partialEl[who]) {
    partialEl[who].querySelector('.said').textContent = text
  } else {
    partialEl[who] = transcriptLine(who, text, 'partial')
    $('transcript').append(partialEl[who])
  }
  scroll($('transcript'))
}

function addLine(who, text) {
  clearEmpty($('transcript'))
  if (partialEl[who]) {
    partialEl[who].remove()
    delete partialEl[who]
    delete partialText[who]
  }
  $('transcript').append(transcriptLine(who, text))
  scroll($('transcript'))
}

function clearPartials() {
  for (const who of Object.keys(partialEl)) {
    partialEl[who].remove()
    delete partialEl[who]
    delete partialText[who]
  }
}

// --- event log ---
// Every frame in both directions. Audio and partials arrive many times a
// second, so repeats of one type collapse into a counter instead of flooding.
const COALESCE = new Set([
  'input.audio',
  'reply.audio',
  'transcript.user.delta',
  'transcript.agent.delta',
])
let lastEvent = null

function logEvent(direction, type, detail) {
  const log = $('events-body')
  clearEmpty(log)
  if (lastEvent && lastEvent.type === type && lastEvent.direction === direction && COALESCE.has(type)) {
    lastEvent.count += 1
    lastEvent.el.querySelector('.count').textContent = '\u00d7' + lastEvent.count
    if (detail) lastEvent.el.querySelector('.detail').textContent = detail
    scroll(log)
    return
  }
  const row = document.createElement('div')
  row.className = 'event ' + direction
  const at = document.createElement('span')
  at.className = 'at'
  at.textContent = (callStart ? (Date.now() - callStart) / 1000 : 0).toFixed(1) + 's'
  const arrow = document.createElement('span')
  arrow.className = 'dir'
  arrow.textContent = direction === 'up' ? '\u2191' : '\u2193'
  const name = document.createElement('span')
  name.className = 'type'
  name.textContent = type
  const count = document.createElement('span')
  count.className = 'count'
  const info = document.createElement('span')
  info.className = 'detail'
  if (detail) info.textContent = detail
  row.append(at, arrow, name, count, info)
  log.append(row)
  while (log.children.length > 500) log.firstChild.remove()
  lastEvent = { type, direction, count: 1, el: row }
  scroll(log)
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
    --faint: #98948A; --line: #E2DFD4; --brand: #364DEA; --green: #2F7D52;
    --red: #C6403E; --mono: ui-monospace, "SF Mono", Menlo, monospace;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: system-ui, -apple-system, sans-serif; color: var(--ink);
    background: var(--paper); display: flex; flex-direction: column;
    align-items: center; padding: 1.5rem 1.25rem 1.25rem;
  }
  main { width: 100%; max-width: 68rem; flex: 1; display: flex;
         flex-direction: column; min-height: 0; gap: .875rem; }

  header { display: flex; align-items: center; gap: 1rem;
           padding-bottom: .75rem; border-bottom: 1px solid var(--line); }
  h1 { font-size: 1rem; font-weight: 600; margin-right: auto; }
  .status { display: flex; align-items: center; gap: .5rem; color: var(--muted);
            font-family: var(--mono); font-size: .6875rem; letter-spacing: .12em;
            text-transform: uppercase; }
  .status::before { content: ""; width: 7px; height: 7px; border-radius: 50%;
                    background: currentColor; flex-shrink: 0; }
  .status.listening { color: var(--green); }
  .status.speaking { color: var(--brand); }
  .status.error { color: var(--red); text-transform: none; letter-spacing: .04em; }
  .status.listening::before, .status.speaking::before {
    animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: .25 } }
  #elapsed { font-family: var(--mono); font-size: .75rem; color: var(--faint);
             min-width: 2.5rem; text-align: right; }

  .panes { flex: 1; min-height: 0; display: grid; gap: .875rem;
           grid-template-columns: 1fr 23rem; }
  body.no-log .panes { grid-template-columns: 1fr; }
  body.no-log #events { display: none; }
  @media (max-width: 880px) {
    .panes { grid-template-columns: 1fr; grid-template-rows: 1fr 11rem; }
    body.no-log .panes { grid-template-rows: 1fr; }
  }

  .pane { display: flex; flex-direction: column; min-height: 0;
          background: var(--panel); border: 1px solid var(--line);
          border-radius: .625rem; overflow: hidden; }
  .pane-head { display: flex; align-items: center; justify-content: space-between;
               gap: 1rem; padding: .5rem .875rem; border-bottom: 1px solid var(--line);
               font-family: var(--mono); font-size: .625rem; letter-spacing: .1em;
               text-transform: uppercase; color: var(--faint); }
  .pane-body { flex: 1; overflow-y: auto; padding: .875rem; }
  .empty { color: var(--faint); font-size: .8125rem; line-height: 1.5; }

  #transcript { display: flex; flex-direction: column; gap: .625rem; }
  .line { display: flex; gap: .75rem; font-size: .9375rem; line-height: 1.5; }
  .who { font-family: var(--mono); font-size: .625rem; letter-spacing: .1em;
         text-transform: uppercase; color: var(--faint); padding-top: .3rem;
         flex-shrink: 0; width: 5.5rem; overflow: hidden; white-space: nowrap;
         text-overflow: ellipsis; }
  .line.partial .said { color: var(--muted); }
  .line.tool { font-family: var(--mono); font-size: .75rem; color: var(--brand); }
  .line.tool .said { word-break: break-all; }

  #events-body { font-family: var(--mono); font-size: .6875rem; line-height: 1.7; }
  .event { display: flex; gap: .5rem; align-items: baseline; }
  .event .at { color: var(--faint); min-width: 2.75rem; text-align: right;
               flex-shrink: 0; }
  .event .dir, .event .count { color: var(--faint); flex-shrink: 0; }
  .event .type { flex-shrink: 0; }
  .event.up .type { color: var(--muted); }
  .event .detail { color: var(--faint); overflow: hidden; white-space: nowrap;
                   text-overflow: ellipsis; }

  .controls { display: flex; gap: .625rem; align-items: center; }
  select, button { font: inherit; border-radius: .5rem; border: 1px solid var(--line); }
  select { flex: 1; max-width: 22rem; padding: .6rem .7rem; font-size: .875rem;
           background: var(--panel); color: var(--ink); }
  select:disabled { color: var(--faint); }
  button { font-weight: 600; color: #fff; background: var(--brand);
           border-color: transparent; padding: .7rem 1.75rem; cursor: pointer; }
  button:disabled { opacity: .55; cursor: default; }
  button.live { background: var(--red); }
  .ghost { background: transparent; color: var(--faint); border: none; padding: 0;
           font-family: var(--mono); font-size: .625rem; letter-spacing: .1em;
           text-transform: uppercase; cursor: pointer; }
</style>
</head>
<body>
<main>
  <header>
    <h1>${AGENT.name}</h1>
    <span class="status idle" id="status"><span id="status-text">idle</span></span>
    <span id="elapsed">0:00</span>
  </header>

  <div class="panes">
    <section class="pane">
      <div class="pane-head"><span>Transcript</span></div>
      <div class="pane-body" id="transcript">
        <div class="empty">Start the call and talk. Partial transcripts appear as they stream, and tool calls show up inline.</div>
      </div>
    </section>
    <section class="pane" id="events">
      <div class="pane-head">
        <span>Events</span>
        <button class="ghost" id="log-toggle">Hide</button>
      </div>
      <div class="pane-body" id="events-body">
        <div class="empty">Every websocket frame, both directions. Repeats collapse into a count.</div>
      </div>
    </section>
  </div>

  <div class="controls">
    <select id="mic" aria-label="Microphone"><option value="">Default microphone</option></select>
    <button id="btn">Start call</button>
  </div>
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

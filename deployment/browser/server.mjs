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
// The rate the API speaks. Both worklets resample to and from it, because a
// browser is allowed to ignore the sample rate an AudioContext asks for.
const WIRE_RATE = 24_000
const AGENT = window.AGENT

// Reads the mic, resamples to the wire rate, and posts PCM16 to the main
// thread. Allocations on the audio thread cause glitches, so the scratch
// buffers are reused and only the transferred buffer is per block.
const CAPTURE_WORKLET = `
  class CaptureProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this._ratio = sampleRate / ${WIRE_RATE};
      this._pos = 0;
      this._prev = 0;
      this._src = null;
      this._out = null;
    }
    _toPcm(samples, len) {
      const pcm = new Int16Array(len);
      for (let i = 0; i < len; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return pcm;
    }
    process(inputs) {
      const ch = inputs[0]?.[0];
      if (!ch) return true;
      if (this._ratio === 1) {
        const pcm = this._toPcm(ch, ch.length);
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        return true;
      }
      const n = ch.length;
      if (!this._src || this._src.length < n + 1) {
        this._src = new Float32Array(n + 1);
        this._out = new Float32Array(Math.ceil((n + 1) / this._ratio) + 2);
      }
      const src = this._src;
      const out = this._out;
      src[0] = this._prev;
      src.set(ch, 1);
      let outLen = 0;
      let pos = this._pos;
      while (pos < n) {
        const i = Math.floor(pos);
        const frac = pos - i;
        out[outLen++] = src[i] + (src[i + 1] - src[i]) * frac;
        pos += this._ratio;
      }
      this._pos = pos - n;
      this._prev = ch[n - 1];
      if (outLen) {
        const pcm = this._toPcm(out, outLen);
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
      }
      return true;
    }
  }
  registerProcessor('capture', CaptureProcessor);
`

// Plays reply audio out of a ring buffer. Scheduling one AudioBufferSource per
// arriving chunk drifts and clicks when the network jitters; a ring buffer the
// audio thread drains at its own pace does not. Posting 'stop' empties it,
// which is how barge-in cuts the agent off mid-word.
const PLAYBACK_WORKLET = `
  class PlaybackProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this._ring = new Float32Array(sampleRate * 30);
      this._writePos = 0;
      this._readPos = 0;
      this._available = 0;
      this._step = ${WIRE_RATE} / sampleRate;
      this._rsPos = 0;
      this._rsPrev = 0;
      // Set when the buffer runs dry. The speaker is then sitting at zero
      // while _rsPrev still holds the sample from before the gap, so
      // interpolating from it on the next chunk steps straight to that value
      // and clicks. Reset instead.
      this._drained = false;
      this.port.onmessage = (e) => {
        if (e.data === 'stop') {
          this._writePos = this._readPos = this._available = 0;
          this._rsPos = this._rsPrev = 0;
          return;
        }
        const int16 = new Int16Array(e.data);
        // An empty frame would leave _rsPrev as int16[-1], and one NaN in the
        // ring silences everything after it.
        if (!int16.length) return;
        if (this._drained) {
          this._rsPrev = 0;
          this._rsPos = 0;
          this._drained = false;
        }
        if (this._step === 1) {
          for (let i = 0; i < int16.length; i++) this._push(int16[i] / 32768);
          return;
        }
        const n = int16.length;
        let pos = this._rsPos;
        while (pos < n) {
          const i = Math.floor(pos);
          const frac = pos - i;
          const a = i === 0 ? this._rsPrev : int16[i - 1] / 32768;
          const b = int16[i] / 32768;
          this._push(a + (b - a) * frac);
          pos += this._step;
        }
        this._rsPos = pos - n;
        this._rsPrev = int16[n - 1] / 32768;
      };
    }
    _push(v) {
      if (this._available < this._ring.length) {
        this._ring[this._writePos] = v;
        this._writePos = (this._writePos + 1) % this._ring.length;
        this._available++;
      }
    }
    process(inputs, outputs) {
      const output = outputs[0];
      const out = output[0];
      const cap = this._ring.length;
      for (let i = 0; i < out.length; i++) {
        if (this._available > 0) {
          out[i] = this._ring[this._readPos];
          this._readPos = (this._readPos + 1) % cap;
          this._available--;
        } else {
          out[i] = 0;
          this._drained = true;
        }
      }
      // Mono source, stereo sink: copy into the other channels so one ear
      // isn't silent.
      for (let ch = 1; ch < output.length; ch++) output[ch].set(out);
      return true;
    }
  }
  registerProcessor('playback', PlaybackProcessor);
`

const blobUrl = (code) =>
  URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))

let ws, captureCtx, playbackCtx, playback, mic, callStart, timer

// --- microphones ---
// Labels stay empty until the page has held mic permission once, so this runs
// again after getUserMedia and on every device change.
async function listMics() {
  if (!navigator.mediaDevices?.enumerateDevices) return
  const devices = await navigator.mediaDevices.enumerateDevices()
  const inputs = devices
    .filter((device) => device.kind === 'audioinput')
    // Chrome reports synthetic "default" and "communications" entries that
    // point at whichever real device is current, which shows the same
    // microphone twice. The explicit option below covers that case.
    .filter((device) => device.deviceId !== 'default' && device.deviceId !== 'communications')
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
  const hidden = document.body.classList.toggle('no-side')
  $('log-toggle').textContent = hidden ? 'Show' : 'Hide'
}

// --- side pane tabs ---
// The agent config is fetched once, the first time the tab is opened.
let agentLoaded = false

function showTab(name) {
  for (const tab of ['events', 'agent']) {
    $('tab-' + tab).classList.toggle('on', tab === name)
    $(tab + '-body').hidden = tab !== name
  }
  if (name === 'agent' && !agentLoaded) {
    agentLoaded = true
    fetch('/agent')
      .then((res) => res.json())
      .then((agent) => {
        $('agent-body').replaceChildren()
        const pre = document.createElement('pre')
        pre.textContent = JSON.stringify(agent, null, 2)
        $('agent-body').append(pre)
      })
      .catch(() => {
        agentLoaded = false
        $('agent-body').textContent = 'Could not load the agent.'
      })
  }
}
$('tab-events').onclick = () => showTab('events')
$('tab-agent').onclick = () => showTab('agent')

async function addWorklet(ctx, code, name) {
  const url = blobUrl(code)
  try {
    await ctx.audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }
  return new AudioWorkletNode(ctx, name)
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

    // Two contexts: capture can be torn down without touching playback, and
    // a stall in one does not stall the other. Created inside the click
    // handler so Safari allows them to start.
    captureCtx = new AudioContext({ sampleRate: WIRE_RATE })
    playbackCtx = new AudioContext({ sampleRate: WIRE_RATE })
    await Promise.all([captureCtx.resume(), playbackCtx.resume()])

    playback = await addWorklet(playbackCtx, PLAYBACK_WORKLET, 'playback')
    playback.connect(playbackCtx.destination)

    const deviceId = $('mic').value
    mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        // A plain deviceId is a preference, so an unplugged headset falls
        // back to the default input instead of throwing.
        ...(deviceId ? { deviceId } : {}),
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })
    // Device labels only become readable once permission is granted.
    listMics()
    const capture = await addWorklet(captureCtx, CAPTURE_WORKLET, 'capture')
    captureCtx.createMediaStreamSource(mic).connect(capture)

    const url = new URL('wss://agents.assemblyai.com/v1/ws')
    url.searchParams.set('token', token)
    ws = new WebSocket(url)
    let ready = false

    // The API takes audio as base64 inside JSON, so each block is encoded
    // here rather than sent as a binary frame.
    capture.port.onmessage = ({ data }) => {
      if (!ready || ws.readyState !== 1) return
      const bytes = new Uint8Array(data)
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
      }
      ws.send(JSON.stringify({ type: 'input.audio', audio: btoa(binary) }))
      logEvent('up', 'input.audio')
    }

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
          // Barge-in: empty the ring buffer so the agent stops mid-word.
          playback?.port.postMessage('stop')
          setStatus('listening')
          logEvent('down', msg.type)
          break

        case 'reply.started':
          setStatus('speaking')
          logEvent('down', msg.type)
          break

        case 'reply.audio': {
          const raw = atob(msg.data)
          const bytes = new Uint8Array(raw.length)
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
          playback?.port.postMessage(bytes.buffer, [bytes.buffer])
          logEvent('down', msg.type)
          break
        }

        case 'reply.done':
          setStatus('listening')
          if (msg.status === 'interrupted') playback?.port.postMessage('stop')
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
  playback?.port.postMessage('stop')
  mic?.getTracks().forEach((track) => track.stop())
  captureCtx?.close()
  playbackCtx?.close()
  captureCtx = playbackCtx = playback = mic = null
  reset()
  setStatus('idle')
}

function reset() {
  clearInterval(timer)
  clearPartials()
  // Close any counting rows so the next call starts new ones.
  open.forEach((run) => paint(run, true))
  open.clear()
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
// Audio frames arrive around 190 times a second in each direction, so logging
// one row each would bury everything worth reading. These types instead hold a
// row open and count into it. Both directions stream at once, so a row is kept
// per direction and type rather than merging only with the row above.
const COALESCE = new Set([
  'input.audio',
  'reply.audio',
  'transcript.user.delta',
  'transcript.agent.delta',
])
const open = new Map()

function eventRow(direction, type, detail) {
  const row = document.createElement('div')
  row.className = 'event ' + direction
  const at = document.createElement('span')
  at.className = 'at'
  at.textContent = (callStart ? (Date.now() - callStart) / 1000 : 0).toFixed(1) + 's'
  const arrow = document.createElement('span')
  arrow.className = 'dir'
  arrow.textContent = direction === 'up' ? '↑' : '↓'
  const name = document.createElement('span')
  name.className = 'type'
  name.textContent = type
  const count = document.createElement('span')
  count.className = 'count'
  const info = document.createElement('span')
  info.className = 'detail'
  if (detail) info.textContent = detail
  row.append(at, arrow, name, count, info)
  return row
}

// Repainting on every frame is wasted work, so a counter updates at most ten
// times a second and once more when the run ends.
function paint(live, final) {
  const now = performance.now()
  if (!final && now - live.painted < 100) return
  live.painted = now
  live.row.querySelector('.count').textContent = live.count > 1 ? '×' + live.count : ''
  if (live.detail) live.row.querySelector('.detail').textContent = live.detail
}

function logEvent(direction, type, detail) {
  const log = $('events-body')
  clearEmpty(log)
  const key = direction + ' ' + type
  const live = open.get(key)
  if (live) {
    live.count += 1
    if (detail) live.detail = detail
    paint(live)
    return
  }
  // Anything that is not audio ends the runs above it, so the next burst
  // starts a fresh row and the log reads in order.
  if (!COALESCE.has(type)) {
    open.forEach((run) => paint(run, true))
    open.clear()
  }
  // Only follow the tail if the reader is already there.
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40
  const row = eventRow(direction, type, detail)
  log.append(row)
  while (log.children.length > 400) log.firstChild.remove()
  if (COALESCE.has(type)) open.set(key, { row, count: 1, detail, painted: 0 })
  if (atBottom) scroll(log)
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
  /* Tokens taken from assemblyai.com. The three typefaces are licensed and
     not bundled here, so each falls back the same way the site's own stack
     does: Georgia for display, system-ui for body, JetBrains Mono for mono. */
  :root {
    --page-bg: #fdfcf8;
    --surface: #fff;
    --surface-alt: #f5f3eb;
    --border: #dad7cb;
    --border-strong: #c7c3b2;
    --text: #4a4945;
    --text-dark: #1d1b16;
    --text-muted: #777673;
    --text-faint: #a5a4a2;
    --cobolt-500: #3923c7;
    --cobolt-300: #887bdd;
    --cobolt-100: #d7d3f4;
    --green-500: #01762f;
    --error: #f04438;
    --radius-sm: 4px;
    --radius-lg: 12px;
    --font-display: "Oceanic Text", Georgia, serif;
    --font-body: "UN 11ST", system-ui, -apple-system, sans-serif;
    --font-mono: "Modern Gothic Mono", "JetBrains Mono", ui-monospace, monospace;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: var(--font-body); font-size: 16px; line-height: 1.3;
    color: var(--text); background: var(--page-bg); display: flex;
    flex-direction: column; align-items: center; padding: 24px 20px 20px;
  }
  main { width: 100%; max-width: 1088px; flex: 1; display: flex;
         flex-direction: column; min-height: 0; gap: 16px; }

  /* .eyebrow on the site: mono, 12px, uppercase, 1.2px tracking. */
  .eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.2px;
             text-transform: uppercase; font-feature-settings: "ss09" 1; }

  header { display: flex; align-items: center; gap: 16px;
           padding-bottom: 16px; border-bottom: 1px solid var(--border); }
  h1 { font-family: var(--font-display); font-size: 24px; font-weight: 400;
       letter-spacing: -1.2px; line-height: 1; color: var(--text-dark);
       margin-right: auto; }
  .status { display: flex; align-items: center; gap: 8px; color: var(--text-muted); }
  .status::before { content: ""; width: 7px; height: 7px; border-radius: 50%;
                    background: currentColor; flex-shrink: 0; }
  .status.listening { color: var(--green-500); }
  .status.speaking { color: var(--cobolt-500); }
  .status.error { color: var(--error); text-transform: none; letter-spacing: 0;
                  font-family: var(--font-body); font-size: 14px; }
  .status.listening::before, .status.speaking::before {
    animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: .25 } }
  #elapsed { font-family: var(--font-mono); font-size: 12px; color: var(--text-faint);
             min-width: 40px; text-align: right; }

  .panes { flex: 1; min-height: 0; display: grid; gap: 16px;
           grid-template-columns: 1fr 360px; }
  body.no-side .panes { grid-template-columns: 1fr; }
  body.no-side #side { display: none; }
  [hidden] { display: none !important; }
  @media (max-width: 880px) {
    .panes { grid-template-columns: 1fr; grid-template-rows: 1fr 176px; }
    body.no-side .panes { grid-template-rows: 1fr; }
  }

  .pane { display: flex; flex-direction: column; min-height: 0;
          background: var(--surface); border: 1px solid var(--border);
          border-radius: var(--radius-lg); overflow: hidden; }
  .pane-head { display: flex; align-items: center; justify-content: space-between;
               gap: 16px; padding: 10px 16px; background: var(--surface-alt);
               border-bottom: 1px solid var(--border); color: var(--text-muted); }
  .pane-body { flex: 1; overflow-y: auto; padding: 16px; }
  .empty { color: var(--text-faint); font-size: 14px; line-height: 1.4; }

  #transcript { display: flex; flex-direction: column; gap: 12px; }
  .line { display: flex; gap: 12px; font-size: 16px; line-height: 1.4; }
  .who { color: var(--text-faint); padding-top: 3px; flex-shrink: 0; width: 88px;
         overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .line.agent .said { color: var(--text-dark); }
  .line.partial .said { color: var(--text-muted); }
  .line.tool { font-family: var(--font-mono); font-size: 13px;
               color: var(--cobolt-500); }
  .line.tool .said { word-break: break-all; }

  #events-body { font-family: var(--font-mono); font-size: 12px; line-height: 1.8; }
  .event { display: flex; gap: 8px; align-items: baseline; white-space: nowrap; }
  .event .at { color: var(--text-faint); min-width: 44px; text-align: right;
               flex-shrink: 0; }
  .event .dir, .event .count { color: var(--text-faint); flex-shrink: 0; }
  .event .count:empty, .event .detail:empty { display: none; }
  .event .type { flex-shrink: 0; color: var(--text-dark); }
  .event.up .type { color: var(--text-muted); }
  .event .detail { color: var(--text-faint); overflow: hidden; white-space: nowrap;
                   text-overflow: ellipsis; }

  .controls { display: flex; gap: 8px; align-items: center; }
  /* .cta-primary on the site: cobolt fill, mono uppercase 14px, 1.4px
     tracking, 40px tall, 4px radius, lightening on hover. */
  button { height: 40px; padding: 0 24px; border: none;
           border-radius: var(--radius-sm); background: var(--cobolt-500);
           color: #fff; font-family: var(--font-mono); font-size: 14px;
           letter-spacing: 1.4px; text-transform: uppercase; white-space: nowrap;
           cursor: pointer; transition: background-color .2s; }
  button:hover:not(:disabled) { background: var(--cobolt-300); }
  button:disabled { opacity: .55; cursor: default; }
  button.live { background: var(--error); }
  button.live:hover { background: #f4695f; }
  select { flex: 1; max-width: 360px; height: 40px; padding: 0 10px;
           font-family: var(--font-body); font-size: 14px; color: var(--text);
           background: var(--surface); border: 1px solid var(--border-strong);
           border-radius: var(--radius-sm); }
  select:disabled { color: var(--text-faint); }
  /* Text button, sized to sit inside the pane header. */
  .ghost { height: auto; padding: 0; background: transparent;
           color: var(--text-faint); font-size: 12px; letter-spacing: 1.2px; }
  .ghost:hover:not(:disabled) { background: transparent; color: var(--cobolt-500); }
  .tabs { display: flex; gap: 16px; }
  .tab.on { color: var(--text-dark); }

  /* Read-only view of the agent as the API stored it. */
  #agent-body pre { font-family: var(--font-mono); font-size: 12px;
                    line-height: 1.6; color: var(--text); white-space: pre-wrap;
                    word-break: break-word; }
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
    <section class="pane" id="side">
      <div class="pane-head">
        <span class="tabs">
          <button class="ghost tab on" id="tab-events">Events</button>
          <button class="ghost tab" id="tab-agent">Agent</button>
        </span>
        <button class="ghost" id="log-toggle">Hide</button>
      </div>
      <div class="pane-body" id="events-body">
        <div class="empty">Every websocket frame, both directions. Repeats collapse into a count.</div>
      </div>
      <div class="pane-body" id="agent-body" hidden>
        <div class="empty">Loading the published agent.</div>
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

// The stored agent, for the read-only view in the page. The API already keeps
// tool header values and llm keys write-only, and these deletes make sure the
// page never sees them even if that changes. The system prompt is visible, so
// on a public deployment this route shows it to anyone who opens the page.
function publicAgent(agent) {
  const copy = structuredClone(agent)
  for (const tool of copy.tools ?? []) {
    for (const header of tool.http?.headers ?? []) header.value = '<hidden>'
  }
  for (const llm of copy.llm ?? []) delete llm.api_key
  return copy
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/agent') {
    try {
      const agent = await aai(`/agents/${AGENT.id}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(publicAgent(agent)))
    } catch (error) {
      console.error(error.message)
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'could not load the agent' }))
    }
    return
  }
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

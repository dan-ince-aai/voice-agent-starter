#!/usr/bin/env node
// One-file voice agent web app. Run it with any Node 18+:
//
//   node agent.mjs
//
// then open http://localhost:3000 and start the call. Your API key stays
// inside this process; the browser only ever receives short-lived session
// tokens, which is the same auth pattern you should ship to production.

import http from 'node:http'

const API_KEY = process.env.ASSEMBLYAI_API_KEY ?? '<YOUR_API_KEY>'
// Uses PORT when set; otherwise starts at 3000 and hops to the next free
// port, since dev machines usually have something on 3000 already.
let port = Number(process.env.PORT) || 3000

// --- client application ------------------------------------------------
// Served to the browser as /app.js. Edit it like normal code; the server
// stringifies this function, so what you see is what the page runs.
function clientApp() {
const $ = (id) => document.getElementById(id);
const RATE = 24_000;

// Stubbed tool results: swap these for real backend calls. Tools without
// an entry here get { status: "ok" }.
const TOOL_RESULTS = {
  "log_answer": {
    "status": "recorded"
  }
};
// Simulated backend latency before each stub result. Long enough to hear
// the agent narrate the wait; a real integration replaces the wait entirely.
const SIMULATED_TOOL_LATENCY_MS = 3000;

// Tools the agent can call. Stub answers come from TOOL_RESULTS above.
const TOOLS = [
  {
    "type": "function",
    "name": "log_answer",
    "description": "Record an applicant answer. Call after each screening question is answered, before asking the next one.",
    "parameters": {
      "type": "object",
      "properties": {
        "question": {
          "type": "string",
          "description": "The question that was asked."
        },
        "answer": {
          "type": "string",
          "description": "A faithful summary of the applicant answer."
        }
      },
      "required": [
        "question",
        "answer"
      ]
    }
  }
];

// --- Agent definition: edit this, save, refresh ---------------------------
// Every field the session accepts is documented here:
// https://www.assemblyai.com/docs/voice-agents/voice-agent-api/create-agent
const SESSION = {
  system_prompt: `You are a phone screener for Lumen Labs, speaking with applicants for a customer support role. Ask these questions in order, one per turn. First, tell me about your customer support experience. Second, describe a time you turned around an unhappy customer. Third, what is your availability and earliest start date? Fourth, what are your salary expectations? Keep it brief and conversational, this is a chat and not an interrogation. If the applicant asks a question, answer it and return to where you left off. Record each answer with the log_answer tool before moving to the next question. When all questions are answered, thank them and say the team will follow up within three business days.`,
  greeting: `Hi, thanks for taking the time to talk about the customer support role at Lumen Labs. Shall we get started?`,
  input: {
    format: { encoding: 'audio/pcm', sample_rate: 24000 },
    keyterms: ["Lumen Labs"],
    // Turn taking, languages, transcription tuning, noise suppression:
    // https://www.assemblyai.com/docs/voice-agents/voice-agent-api/turn-detection-and-interruptions
    // turn_detection: { min_silence: 200, max_silence: 1200 },
  },
  output: {
    // Voice catalog: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices
    voice: 'george',
    format: { encoding: 'audio/pcm', sample_rate: 24000 },
  },
  // The agent calls these mid-conversation; this app answers with the
  // stubbed TOOL_RESULTS above. Swap those for real backend calls.
  // https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/overview
  tools: TOOLS,
};

// Inline AudioWorklet: captures mic as PCM16 and posts to main thread
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
`], { type: 'application/javascript' }));

// --- Waveform visualizer ---
const viz = $('viz');
const VIZ_WEIGHTS = Array.from({ length: 28 }, (_, i) => {
  const envelope = Math.sin((Math.PI * i) / 27);
  return 0.3 + 0.7 * envelope * (0.55 + 0.45 * Math.sin(i * 2.3));
});
VIZ_WEIGHTS.forEach((_, i) => {
  const bar = document.createElement('i');
  bar.style.setProperty('--i', i);
  viz.appendChild(bar);
});
let vizIdleTimer;
function vizPulse(kind, level) {
  viz.className = 'viz ' + kind;
  const clamped = Math.min(level * 3, 1);
  const bars = viz.children;
  for (let i = 0; i < bars.length; i++) {
    bars[i].style.height = (4 + VIZ_WEIGHTS[i] * clamped * 38) + 'px';
  }
  clearTimeout(vizIdleTimer);
  vizIdleTimer = setTimeout(() => {
    viz.className = 'viz idle';
    for (const bar of viz.children) bar.style.height = '4px';
  }, 300);
}
function pcmLevel(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 8) sum += Math.abs(samples[i]);
  return sum / (samples.length / 8) / 32768;
}

// --- Phone line simulation (300-3400 Hz, the passband of 8 kHz telephony) ---
let phoneChain = null;
function outputNode() {
  if (!$('phoneline').checked) return ctx.destination;
  if (!phoneChain) {
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass'; highpass.frequency.value = 300;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass'; lowpass.frequency.value = 3400;
    highpass.connect(lowpass);
    lowpass.connect(ctx.destination);
    phoneChain = highpass;
  }
  return phoneChain;
}
// --- Lite setup: what the sheet above the call button edits ---------------
const BUSINESS = 'Lumen Labs';
$('bizname').value = BUSINESS;
$('greeting').value = SESSION.greeting;
$('voice').value = SESSION.output.voice;

function personaName() {
  const id = $('voice').value;
  return id.charAt(0).toUpperCase() + id.slice(1);
}
function refreshPersona() {
  $('monogram').textContent = personaName().charAt(0);
  $('persona-name').textContent = personaName();
  $('spk-agent-name').textContent = personaName();
}
function setPersona(state, cls) {
  $('persona-state').textContent = state;
  $('persona').className = 'persona' + (cls ? ' ' + cls : '');
}
$('voice').addEventListener('change', refreshPersona);
refreshPersona();

let greetingEdited = false;
$('greeting').addEventListener('input', () => { greetingEdited = true; });
$('bizname').addEventListener('input', () => {
  if (greetingEdited) return;
  const name = $('bizname').value.trim() || BUSINESS;
  $('greeting').value = SESSION.greeting.split(BUSINESS).join(name);
});

const enabledTools = new Set(TOOLS.map((tool) => tool.name));
TOOLS.forEach((tool) => {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'on';
  chip.textContent = tool.name.replace(/_/g, ' ');
  chip.title = 'Click to give or take away this tool. Applies to the next call.';
  chip.onclick = () => {
    const on = !enabledTools.has(tool.name);
    if (on) enabledTools.add(tool.name);
    else enabledTools.delete(tool.name);
    chip.classList.toggle('on', on);
  };
  $('capabilities').appendChild(chip);
});
if (!TOOLS.length) $('caps-fld').hidden = true;

function buildSession() {
  const name = $('bizname').value.trim() || BUSINESS;
  const swap = (text) => text.split(BUSINESS).join(name);
  return {
    ...SESSION,
    system_prompt: swap(SESSION.system_prompt),
    greeting: $('greeting').value.trim() || swap(SESSION.greeting),
    input: {
      ...SESSION.input,
      keyterms: (SESSION.input.keyterms ?? []).map(swap),
    },
    output: { ...SESSION.output, voice: $('voice').value },
    tools: TOOLS.filter((tool) => enabledTools.has(tool.name)),
  };
}

$('phoneline').onchange = () => {
  $('phonenote').hidden = !$('phoneline').checked;
};

// --- Microphone enumeration ---
async function populateMics() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(d => d.kind === 'audioinput');
    const sel = $('mic');
    const current = sel.value;
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'Default microphone';
    sel.appendChild(def);
    inputs.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Microphone ${i + 1}`;
      sel.appendChild(opt);
    });
    if (current && inputs.some(d => d.deviceId === current)) sel.value = current;
  } catch (e) { console.warn('enumerateDevices failed', e); }
}
populateMics();
navigator.mediaDevices?.addEventListener?.('devicechange', populateMics);

// --- Ringback: a soft double-tone while the call connects ---
let ring = null;
function startRing() {
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(ctx.destination);
  const oscA = ctx.createOscillator(); oscA.frequency.value = 440;
  const oscB = ctx.createOscillator(); oscB.frequency.value = 480;
  oscA.connect(gain); oscB.connect(gain);
  oscA.start(); oscB.start();
  const pulse = () => {
    const t = ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.045, t + 0.04);
    gain.gain.setValueAtTime(0.045, t + 0.85);
    gain.gain.linearRampToValueAtTime(0, t + 0.95);
  };
  pulse();
  ring = { gain, oscA, oscB, timer: setInterval(pulse, 2600) };
}
function stopRing() {
  if (!ring) return;
  clearInterval(ring.timer);
  try { ring.oscA.stop(); ring.oscB.stop(); } catch {}
  ring.gain.disconnect();
  ring = null;
}

// --- Voice Agent ---
let ws, ctx, mic;

$('btn').onclick = () => (ws?.readyState <= 1) ? stop() : start();

async function start() {
  $('btn').disabled = true;
  setStatus('Connecting…');
  setPersona('Ringing…', 'live');

  try {
    // Session token from our own server; the API key never reaches the page.
    const tokenRes = await fetch('/token');
    if (!tokenRes.ok) {
      setStatus('Could not mint a session token (check the API key)', 'err');
      resetUI();
      return;
    }
    const { token } = await tokenRes.json();

    ctx = new AudioContext({ sampleRate: RATE });
    phoneChain = null;
    await ctx.resume();
    startRing();
    await ctx.audioWorklet.addModule(workletUrl);
    const deviceId = $('mic').value;
    mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
    populateMics();
    const source = ctx.createMediaStreamSource(mic);
    const worklet = new AudioWorkletNode(ctx, 'pcm');

    const url = new URL('wss://agents.assemblyai.com/v1/ws');
    url.searchParams.set('token', token);
    ws = new WebSocket(url);
    let ready = false, playT = 0;
    const scheduled = [];

    worklet.port.onmessage = ({ data }) => {
      if (!ready || ws.readyState !== 1) return;
      vizPulse('user', pcmLevel(new Int16Array(data)));
      const b = new Uint8Array(data);
      let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      ws.send(JSON.stringify({ type: 'input.audio', audio: btoa(s) }));
    };
    source.connect(worklet).connect(ctx.destination);

    ws.onopen = () => ws.send(JSON.stringify({
      type: 'session.update',
      session: buildSession(),
    }));

    ws.onmessage = ({ data }) => {
      const m = JSON.parse(data);
      switch (m.type) {
        case 'input.speech.started':
          // Barge-in: kill scheduled agent audio the moment the user speaks.
          setSpeaker('user', true);
          setPersona('Listening', 'live');
          scheduled.forEach((s) => { try { s.stop(); } catch {} });
          scheduled.length = 0;
          playT = ctx.currentTime;
          break;
        case 'input.speech.stopped':
          setSpeaker('user', false);
          setPersona('On the line', 'live');
          break;
        case 'reply.started':
          setSpeaker('agent', true);
          setPersona('Speaking', 'live speaking');
          break;
        case 'session.ready':
          ready = true;
          stopRing();
          callStart = Date.now();
          $('call-dur').textContent = '0:00';
          durTimer = setInterval(() => { $('call-dur').textContent = elapsed(); }, 1000);
          setPersona('On the line', 'live');
          setStatus('Connected', 'ok');
          $('btn').disabled = false;
          $('btn-label').textContent = 'End call';
          $('btn').classList.add('on');
          clearEmpty();
          break;

        case 'reply.audio': {
          const raw = atob(m.data);
          const pcm = new Int16Array(raw.length / 2);
          for (let i = 0; i < pcm.length; i++)
            pcm[i] = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
          const f32 = new Float32Array(pcm.length);
          for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
          const buf = ctx.createBuffer(1, f32.length, RATE);
          buf.getChannelData(0).set(f32);
          vizPulse('agent', pcmLevel(pcm));
          const src = ctx.createBufferSource();
          src.buffer = buf; src.connect(outputNode());
          playT = Math.max(playT, ctx.currentTime);
          src.start(playT); playT += buf.duration;
          scheduled.push(src);
          src.onended = () => {
            const i = scheduled.indexOf(src);
            if (i >= 0) scheduled.splice(i, 1);
          };
          break;
        }

        case 'reply.done':
          setSpeaker('agent', false);
          setPersona('On the line', 'live');
          if (m.status === 'interrupted') playT = ctx.currentTime;
          break;

        case 'transcript.user':
          addMsg('Caller', m.text, 'u'); break;

        case 'transcript.agent':
          addMsg(personaName(), m.text, 'a'); break;

        case 'tool.call': {
          const args = typeof m.arguments === 'string'
            ? m.arguments : JSON.stringify(m.arguments);
          const line = addMsg('Tool', m.name + ' ' + args, 't');
          const runEl = document.createElement('span');
          runEl.className = 'run';
          line.querySelector('.txt').appendChild(runEl);
          const t0 = Date.now();
          runEl.textContent = 'running 0.0s';
          const tick = setInterval(() => {
            runEl.textContent = 'running ' + ((Date.now() - t0) / 1000).toFixed(1) + 's';
          }, 100);
          // Simulate a moment of real work; swap for your backend call.
          // The agent narrates the wait; results can take up to the tool's
          // timeout_seconds (default 120s).
          const result = TOOL_RESULTS[m.name] ?? { status: 'ok' };
          setTimeout(() => {
            clearInterval(tick);
            runEl.textContent = ((Date.now() - t0) / 1000).toFixed(1) + 's';
            if (ws?.readyState !== 1) return;
            addMsg('Result', m.name + ' ' + JSON.stringify(result), 't');
            ws.send(JSON.stringify({
              type: 'tool.result',
              call_id: m.call_id,
              result: JSON.stringify(result),
            }));
          }, SIMULATED_TOOL_LATENCY_MS);
          break;
        }

        case 'session.ended':
          ws.close(); break;

        case 'session.error':
          setStatus('Error: ' + m.message, 'err'); break;
      }
    };

    ws.onclose = () => { stopRing(); setStatus('Disconnected'); resetUI(); };
    ws.onerror = () => { stopRing(); setStatus('Connection failed', 'err'); resetUI(); };
  } catch (e) {
    stopRing(); setStatus(e.message, 'err'); resetUI();
  }
}

function stop() {
  // Clean shutdown: ask for session.ended so the session record closes
  // properly; fall back to closing the socket if it never arrives.
  if (ws?.readyState === 1) {
    ws.send(JSON.stringify({ type: 'session.end' }));
    const socket = ws;
    setTimeout(() => { if (socket.readyState === 1) socket.close(); }, 3000);
  } else {
    ws?.close();
  }
  stopRing();
  mic?.getTracks().forEach(t => t.stop()); ctx?.close();
  ctx = mic = null; resetUI(); setStatus('Disconnected');
}

function resetUI() {
  clearInterval(durTimer);
  setPersona('Off the line');
  $('btn').disabled = false;
  $('btn-label').textContent = 'Start call';
  $('btn').classList.remove('on');
  setSpeaker('user', false);
  setSpeaker('agent', false);
}

function setStatus(msg, cls) {
  $('status-text').textContent = msg;
  $('status').className = 'status' + (cls ? ' ' + cls : '');
}

function setSpeaker(who, active) {
  $('spk-' + who).classList.toggle('active', active);
}

function clearEmpty() {
  const e = $('msgs').querySelector('.empty');
  if (e) e.remove();
}

let callStart = null;
let durTimer = null;
function elapsed() {
  if (callStart == null) return '0:00';
  const s = Math.floor((Date.now() - callStart) / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function addMsg(who, text, cls) {
  clearEmpty();
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  const tm = document.createElement('span');
  tm.className = 'tm';
  tm.textContent = elapsed();
  const whoEl = document.createElement('span');
  whoEl.className = 'who';
  whoEl.textContent = who;
  const textEl = document.createElement('span');
  textEl.className = 'txt';
  textEl.textContent = text;
  d.appendChild(tm);
  d.appendChild(whoEl);
  d.appendChild(textEl);
  $('msgs').appendChild(d);
  $('msgs').scrollTop = $('msgs').scrollHeight;
  return d;
}
}

// --- page markup ---------------------------------------------------------
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Interview screener · AssemblyAI</title>
  <style>
    :root {
      --paper: #F6F4EE; --panel: #FBFAF6; --ink: #17171B;
      --muted: #6F6B60; --faint: #98948A;
      --line: #E2DFD4; --line-soft: #ECE9DF;
      --brand: #364DEA; --brand-soft: #DCE3FC; --brand-faint: #EDF1FE;
      --green: #2F7D52; --green-bg: #E9F1E9;
      --red: #C6403E; --red-bg: #F7E9E7;
      --mono: ui-monospace, "SF Mono", Menlo, monospace;
      --serif: "Iowan Old Style", "Palatino", Georgia, serif;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    [hidden] { display: none !important; }
    html, body { height: 100%; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      color: var(--ink); display: flex; flex-direction: column;
      background: var(--paper);
    }

    header {
      background: transparent; border-bottom: 1px solid var(--line);
      padding: 0 1.75rem; height: 3.5rem;
      display: flex; align-items: center; gap: 1rem; flex-shrink: 0;
    }
    .logo img { height: 20px; display: block; }
    .page-title {
      font-family: var(--mono); font-size: .6875rem; letter-spacing: .14em;
      text-transform: uppercase; color: var(--muted);
      padding-left: 1rem; border-left: 1px solid var(--line);
    }
    .header-spacer { flex: 1; }
    .status {
      display: flex; align-items: center; gap: .5rem;
      font-family: var(--mono); font-size: .6875rem; letter-spacing: .12em;
      text-transform: uppercase; color: var(--muted);
      padding: .3rem 0; border: none; background: transparent;
    }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
    .status.ok { color: var(--green); }
    .status.ok .dot { animation: pulse 2s ease-in-out infinite; }
    .status.err { color: var(--red); }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }

    .page {
      flex: 1; overflow-y: auto;
      display: flex; flex-direction: column; align-items: center;
      padding: 2rem 2rem 1.1rem; gap: 1.1rem;
    }
    .cols {
      width: 100%; max-width: 1100px; flex: 1; min-height: 0;
      display: flex; align-items: stretch; gap: 1.5rem;
    }
    .deskcard {
      width: 440px; flex-shrink: 0; align-self: flex-start;
      background: #fff; border: 1px solid var(--line); border-radius: 8px;
      box-shadow: 0 1px 2px rgba(23, 23, 27, .04), 0 12px 32px rgba(23, 23, 27, .05);
      padding: 1.6rem; display: flex; flex-direction: column; gap: 1.35rem;
    }
    .deskrule { border-top: 1px solid var(--line-soft); }
    .persona { display: flex; align-items: center; gap: 1rem; }
    .monogram {
      width: 54px; height: 54px; border-radius: 50%; flex-shrink: 0;
      border: 1px solid var(--ink); color: var(--ink);
      display: flex; align-items: center; justify-content: center;
      font-family: var(--serif); font-size: 1.6rem;
      transition: border-color .2s, color .2s, box-shadow .2s;
    }
    .persona.live .monogram { border-color: var(--brand); color: var(--brand); }
    .persona.speaking .monogram {
      box-shadow: 0 0 0 4px var(--brand-faint); animation: pulse 1.2s ease-in-out infinite;
    }
    .persona-name { font-family: var(--serif); font-size: 1.2rem; color: var(--ink); }
    .persona-state {
      font-family: var(--mono); font-size: .6563rem; letter-spacing: .16em;
      text-transform: uppercase; color: var(--faint); margin-top: .25rem;
    }
    .persona.live .persona-state { color: var(--green); }
    .persona.speaking .persona-state { color: var(--brand); }
    .col-right { flex: 1; min-width: 0; display: flex; }
    @media (max-width: 920px) {
      .cols { flex-direction: column; }
      .deskcard { width: 100%; }
      .transcript { min-height: 360px; }
    }
    .plaque {
      display: flex; align-items: center; justify-content: center; gap: .8rem;
      font-family: var(--mono); font-size: .6875rem; letter-spacing: .06em;
      color: var(--faint); flex-wrap: wrap; text-align: center;
    }
    .plaque b { font-weight: 600; color: var(--muted); }
    .plaque select { width: auto; font-size: .75rem; padding: .25rem .5rem; }
    .capabilities { display: flex; gap: .5rem; flex-wrap: wrap; }
    .capabilities button {
      white-space: nowrap;
      font-family: var(--mono); font-size: .6563rem; letter-spacing: .1em;
      text-transform: uppercase; cursor: pointer; border-radius: 2px;
      padding: .25rem .65rem; background: transparent;
      border: 1px dashed var(--line); color: var(--faint);
      text-decoration: line-through;
    }
    .capabilities button.on {
      border: 1px solid var(--ink); color: var(--ink); text-decoration: none;
    }
    .capabilities button:hover { border-color: var(--brand); color: var(--brand); }
    .configlink {
      font-family: var(--mono); font-size: .6875rem; letter-spacing: .1em;
      text-transform: uppercase; color: var(--muted); text-decoration: none;
      border-bottom: 1px dotted var(--faint); padding-bottom: 1px;
    }
    .configlink:hover { color: var(--ink); }
    select {
      padding: .3rem .5rem; border: 1px solid var(--line); border-radius: 3px;
      font: inherit; font-size: .75rem; color: var(--muted); background: #fff;
    }

    .sheet { display: flex; flex-direction: column; gap: 1.15rem; }
    .fld-row { display: flex; gap: 2.5rem; align-items: flex-start; }
    .fld-row .fld:first-child { flex: 1; }
    #voice {
      font-family: var(--mono); font-size: .6875rem; letter-spacing: .08em;
      text-transform: uppercase; padding: .3rem .5rem;
    }
    .fld { display: flex; flex-direction: column; gap: .4rem; }
    .flt {
      font-family: var(--mono); font-size: .625rem; letter-spacing: .2em;
      text-transform: uppercase; color: var(--faint);
    }
    .sheet input {
      border: none; border-bottom: 1px dashed var(--faint); border-radius: 0;
      background: transparent; width: 100%; padding: 0 0 .35rem; color: var(--ink);
      cursor: text; transition: background .15s, border-color .15s;
    }
    .sheet input:hover { background: var(--brand-faint); border-bottom-color: var(--brand); }
    .sheet input:focus { outline: none; border-bottom-color: var(--brand); background: var(--brand-faint); }
    .sheet-note {
      font-family: var(--mono); font-size: .6563rem; letter-spacing: .08em;
      text-transform: uppercase; color: var(--faint);
    }
    #bizname { font-family: var(--serif); font-size: 2.1rem; font-weight: 500; letter-spacing: -.01em; }
    #greeting { font-family: var(--serif); font-style: italic; font-size: .95rem; color: var(--muted); }

    .callpad { display: flex; flex-direction: column; gap: 1rem; }
    .callmeta { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .callmeta select { flex: 1; min-width: 0; }
    .viz { display: flex; align-items: center; justify-content: space-between; width: 100%; height: 46px; }
    .viz i {
      width: 3px; height: 4px; min-height: 4px; border-radius: 99px;
      background: var(--brand-soft); transform-origin: center;
      transition: height 80ms linear, background .2s;
    }
    .viz.idle i { animation: ripple 2.6s ease-in-out infinite; animation-delay: calc(var(--i) * 80ms); }
    .viz.agent i { background: var(--brand); }
    .viz.user i { background: var(--faint); }
    @keyframes ripple { 0%, 100% { transform: scaleY(1); } 50% { transform: scaleY(3.2); } }
    @media (prefers-reduced-motion: reduce) { .viz i, .stage::before { animation: none !important; } }

    .btn {
      width: 100%; padding: .85rem 2rem; border: 1px solid var(--brand); border-radius: 2px;
      font-family: var(--mono); font-size: .75rem; font-weight: 500;
      letter-spacing: .18em; text-transform: uppercase;
      cursor: pointer; color: #fff; background: var(--brand);
      transition: background .15s, border-color .15s;
      display: flex; align-items: center; justify-content: center; gap: .6rem;
    }
    .btn:hover { background: #2B3EC4; border-color: #2B3EC4; }
    .btn:disabled { opacity: .5; cursor: default; }
    .btn.on { background: transparent; border-color: var(--red); color: var(--red); }
    .btn.on:hover { background: var(--red-bg); }
    .btn svg { width: 15px; height: 15px; }

    .phoneline {
      display: flex; align-items: center; gap: .45rem;
      font-family: var(--mono); font-size: .6875rem; letter-spacing: .1em;
      text-transform: uppercase; color: var(--muted); cursor: pointer; user-select: none;
    }
    .phoneline input { width: auto; accent-color: var(--brand); }
    .phonenote {
      font-family: var(--mono); font-size: .6563rem; letter-spacing: .08em;
      text-transform: uppercase; color: var(--faint);
    }

    .transcript {
      flex: 1; min-height: 0;
      display: flex; flex-direction: column;
      background: #fff; border: 1px solid var(--line); border-radius: 8px;
      box-shadow: 0 1px 2px rgba(23, 23, 27, .04), 0 12px 32px rgba(23, 23, 27, .05);
      overflow: hidden;
    }
    #call-dur { color: var(--brand); margin-left: .55rem; letter-spacing: .06em; }
    .transcript-hd {
      padding: .7rem 1.1rem; border-bottom: 1px solid var(--line);
      font-family: var(--mono); font-size: .6563rem; font-weight: 500;
      color: var(--muted); text-transform: uppercase; letter-spacing: .16em;
      display: flex; justify-content: space-between; align-items: center;
    }
    .speakers { display: flex; gap: .4rem; }
    .speaker {
      display: flex; align-items: center; gap: .4rem;
      padding: .2rem .6rem; border-radius: 2px; border: 1px solid transparent;
      color: var(--faint); font-family: var(--mono); font-size: .6563rem;
      text-transform: uppercase; letter-spacing: .1em;
      transition: color .2s, border-color .2s;
    }
    .speaker .dot { width: 5px; height: 5px; }
    .speaker.user.active { color: var(--ink); border-color: var(--line); }
    .speaker.agent.active { color: var(--brand); border-color: var(--brand-soft); }
    .speaker.active .dot { animation: pulse 1s ease-in-out infinite; }
    #msgs { flex: 1; overflow-y: auto; padding: .9rem 1.25rem; display: flex; flex-direction: column; gap: .45rem; }
    .empty {
      flex: 1; display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: .85rem; padding: 0 3rem; text-align: center;
    }
    .empty .try {
      font-family: var(--mono); font-size: .6563rem; letter-spacing: .18em;
      text-transform: uppercase; color: var(--brand);
      border: 1px solid var(--brand-soft); border-radius: 2px; padding: .2rem .6rem;
    }
    .empty .hint {
      font-family: var(--serif); font-style: italic; font-size: 1.05rem;
      color: var(--muted); line-height: 1.6; max-width: 26rem;
    }
    .msg {
      display: flex; gap: 1rem; align-items: baseline;
      font-size: .875rem; line-height: 1.55; animation: fadeIn .2s ease;
    }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    .msg .tm {
      font-family: var(--mono); font-size: .6563rem; color: var(--faint);
      width: 2.4rem; flex-shrink: 0; text-align: right;
    }
    .msg .who {
      font-family: var(--mono); font-size: .6563rem; font-weight: 500;
      text-transform: uppercase; letter-spacing: .12em;
      width: 4.6rem; flex-shrink: 0; color: var(--muted);
    }
    .msg .txt { min-width: 0; }
    .msg.a .who { color: var(--brand); }
    .msg.u .txt { color: var(--muted); }
    .msg.t .who { color: var(--faint); }
    .msg.t .txt {
      font-family: var(--mono); font-size: .7188rem; color: var(--muted);
      overflow-wrap: anywhere;
    }
    .msg .run { color: var(--brand); margin-left: .6rem; white-space: nowrap; }
    .msg .run::before { content: '● '; animation: pulse 1s ease-in-out infinite; }
  </style>
</head>
<body>
<header>
  <a class="logo" href="https://www.assemblyai.com">
    <img src="https://cdn.prod.website-files.com/67a08d9d7d19f8fb63692894/67b5bd3d9e8ee1a6b2410b9e_AssemblyAI%20Logo.svg" alt="AssemblyAI">
  </a>
  <span class="page-title">Interview screener · Voice Agent API</span>
  <div class="header-spacer"></div>
  <div class="status" id="status"><span class="dot"></span><span id="status-text">Ready</span></div>
</header>

<main class="page">
  <div class="cols">
    <section class="deskcard">
      <div class="persona" id="persona">
        <div class="monogram" id="monogram">G</div>
        <div>
          <div class="persona-name" id="persona-name">George</div>
          <div class="persona-state" id="persona-state">Off the line</div>
        </div>
      </div>
      <div class="deskrule"></div>
      <div class="sheet">
        <div class="fld">
          <span class="flt">Company</span>
          <input id="bizname" spellcheck="false" autocomplete="off" aria-label="Company name">
        </div>
        <div class="fld">
          <span class="flt">Answers with</span>
          <input id="greeting" spellcheck="false" autocomplete="off" aria-label="Greeting">
        </div>
        <div class="fld-row">
          <div class="fld" id="caps-fld">
            <span class="flt">Can</span>
            <div class="capabilities" id="capabilities"></div>
          </div>
          <div class="fld">
            <span class="flt">Voice</span>
            <select id="voice" aria-label="Voice">
              <option value="alba">🇺🇸 alba</option>
          <option value="anna">🇺🇸 anna</option>
          <option value="charles">🇺🇸 charles</option>
          <option value="eve">🇺🇸 eve</option>
          <option value="george" selected>🇺🇸 george</option>
          <option value="jane">🇺🇸 jane</option>
          <option value="jean">🇺🇸 jean</option>
          <option value="mary">🇺🇸 mary</option>
          <option value="michael">🇺🇸 michael</option>
          <option value="paul">🇬🇧 paul</option>
          <option value="vera">🇬🇧 vera</option>
          <option value="giovanni">🇮🇹 giovanni · Italian</option>
          <option value="lola">🇪🇸 lola · Spanish</option>
          <option value="juergen">🇩🇪 juergen · German</option>
          <option value="rafael">🇵🇹 rafael · Portuguese</option>
          <option value="estelle">🇫🇷 estelle · French</option>
            </select>
          </div>
        </div>
        <div class="sheet-note">Type over any field &middot; click a chip to give or take a tool &middot; applies to the next call</div>
      </div>
      <div class="deskrule"></div>
      <div class="callpad">
        <div class="viz idle" id="viz"></div>
        <button class="btn" id="btn">
          <svg id="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <rect x="9" y="2" width="6" height="10" rx="3"/>
            <path d="M19 10v1a7 7 0 01-14 0v-1"/><path d="M12 18v4"/><path d="M8 22h8"/>
          </svg>
          <span id="btn-label">Start call</span>
        </button>
        <div class="callmeta">
          <label class="phoneline">
            <input type="checkbox" id="phoneline">
            <span>Phone line</span>
          </label>
          <select id="mic" aria-label="Microphone"><option value="">Default microphone</option></select>
        </div>
        <div class="phonenote" id="phonenote" hidden>Playing at 8 kHz to simulate telephony audio</div>
      </div>
    </section>

    <section class="col-right">
      <div class="transcript" id="log">
        <div class="transcript-hd">
          <span>Call log<span id="call-dur"></span></span>
          <div class="speakers">
            <div class="speaker user" id="spk-user"><span class="dot"></span>Caller</div>
            <div class="speaker agent" id="spk-agent"><span class="dot"></span><span id="spk-agent-name">George</span></div>
          </div>
        </div>
        <div id="msgs">
          <div class="empty" id="empty-msg">
            <span class="try">Try</span>
            <span class="hint">Answer its questions the way a candidate would.</span>
          </div>
        </div>
      </div>
    </section>
  </div>

  <div class="plaque">
    <span>Everything else lives in code &middot; edit <b>SESSION</b> in <b>agent.mjs</b></span>
    <a class="configlink" href="https://www.assemblyai.com/docs/voice-agents/voice-agent-api/create-agent" target="_blank" rel="noreferrer">API reference</a>
  </div>
</main><script src="/app.js"></script>
</body>
</html>`

// --- server ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.url === '/token') {
    const upstream = await fetch(
      'https://agents.assemblyai.com/v1/token?product=voice_agent&expires_in_seconds=60',
      { headers: { Authorization: `Bearer ${API_KEY}` } }
    )
    res.writeHead(upstream.status, { 'content-type': 'application/json' })
    res.end(await upstream.text())
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

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && !process.env.PORT && port < 3010) {
    port += 1
    server.listen(port)
    return
  }
  throw err
})

server.on('listening', () => {
  console.log(`Voice agent running → http://localhost:${port}`)
})

server.listen(port)

// ============================================================================
// CHAT_HTML — Chat UI served at GET /chat. Extracted verbatim from worker.js
// so UI tweaks don't require touching request-routing code. Static template
// literal with NO ${} interpolation; esbuild inlines it back into the bundle,
// so the deployed output is identical.
// ============================================================================
export const CHAT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>HA Agent</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=DM+Sans:wght@400;500;600&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --surface-hover: #1a1a26;
    --border: #1e1e2e;
    --text: #e2e2e8;
    --text-dim: #6e6e82;
    --accent: #3b82f6;
    --accent-dim: #1e3a5f;
    --user-bg: #1a2742;
    --agent-bg: #16161e;
    --success: #22c55e;
    --warning: #f59e0b;
    --error: #ef4444;
    --radius: 12px;
  }

  html, body {
    height: 100%;
    overflow: hidden;
    background: var(--bg);
    color: var(--text);
    font-family: 'DM Sans', -apple-system, sans-serif;
  }

  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
    max-width: 720px;
    margin: 0 auto;
  }

  /* ── Header ── */
  .header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    flex-shrink: 0;
  }

  .header-icon-img {
    width: 36px; height: 36px;
    border-radius: 8px;
    object-fit: contain;
    flex-shrink: 0;
  }

  .header-info h1 {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .header-status {
    font-size: 11px;
    color: var(--text-dim);
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .status-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--success);
    display: inline-block;
  }

  .status-dot.offline { background: var(--error); }

  .header-actions {
    margin-left: auto;
    display: flex;
    gap: 8px;
  }

  .header-btn {
    background: var(--surface-hover);
    border: 1px solid var(--border);
    color: var(--text-dim);
    border-radius: 8px;
    padding: 6px 10px;
    font-size: 11px;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }

  .header-btn:hover { color: var(--text); border-color: var(--accent); }

  /* ── Messages ── */
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    scroll-behavior: smooth;
    -webkit-overflow-scrolling: touch;
    position: relative;
  }

  .messages::before {
    content: "";
    position: absolute;
    inset: 0;
    background-image: url("https://brands.home-assistant.io/_/homeassistant/icon.png");
    background-repeat: no-repeat;
    background-position: center;
    background-size: min(50%, 360px) auto;
    opacity: 0.08;
    pointer-events: none;
    z-index: 0;
  }

  .messages > * { position: relative; z-index: 1; }

  .messages::-webkit-scrollbar { width: 4px; }
  .messages::-webkit-scrollbar-track { background: transparent; }
  .messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

  .msg {
    max-width: 88%;
    padding: 12px 16px;
    border-radius: var(--radius);
    font-size: 14px;
    line-height: 1.55;
    word-wrap: break-word;
    animation: msgIn 0.2s ease-out;
  }

  @keyframes msgIn {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .msg.user {
    align-self: flex-end;
    background: var(--user-bg);
    border: 1px solid #243b5e;
    border-bottom-right-radius: 4px;
  }

  .msg.agent {
    align-self: flex-start;
    background: var(--agent-bg);
    border: 1px solid var(--border);
    border-bottom-left-radius: 4px;
  }

  .msg.agent .agent-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 6px;
    font-family: 'JetBrains Mono', monospace;
  }

  .msg.agent .msg-text { white-space: pre-wrap; }

  .msg.agent .actions-taken {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
    color: var(--success);
  }

  .msg.system {
    align-self: center;
    background: transparent;
    color: var(--text-dim);
    font-size: 12px;
    text-align: center;
    padding: 4px 12px;
    max-width: 100%;
  }

  .msg.error {
    align-self: center;
    background: rgba(239,68,68,0.1);
    border: 1px solid rgba(239,68,68,0.2);
    color: var(--error);
    font-size: 12px;
    font-family: 'JetBrains Mono', monospace;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
  }

  /* ── Message action buttons (copy / retry) ── */
  .msg-actions {
    display: flex;
    gap: 4px;
    margin-top: 8px;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .msg:hover .msg-actions,
  .msg:focus-within .msg-actions { opacity: 1; }

  .msg.user .msg-actions { justify-content: flex-end; }

  .bubble-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-dim);
    border-radius: 6px;
    padding: 3px 8px;
    font-size: 10px;
    font-family: 'JetBrains Mono', monospace;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    transition: all 0.15s;
    text-transform: lowercase;
    letter-spacing: 0.04em;
  }

  .bubble-btn:hover {
    color: var(--text);
    border-color: var(--accent);
    background: var(--surface-hover);
  }

  .bubble-btn svg { width: 11px; height: 11px; }

  .bubble-btn.copied {
    color: var(--success);
    border-color: var(--success);
  }

  .msg.error .bubble-btn {
    color: var(--error);
    border-color: rgba(239,68,68,0.4);
  }

  .msg.error .bubble-btn:hover {
    background: rgba(239,68,68,0.15);
    color: var(--error);
  }

  /* On touch devices, always show actions since hover doesn't apply */
  @media (hover: none) {
    .msg-actions { opacity: 0.65; }
  }

  /* ── Typing indicator ── */
  .typing {
    display: none;
    align-self: flex-start;
    padding: 12px 20px;
    background: var(--agent-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    border-bottom-left-radius: 4px;
    gap: 5px;
  }

  .typing.active { display: flex; align-items: center; }

  .minimax-mark {
    width: 56px;
    height: 32px;
    display: block;
  }

  .mm-bar {
    transform-origin: center;
    transform-box: fill-box;
    animation: mmwave 1.1s ease-in-out infinite;
  }

  .mm-bar:nth-child(1) { animation-delay: 0s; }
  .mm-bar:nth-child(2) { animation-delay: 0.08s; }
  .mm-bar:nth-child(3) { animation-delay: 0.16s; }
  .mm-bar:nth-child(4) { animation-delay: 0.24s; }
  .mm-bar:nth-child(5) { animation-delay: 0.32s; }
  .mm-bar:nth-child(6) { animation-delay: 0.40s; }

  @keyframes mmwave {
    0%, 100% { transform: scaleY(0.45); }
    50%      { transform: scaleY(1);    }
  }

  /* ── Input ── */
  .input-area {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 12px 12px max(18px, env(safe-area-inset-bottom));
    background: var(--surface);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  .input-row {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }

  #input {
    flex: 1;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    outline: none;
    color: var(--text);
    font-family: 'DM Sans', sans-serif;
    font-size: 15px;
    padding: 10px 12px;
    resize: none;
    max-height: 120px;
    line-height: 1.4;
    transition: border-color 0.15s;
  }

  #input:focus { border-color: var(--accent); }
  #input::placeholder { color: var(--text-dim); }

  #sendBtn {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: none;
    background: var(--accent);
    color: white;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: filter 0.15s, transform 0.1s;
  }

  #sendBtn:hover { filter: brightness(1.1); }
  #sendBtn:disabled { opacity: 0.4; cursor: not-allowed; }
  #sendBtn:active { transform: scale(0.96); }

  /* ── Mic button (hero) ── */
  .mic-row {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 12px;
  }

  .mic-aux-btn {
    justify-self: start;
    background: var(--surface-hover);
    border: 1px solid var(--border);
    color: var(--text-dim);
    border-radius: 10px;
    padding: 10px 14px;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
    -webkit-tap-highlight-color: transparent;
  }

  .mic-aux-btn:hover {
    color: var(--text);
    border-color: var(--accent);
  }

  .mic-aux-btn:active { transform: scale(0.97); }

  .mic-aux-spacer { display: block; }

  #micBtn {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    width: 96px;
    height: 96px;
    border-radius: 50%;
    border: none;
    background: var(--accent);
    color: white;
    cursor: pointer;
    box-shadow: 0 4px 14px rgba(59, 130, 246, 0.4);
    transition: background 0.2s, transform 0.1s, box-shadow 0.2s;
    flex-shrink: 0;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }

  #micBtn:active { transform: scale(0.96); }

  #micBtn .mic-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    max-width: 80px;
    text-align: center;
  }

  #micBtn[data-state="recording"] {
    background: #dc2626;
    box-shadow: 0 4px 14px rgba(220, 38, 38, 0.5);
    animation: micPulse 1.5s ease-in-out infinite;
  }

  #micBtn[data-state="processing"] {
    background: #6b7280;
    cursor: wait;
    box-shadow: 0 4px 14px rgba(107, 114, 128, 0.4);
  }

  @keyframes micPulse {
    0%, 100% { box-shadow: 0 4px 14px rgba(220, 38, 38, 0.5); }
    50%      { box-shadow: 0 4px 22px rgba(220, 38, 38, 0.85); }
  }

  @media (max-width: 480px) {
    #micBtn { width: 88px; height: 88px; }
  }

  /* ── Welcome ── */
  .welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: 12px;
    color: var(--text-dim);
    text-align: center;
    padding: 40px 20px;
  }

  .welcome-icon-img {
    width: 64px;
    height: 64px;
    border-radius: 14px;
    object-fit: contain;
    margin-bottom: 4px;
  }

  .welcome h2 {
    font-size: 18px;
    color: var(--text);
    font-weight: 600;
  }

  .welcome p {
    font-size: 13px;
    max-width: 300px;
    line-height: 1.5;
  }

  .quick-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    justify-content: center;
    margin-top: 16px;
    padding: 0 8px;
  }

  .quick-btn {
    background: var(--surface-hover);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 20px 32px;
    border-radius: 16px;
    font-size: 16px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
    min-height: 64px;
    -webkit-tap-highlight-color: transparent;
  }

  .quick-btn.garage {
    padding: 24px 36px;
    font-size: 18px;
    font-weight: 600;
    min-height: 80px;
    border-color: var(--accent);
    background: var(--accent-dim);
  }

  .quick-btn:hover {
    color: var(--text);
    border-color: var(--accent);
    background: var(--accent-dim);
  }

  .quick-btn.garage:active {
    transform: scale(0.97);
  }

  /* ── Markdown-ish formatting ── */
  .msg-text strong, .msg-text b { color: #fff; font-weight: 600; }

  .msg.reasoning {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85em;
    background: rgba(255, 255, 255, 0.03);
    border-left: 2px solid #444;
    padding: 2px 12px;
    margin: 4px 0 4px 16px;
    border-radius: 4px;
  }

  .msg.reasoning summary {
    cursor: pointer;
    color: #666;
    user-select: none;
    padding: 6px 0;
    list-style: none;
  }

  .msg.reasoning summary::-webkit-details-marker { display: none; }

  .msg.reasoning summary::before {
    content: '▶ ';
    font-size: 0.75em;
  }

  details.msg.reasoning[open] summary::before {
    content: '▼ ';
  }

  .msg.reasoning summary:hover { color: #8a8a8a; }

  .msg.reasoning .reasoning-body {
    color: #8a8a8a;
    white-space: pre-wrap;
    padding: 6px 0 8px;
    opacity: 0.8;
  }

  /* ── Bug trigger (above input box) ── */
  .bug-trigger-row {
    display: flex;
    justify-content: center;
    margin-bottom: 4px;
  }

  .bug-trigger-btn {
    background: transparent;
    border: 1px dashed rgba(239, 68, 68, 0.45);
    color: #ef4444;
    border-radius: 999px;
    padding: 7px 16px;
    font-size: 12px;
    font-family: inherit;
    font-weight: 500;
    cursor: pointer;
    letter-spacing: 0.02em;
    transition: all 0.15s;
    -webkit-tap-highlight-color: transparent;
  }

  .bug-trigger-btn:hover,
  .bug-trigger-btn:focus {
    background: rgba(239, 68, 68, 0.08);
    border-style: solid;
    outline: none;
  }

  .bug-trigger-btn:active { transform: scale(0.97); }

  /* ── Bug-report composer ── */
  .bug-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 100;
    align-items: center;
    justify-content: center;
    padding: 20px;
    backdrop-filter: blur(2px);
  }

  .bug-overlay.active { display: flex; }

  .bug-composer {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    width: 100%;
    max-width: 480px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  }

  .bug-title { font-size: 16px; font-weight: 600; color: var(--text); }
  .bug-sub   { font-size: 12px; color: var(--text-dim); line-height: 1.5; }

  #bugInput {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    padding: 10px 12px;
    font-family: 'DM Sans', sans-serif;
    font-size: 14px;
    line-height: 1.45;
    resize: vertical;
    min-height: 90px;
    outline: none;
  }

  #bugInput:focus     { border-color: var(--accent); }
  #bugInput::placeholder { color: var(--text-dim); }

  .bug-row {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  .bug-btn {
    border-radius: 8px;
    padding: 8px 14px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--border);
    transition: all 0.15s;
  }

  .bug-btn-secondary {
    background: transparent;
    color: var(--text-dim);
  }

  .bug-btn-secondary:hover {
    color: var(--text);
    border-color: var(--text-dim);
  }

  .bug-btn-primary {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }

  .bug-btn-primary:hover { filter: brightness(1.1); }

  .bug-hint {
    font-size: 11px;
    color: var(--text-dim);
    text-align: right;
    margin-top: -4px;
  }
</style>
</head>
<body>
<div class="app">
  <div class="header">
    <img class="header-icon-img" src="https://brands.home-assistant.io/_/homeassistant/icon.png" alt="Home Assistant" />
    <div class="header-info">
      <h1>HA Agent</h1>
      <div class="header-status">
        <span class="status-dot" id="statusDot"></span>
        <span id="statusText">Connecting...</span>
      </div>
    </div>
  </div>

  <div class="messages" id="messages">
    <div class="welcome" id="welcome">
      <img class="welcome-icon-img" src="https://brands.home-assistant.io/_/homeassistant/icon.png" alt="" />
      <h2>HA Agent</h2>
      <p>Chat with your smart home. Ask about status, control devices, or just say hello.</p>
      <div class="quick-actions">
        <button class="quick-btn" onclick="sendQuick('What is the status of the house?')">House status</button>
        <button class="quick-btn garage" onclick="sendQuick('Open the main garage door')">Open main garage</button>
        <button class="quick-btn garage" onclick="sendQuick('Close the main garage door')">Close main garage</button>
        <button class="quick-btn garage" onclick="sendQuick('Open the basement bay door')">Open basement</button>
        <button class="quick-btn garage" onclick="sendQuick('Close the basement bay door')">Close basement</button>
        <button class="quick-btn" onclick="sendQuick(&quot;What's the climate? Inside temp, AC status, outside temp, today's high and low&quot;)">Climate</button>
      </div>
    </div>
  </div>

  <div class="typing" id="typing">
    <svg class="minimax-mark" viewBox="0 0 64 40" aria-hidden="true">
      <defs>
        <linearGradient id="mmGrad" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stop-color="#FF4D7E"/>
          <stop offset="100%" stop-color="#FF6A2E"/>
        </linearGradient>
      </defs>
      <g fill="url(#mmGrad)">
        <rect class="mm-bar" x="2"  y="14" width="6" height="14" rx="3"/>
        <rect class="mm-bar" x="12" y="6"  width="6" height="28" rx="3"/>
        <rect class="mm-bar" x="22" y="2"  width="6" height="36" rx="3"/>
        <rect class="mm-bar" x="32" y="10" width="6" height="22" rx="3"/>
        <rect class="mm-bar" x="42" y="4"  width="6" height="32" rx="3"/>
        <rect class="mm-bar" x="52" y="12" width="6" height="18" rx="3"/>
      </g>
    </svg>
  </div>

  <div class="input-area">
    <div class="bug-trigger-row">
      <button class="bug-trigger-btn" type="button" onclick="openBugComposer()">Report a bug</button>
    </div>
    <div class="input-row">
      <textarea id="input" placeholder="Message your home..." rows="1"></textarea>
      <button id="sendBtn" type="button" aria-label="Send" onclick="send()">
        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
          <path d="M2 12l20-9-9 20-2-9-9-2z"/>
        </svg>
      </button>
    </div>
    <div class="mic-row">
      <button class="mic-aux-btn" type="button" onclick="clearChat()">Clear</button>
      <button id="micBtn" type="button" aria-label="Tap to speak" data-state="idle">
        <span class="mic-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
            <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zm5 9a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/>
          </svg>
        </span>
        <span class="mic-label">Tap to speak</span>
      </button>
      <span class="mic-aux-spacer"></span>
    </div>
  </div>
</div>

<div class="bug-overlay" id="bugOverlay" onclick="closeBugComposer(event)">
  <div class="bug-composer" onclick="event.stopPropagation()">
    <div class="bug-title">Report a bug</div>
    <div class="bug-sub">Describe what went wrong. The agent logs your description plus the last few turns and the state of any cited entities.</div>
    <textarea id="bugInput" placeholder="The agent did X but it should have done Y…" rows="4"></textarea>
    <div class="bug-row">
      <button class="bug-btn bug-btn-secondary" onclick="closeBugComposer()">Cancel</button>
      <button class="bug-btn bug-btn-primary" onclick="submitBug()">Submit</button>
    </div>
    <div class="bug-hint">Esc to cancel · Cmd/Ctrl+Enter to submit</div>
  </div>
</div>

<script>
  const msgEl = document.getElementById('messages');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');
  const typing = document.getElementById('typing');
  const welcome = document.getElementById('welcome');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  // Auto-resize textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  // Enter to send (shift+enter for newline)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // Check agent status on load
  checkStatus();

  function checkStatus() {
    fetch('/health')
      .then(r => r.json())
      .then(d => {
        const ok = d.websocket && d.websocket.connected;
        statusDot.className = 'status-dot' + (ok ? '' : ' offline');
        statusText.textContent = ok ? 'Online · ' + (d.websocket.cached_entities || 0) + ' entities' : 'Disconnected';
      })
      .catch(() => {
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'Unreachable';
      });
  }

  let lastUserMessage = null;

  // SVG icon helpers (template literals)
  const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  const ICON_RETRY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>';

  function sendQuick(text) {
    input.value = text;
    send();
  }

  function makeCopyBtn(text) {
    const btn = document.createElement('button');
    btn.className = 'bubble-btn';
    btn.type = 'button';
    btn.innerHTML = ICON_COPY + '<span>copy</span>';
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Fallback for non-secure contexts
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch {}
        document.body.removeChild(ta);
      }
      btn.classList.add('copied');
      btn.innerHTML = ICON_CHECK + '<span>copied</span>';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = ICON_COPY + '<span>copy</span>';
      }, 1400);
    };
    return btn;
  }

  function makeRetryBtn() {
    const btn = document.createElement('button');
    btn.className = 'bubble-btn';
    btn.type = 'button';
    btn.innerHTML = ICON_RETRY + '<span>retry</span>';
    btn.onclick = () => {
      if (!lastUserMessage) return;
      // Remove the error bubble we're attached to
      const parent = btn.closest('.msg');
      if (parent && parent.parentNode) parent.parentNode.removeChild(parent);
      input.value = lastUserMessage;
      send();
    };
    return btn;
  }

  function makeReportBtn(errorText) {
    const btn = document.createElement('button');
    btn.className = 'bubble-btn';
    btn.type = 'button';
    btn.innerHTML = '<span>🐛 report</span>';
    btn.onclick = () => {
      const ctx = [];
      if (lastUserMessage) ctx.push('I sent: "' + lastUserMessage + '"');
      if (errorText)       ctx.push('Got error: ' + errorText);
      ctx.push('');
      ctx.push('What went wrong: ');
      openBugComposer(ctx.join('\\n'));
    };
    return btn;
  }

  // ── Bug-report composer ──
  function openBugComposer(prefill) {
    const overlay = document.getElementById('bugOverlay');
    const input   = document.getElementById('bugInput');
    if (typeof prefill === 'string') input.value = prefill;
    overlay.classList.add('active');
    setTimeout(() => {
      input.focus();
      // Cursor at end
      const len = input.value.length;
      input.setSelectionRange(len, len);
    }, 30);
  }

  function closeBugComposer(e) {
    // If invoked as a click handler on the overlay, ignore clicks bubbled from the composer.
    if (e && e.type === 'click' && e.target !== e.currentTarget) return;
    document.getElementById('bugOverlay').classList.remove('active');
    document.getElementById('bugInput').value = '';
  }

  function submitBug() {
    const bugInput = document.getElementById('bugInput');
    const text = bugInput.value.trim();
    if (!text) return;
    closeBugComposer();
    const message = 'Log as bug: ' + text;
    const mainInput = document.getElementById('input');
    mainInput.value = message;
    send();
  }

  // Keyboard shortcuts inside the composer
  document.addEventListener('keydown', (e) => {
    const overlay = document.getElementById('bugOverlay');
    if (!overlay || !overlay.classList.contains('active')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeBugComposer();
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submitBug();
    }
  });

  function addMsg(role, text, actions) {
    if (welcome) welcome.style.display = 'none';

    const div = document.createElement('div');
    div.className = 'msg ' + role;

    if (role === 'agent') {
      const label = document.createElement('div');
      label.className = 'agent-label';
      label.textContent = 'agent';
      div.appendChild(label);

      const body = document.createElement('div');
      body.className = 'msg-text';
      // Basic markdown: **bold**
      body.innerHTML = text
        .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\n/g, '<br>');
      div.appendChild(body);

      if (actions && actions.length > 0) {
        const actDiv = document.createElement('div');
        actDiv.className = 'actions-taken';
        actDiv.textContent = '⚡ ' + actions.join(', ');
        div.appendChild(actDiv);
      }

      const acts = document.createElement('div');
      acts.className = 'msg-actions';
      acts.appendChild(makeCopyBtn(text));
      div.appendChild(acts);
    } else if (role === 'error') {
      const body = document.createElement('div');
      body.textContent = text;
      div.appendChild(body);

      const acts = document.createElement('div');
      acts.className = 'msg-actions';
      acts.style.opacity = '1'; // always visible on errors
      if (lastUserMessage) acts.appendChild(makeRetryBtn());
      acts.appendChild(makeReportBtn(text));
      acts.appendChild(makeCopyBtn(text));
      div.appendChild(acts);
    } else if (role === 'user') {
      const body = document.createElement('div');
      body.className = 'msg-text';
      body.textContent = text;
      div.appendChild(body);

      const acts = document.createElement('div');
      acts.className = 'msg-actions';
      acts.appendChild(makeCopyBtn(text));
      div.appendChild(acts);
    } else {
      div.textContent = text;
    }

    msgEl.appendChild(div);
    msgEl.scrollTop = msgEl.scrollHeight;
  }

  function addReasoning(text) {
    const det = document.createElement('details');
    det.className = 'msg reasoning';
    const sum = document.createElement('summary');
    sum.textContent = 'reasoning';
    det.appendChild(sum);
    const body = document.createElement('div');
    body.className = 'reasoning-body';
    body.textContent = text;
    det.appendChild(body);
    msgEl.appendChild(det);
    msgEl.scrollTop = msgEl.scrollHeight;
  }

  async function send() {
    const text = input.value.trim();
    if (!text) return;

    lastUserMessage = text;
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;
    window.__chatRetried = false;

    addMsg('user', text);
    typing.classList.add('active');
    msgEl.scrollTop = msgEl.scrollHeight;

    let statusEl = null;

    function showStatus(msg) {
      if (!statusEl) {
        statusEl = document.createElement('div');
        statusEl.className = 'msg system';
        msgEl.appendChild(statusEl);
      }
      statusEl.textContent = msg;
      msgEl.scrollTop = msgEl.scrollHeight;
    }

    function clearStatus() {
      if (statusEl) { msgEl.removeChild(statusEl); statusEl = null; }
    }

    try {
      const resp = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({ message: text })
      });

      if (!resp.ok || !resp.body) {
        typing.classList.remove('active');
        addMsg('error', 'Agent error: ' + resp.status);
        sendBtn.disabled = false;
        input.focus();
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const lines = buf.split('\\n');
        buf = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let evt;
          try { evt = JSON.parse(line.slice(6)); } catch { continue; }

          if (evt.type === 'started') {
            // server alive — no UI action needed
          } else if (evt.type === 'reasoning') {
            addReasoning(evt.text);
          } else if (evt.type === 'thinking') {
            showStatus('Thinking…');
          } else if (evt.type === 'tool_call') {
            showStatus('⚡ ' + (evt.label || evt.name) + '…');
          } else if (evt.type === 'tool_result') {
            showStatus((evt.ok ? '✓ ' : '✗ ') + evt.name);
          } else if (evt.type === 'reply') {
            typing.classList.remove('active');
            clearStatus();
            addMsg('agent', evt.text || 'No response.');
          } else if (evt.type === 'error') {
            typing.classList.remove('active');
            clearStatus();
            addMsg('error', evt.message || 'Agent error');
          }
        }
      }

      typing.classList.remove('active');
      clearStatus();

    } catch (err) {
      const retryable = /load failed|network|fetch/i.test(err.message || '');
      if (retryable && !window.__chatRetried) {
        window.__chatRetried = true;
        showStatus('Reconnecting…');
        try {
          const resp2 = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
            body: JSON.stringify({ message: text })
          });
          if (resp2.ok && resp2.body) {
            const reader = resp2.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const lines = buf.split('\\n');
              buf = lines.pop();
              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                let evt;
                try { evt = JSON.parse(line.slice(6)); } catch { continue; }
                if (evt.type === 'started') {
                  // server alive
                } else if (evt.type === 'reasoning') {
                  addReasoning(evt.text);
                } else if (evt.type === 'thinking') {
                  showStatus('Thinking…');
                } else if (evt.type === 'tool_call') {
                  showStatus('⚡ ' + (evt.label || evt.name) + '…');
                } else if (evt.type === 'tool_result') {
                  showStatus((evt.ok ? '✓ ' : '✗ ') + evt.name);
                } else if (evt.type === 'reply') {
                  typing.classList.remove('active');
                  clearStatus();
                  addMsg('agent', evt.text || 'No response.');
                } else if (evt.type === 'error') {
                  typing.classList.remove('active');
                  clearStatus();
                  addMsg('error', evt.message || 'Agent error');
                }
              }
            }
            typing.classList.remove('active');
            clearStatus();
            window.__chatRetried = false;
            sendBtn.disabled = false;
            input.focus();
            return;
          }
        } catch (err2) {
          // fall through to error display
        }
        window.__chatRetried = false;
      }
      typing.classList.remove('active');
      clearStatus();
      addMsg('error', 'Failed to reach agent: ' + err.message);
    }

    sendBtn.disabled = false;
    input.focus();
  }

  function clearChat() {
    while (msgEl.children.length > 1) {
      msgEl.removeChild(msgEl.lastChild);
    }
    if (welcome) welcome.style.display = 'flex';
    lastUserMessage = null;
  }

  // ── Voice input (ElevenLabs Scribe) — 3-state machine ──
  const micBtn = document.getElementById('micBtn');
  const micLabel = micBtn.querySelector('.mic-label');
  let mediaRecorder = null;
  let audioChunks = [];
  let micStream = null;

  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/mpeg',
      'audio/ogg;codecs=opus'
    ];
    for (const c of candidates) {
      try { if (MediaRecorder.isTypeSupported(c)) return c; } catch {}
    }
    return '';
  }

  function setMicState(state) {
    micBtn.setAttribute('data-state', state);
    if (state === 'idle') {
      micLabel.textContent = 'Tap to speak';
      micBtn.disabled = false;
    } else if (state === 'recording') {
      micLabel.textContent = 'Send';
      micBtn.disabled = false;
    } else if (state === 'processing') {
      micLabel.textContent = '…';
      micBtn.disabled = true;
    }
  }
  setMicState('idle');

  micBtn.addEventListener('click', async () => {
    const state = micBtn.getAttribute('data-state');

    if (state === 'idle') {
      if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') {
        addMsg('error', 'Voice input not supported in this browser.');
        return;
      }
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            noiseSuppression: true,
            echoCancellation: true,
            autoGainControl: true
          }
        });
        audioChunks = [];
        const mime = pickMime();
        try {
          mediaRecorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : undefined);
        } catch {
          mediaRecorder = new MediaRecorder(micStream);
        }
        mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) audioChunks.push(e.data);
        };
        mediaRecorder.onstop = async () => {
          if (micStream) {
            micStream.getTracks().forEach(t => t.stop());
            micStream = null;
          }
          setMicState('processing');
          try {
            const recMime = (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm';
            const blob = new Blob(audioChunks, { type: recMime });
            if (blob.size < 800) {
              addMsg('error', 'No audio captured. Try again.');
              setMicState('idle');
              return;
            }
            const resp = await fetch('/transcribe', {
              method: 'POST',
              headers: { 'Content-Type': recMime },
              body: blob
            });
            if (!resp.ok) {
              let detail = '';
              try { detail = (await resp.text()).slice(0, 200); } catch {}
              throw new Error('HTTP ' + resp.status + (detail ? ' — ' + detail : ''));
            }
            const data = await resp.json();
            const text = (data.text || '').trim();
            if (text) {
              input.value = text;
              input.style.height = 'auto';
              send();
            } else {
              addMsg('error', 'No speech detected.');
            }
          } catch (err) {
            addMsg('error', 'Voice input failed: ' + err.message);
          } finally {
            setMicState('idle');
          }
        };
        mediaRecorder.start();
        setMicState('recording');
      } catch (err) {
        addMsg('error', 'Mic access denied: ' + err.message);
        setMicState('idle');
      }
    } else if (state === 'recording') {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
    }
    // 'processing' — button disabled, no-op
  });
</script>
</body>
</html>`;

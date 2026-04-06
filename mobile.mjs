// mobile.mjs — Mobile single-card terminal client
// Connects to /ws/dashboard (same as desktop), subscribes to ONE session at a time.

// --- State ---
let ws = null;
let apiKey = null;
let sessions = [];           // [{name, cols, rows, title, source}, ...]
let currentSession = null;   // name of the currently subscribed session
let serverVersion = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let screenApplied = false;   // true after first full 'screen' received
let pendingMessages = [];    // queued messages before SVG <object> is ready
let svgReady = false;        // true once terminal.svg has loaded and renderMessage exists

// Terminal dimensions — updated from screen messages, changed by +/- buttons
let terminalCols = 80;
let terminalRows = 24;

// --- DOM refs ---
const sessionDropdown = document.getElementById('session-dropdown');
const terminalObj = document.getElementById('terminal-obj');
const sessionOverlay = document.getElementById('session-overlay');
const hamburgerBtn = document.getElementById('hamburger-btn');
const hamburgerMenu = document.getElementById('hamburger-menu');
const textInput = document.getElementById('text-input');

// --- WS connection ---

function fetchApiKeyAndConnect() {
  fetch('/auth/api-key', { credentials: 'same-origin' })
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (data && data.key) apiKey = data.key;
      connectWs();
    })
    .catch(function() {
      // API key fetch failed — try connecting without key (cookie auth may work)
      connectWs();
    });
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const keyParam = apiKey ? '?key=' + encodeURIComponent(apiKey) : '';
  const url = proto + '//' + location.host + '/ws/dashboard' + keyParam;
  ws = new WebSocket(url);

  ws.onopen = function() {
    console.log('[Mobile WS] connected');
    reconnectAttempt = 0;
    // Do NOT subscribe to all sessions — wait for session-add events
    // and subscribe to one.
  };

  ws.onmessage = function(ev) {
    try {
      routeMessage(JSON.parse(ev.data));
    } catch (e) {
      console.warn('[Mobile WS] bad message', e);
    }
  };

  ws.onclose = function() {
    ws = null;
    currentSession = null;
    screenApplied = false;
    scheduleReconnect();
  };

  ws.onerror = function() {
    // onclose will fire after this and handle reconnect
  };
}

function sendMessage(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function scheduleReconnect() {
  reconnectAttempt++;
  const delay = Math.min(2000 * Math.pow(2, reconnectAttempt - 1), 30000);
  console.log('[Mobile WS] reconnecting in ' + delay + 'ms (attempt ' + reconnectAttempt + ')');
  setTimeout(function() {
    // Refresh API key before reconnecting (same pattern as desktop)
    fetch('/auth/api-key', { credentials: 'same-origin' })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (data && data.key) { apiKey = data.key; reconnectAttempt = 0; }
        connectWs();
      })
      .catch(function() {
        connectWs();
      });
  }, delay);
}

// --- Message routing ---

function routeMessage(msg) {
  if (msg.type === 'version') {
    if (serverVersion === null) {
      serverVersion = msg.version;
    } else if (serverVersion !== msg.version) {
      location.reload();
      return;
    }
    return;
  }

  if (msg.type === 'reauth-required') {
    location.href = '/login';
    return;
  }

  if (msg.type === 'session-add') {
    addSession(msg);
    return;
  }

  if (msg.type === 'session-remove') {
    removeSession(msg.session);
    return;
  }

  // Per-session messages (screen, delta, session-settings)
  if (msg.session && msg.session === currentSession) {
    if (msg.type === 'screen') {
      // Update our tracked dimensions from server truth
      if (msg.cols) terminalCols = msg.cols;
      if (msg.rows) terminalRows = msg.rows;
      screenApplied = true;
      routeToTerminalSvg(msg);
    } else if (msg.type === 'delta') {
      if (!screenApplied) {
        // Delta before screen — request full screen heal
        sendMessage({ type: 'get-screen', session: currentSession, pane: '0' });
        return;
      }
      routeToTerminalSvg(msg);
    }
  }
}

// --- Terminal SVG rendering ---

function routeToTerminalSvg(msg) {
  const obj = terminalObj;
  if (svgReady && obj && obj.contentWindow && typeof obj.contentWindow.renderMessage === 'function') {
    obj.contentWindow.renderMessage(msg);
  } else {
    // Queue until SVG is loaded
    pendingMessages.push(msg);
  }
}

function flushPendingMessages() {
  if (!svgReady) return;
  const obj = terminalObj;
  if (!obj || !obj.contentWindow || typeof obj.contentWindow.renderMessage !== 'function') return;
  while (pendingMessages.length > 0) {
    const msg = pendingMessages.shift();
    obj.contentWindow.renderMessage(msg);
  }
}

// Wait for terminal.svg to load
terminalObj.addEventListener('load', function() {
  // Check if renderMessage is available (it may take a moment for the SVG script to init)
  function checkReady() {
    if (terminalObj.contentWindow && typeof terminalObj.contentWindow.renderMessage === 'function') {
      svgReady = true;
      console.log('[Mobile] terminal.svg ready');
      flushPendingMessages();
      fitTerminalToWidth();
    } else {
      setTimeout(checkReady, 50);
    }
  }
  checkReady();
});

// --- Session management ---

function addSession(msg) {
  if (sessions.find(function(s) { return s.name === msg.session; })) return; // duplicate
  sessions.push({
    name: msg.session,
    cols: msg.cols || 80,
    rows: msg.rows || 24,
    title: msg.title || msg.session,
    source: msg.source || 'claude-proxy',
  });
  updateDropdown();

  // Auto-subscribe to first session if none selected
  if (!currentSession) {
    const lastUsed = localStorage.getItem('mobile-last-session');
    const target = (lastUsed && sessions.find(function(s) { return s.name === lastUsed; }))
      ? lastUsed : sessions[0].name;
    switchSession(target);
  }
}

function removeSession(sessionName) {
  sessions = sessions.filter(function(s) { return s.name !== sessionName; });
  updateDropdown();

  // If the current session was removed, switch to the first available
  if (currentSession === sessionName) {
    currentSession = null;
    screenApplied = false;
    if (sessions.length > 0) {
      switchSession(sessions[0].name);
    }
  }
}

function switchSession(sessionName) {
  if (sessionName === currentSession) return;
  if (currentSession) {
    sendMessage({ type: 'unsubscribe', session: currentSession });
  }
  currentSession = sessionName;
  screenApplied = false;
  pendingMessages = [];
  localStorage.setItem('mobile-last-session', sessionName);
  sessionDropdown.value = sessionName;

  // Subscribe — server will send back screen data
  sendMessage({
    type: 'subscribe',
    session: sessionName,
    source: 'claude-proxy',
  });
}

function subscribeToSession(sessionName) {
  sendMessage({
    type: 'subscribe',
    session: sessionName,
    source: 'claude-proxy',
  });
}

function unsubscribeFromSession(sessionName) {
  sendMessage({ type: 'unsubscribe', session: sessionName });
}

// --- Dropdown ---

function updateDropdown() {
  sessionDropdown.innerHTML = '';
  if (sessions.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No sessions';
    sessionDropdown.appendChild(opt);
    return;
  }
  for (const s of sessions) {
    const opt = document.createElement('option');
    opt.value = s.name;
    // Strip cp- prefix for display, show title if available
    opt.textContent = s.title || s.name.replace(/^cp-/, '');
    sessionDropdown.appendChild(opt);
  }
  if (currentSession) sessionDropdown.value = currentSession;
}

sessionDropdown.addEventListener('change', function() {
  if (this.value) switchSession(this.value);
});

// --- Hamburger menu ---

hamburgerBtn.addEventListener('click', function() {
  hamburgerMenu.classList.toggle('hidden');
});

// Close menu on outside tap
document.addEventListener('click', function(e) {
  if (!hamburgerMenu.contains(e.target) && e.target !== hamburgerBtn) {
    hamburgerMenu.classList.add('hidden');
  }
});

// --- Terminal fit-to-width scaling (Task 7) ---

function fitTerminalToWidth() {
  const obj = terminalObj;
  if (!obj || !obj.contentDocument) return;

  const svgEl = obj.contentDocument.querySelector('svg');
  if (!svgEl) return;

  // Ensure the SVG scales proportionally within its container via viewBox.
  // Set preserveAspectRatio for top-left alignment with fit-to-width.
  svgEl.setAttribute('preserveAspectRatio', 'xMinYMin meet');
}

// Handle orientation change / resize events
window.addEventListener('resize', function() {
  fitTerminalToWidth();
});

window.addEventListener('orientationchange', function() {
  // Delay slightly — viewport dimensions may not update immediately
  setTimeout(fitTerminalToWidth, 200);
});

// --- +/- Text size (resize terminal cols/rows, same as desktop) ---

document.getElementById('size-decrease').addEventListener('click', function() {
  // Smaller text = more cols fit
  terminalCols = Math.min(terminalCols + 4, 300);
  terminalRows = Math.max(5, Math.min(100, Math.round(terminalCols / ((terminalCols - 4) / (terminalRows || 24)))));
  sendResize();
  this.blur();
});

document.getElementById('size-increase').addEventListener('click', function() {
  // Bigger text = fewer cols
  terminalCols = Math.max(20, terminalCols - 4);
  terminalRows = Math.max(5, Math.min(100, Math.round(terminalCols / ((terminalCols + 4) / (terminalRows || 24)))));
  sendResize();
  this.blur();
});

function sendResize() {
  if (!currentSession) return;
  sendMessage({
    type: 'resize',
    session: currentSession,
    pane: '0',
    cols: terminalCols,
    rows: terminalRows,
  });
}

// --- Phase 5: Touch gestures (Tasks 8-11) ---

const terminalArea = document.getElementById('terminal-area');
const touchOverlay = document.getElementById('touch-overlay');
let touchState = null; // { startX, startY, startTime, mode: null|'scroll'|'select'|'swipe', lastX, lastY }
let scrollOffset = 0;

// Attach to touch overlay — <object> swallows events, overlay sits on top
touchOverlay.addEventListener('touchstart', onTouchStart, { passive: false });
touchOverlay.addEventListener('touchmove', onTouchMove, { passive: false });
touchOverlay.addEventListener('touchend', onTouchEnd, { passive: false });

function onTouchStart(e) {
  if (e.touches.length !== 1) return;
  const t = e.touches[0];
  scrollPixelAccum = 0; // reset for new gesture
  touchState = {
    startX: t.clientX,
    startY: t.clientY,
    startTime: Date.now(),
    mode: null,
    lastX: t.clientX,
    lastY: t.clientY,
  };
}

function onTouchMove(e) {
  if (!touchState || e.touches.length !== 1) return;
  e.preventDefault(); // prevent browser scroll/zoom
  const t = e.touches[0];
  const dx = t.clientX - touchState.startX;
  const dy = t.clientY - touchState.startY;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  if (!touchState.mode) {
    // Determine gesture mode
    if (adx > 20 && ady < 10) {
      touchState.mode = 'swipe';
    } else if (adx > 10 && touchState.mode !== 'scroll') {
      touchState.mode = 'select';
    } else if (ady > 10 && adx < 10) {
      touchState.mode = 'scroll';
    }
  }

  if (touchState.mode === 'scroll') {
    handleScroll(t.clientY - touchState.lastY);
  } else if (touchState.mode === 'select') {
    handleSelection(t.clientX, t.clientY);
  }
  // swipe: no action during move, evaluated on touchend

  touchState.lastX = t.clientX;
  touchState.lastY = t.clientY;
}

function onTouchEnd(e) {
  if (!touchState) return;
  const dx = (touchState.lastX || 0) - touchState.startX;
  const elapsed = Date.now() - touchState.startTime;

  if (touchState.mode === 'swipe' && Math.abs(dx) > 100) {
    if (dx < 0) {
      switchToNextSession();
    } else {
      switchToPrevSession();
    }
  } else if (touchState.mode === 'select') {
    copySelectionToClipboard();
  } else if (!touchState.mode && elapsed < 300) {
    // Tap — focus input field
    textInput.focus();
  }

  touchState = null;
}

// --- Task 9: Scroll via touch drag ---

var scrollPixelAccum = 0; // accumulate sub-line pixel deltas

function handleScroll(deltaY) {
  const lineHeight = 8; // px per scroll line — lower = faster/more sensitive
  scrollPixelAccum += deltaY;

  // Only scroll when a full line of pixels has accumulated
  const lines = Math.trunc(scrollPixelAccum / lineHeight);
  if (lines === 0) return;

  scrollPixelAccum -= lines * lineHeight; // keep remainder for smooth feel
  scrollOffset = Math.max(0, scrollOffset + lines);
  sendMessage({
    type: 'scroll',
    session: currentSession,
    pane: '0',
    offset: scrollOffset,
  });
}

function resetScroll() {
  scrollOffset = 0;
  scrollPixelAccum = 0;
}

// --- Task 10: Swipe to switch session ---

function switchToNextSession() {
  const idx = sessions.findIndex(function(s) { return s.name === currentSession; });
  if (idx < 0 || idx >= sessions.length - 1) return;
  animateSwitch(sessions[idx + 1].name, 'left');
}

function switchToPrevSession() {
  const idx = sessions.findIndex(function(s) { return s.name === currentSession; });
  if (idx <= 0) return;
  animateSwitch(sessions[idx - 1].name, 'right');
}

function animateSwitch(newSession, direction) {
  // Show session name overlay
  const s = sessions.find(function(s) { return s.name === newSession; });
  sessionOverlay.textContent = (s && s.title) ? s.title : newSession;
  sessionOverlay.classList.remove('hidden');

  // Slide animation on terminal
  const obj = terminalObj;
  obj.style.transition = 'transform 0.25s ease-out, opacity 0.25s';
  obj.style.transform = direction === 'left' ? 'translateX(-100%)' : 'translateX(100%)';
  obj.style.opacity = '0';

  setTimeout(function() {
    resetScroll();
    switchSession(newSession);
    // Slide in from opposite side
    obj.style.transition = 'none';
    obj.style.transform = direction === 'left' ? 'translateX(100%)' : 'translateX(-100%)';
    requestAnimationFrame(function() {
      obj.style.transition = 'transform 0.25s ease-out, opacity 0.25s';
      obj.style.transform = 'translateX(0)';
      obj.style.opacity = '1';
    });

    // Hide overlay after animation
    setTimeout(function() {
      sessionOverlay.classList.add('hidden');
    }, 600);
  }, 250);
}

// --- Task 11: Selection gesture (basic version) ---

function handleSelection(clientX, clientY) {
  // Selection within SVG <object> is limited.
  // For v1: log coordinates for debugging. Full text selection
  // may require inline SVG or HTML rendering in a future iteration.
  console.log('[Selection] at', clientX, clientY);
}

function copySelectionToClipboard() {
  // Attempt to read selection from SVG document
  const svgDoc = terminalObj.contentDocument;
  if (svgDoc) {
    const sel = svgDoc.getSelection ? svgDoc.getSelection() : null;
    if (sel && sel.toString()) {
      navigator.clipboard.writeText(sel.toString()).catch(function() {});
    }
  }
}

// --- Phase 6: Input bar + special keys (Tasks 12-13) ---

// Task 12: Text input handling
textInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const text = textInput.value;
    if (!currentSession) return;

    sendMessage({
      type: 'input',
      session: currentSession,
      pane: '0',
      keys: text + '\r',
    });
    textInput.value = '';
    resetScroll();
  }
});

// Task 13: Special key buttons
var specialKeyMap = {
  'ctrl-c':     { keys: '\x03' },
  'tab':        { keys: '\t' },
  'arrow-up':   { specialKey: 'Up' },
  'arrow-down': { specialKey: 'Down' },
  'escape':     { keys: '\x1b' },
  'ctrl-z':     { keys: '\x1a' },
  'ctrl-d':     { keys: '\x04' },
  'ctrl-l':     { keys: '\x0c' },
};

document.getElementById('special-keys').addEventListener('click', function(e) {
  var btn = e.target.closest('button[data-key]');
  if (!btn || !currentSession) return;

  var keyDef = specialKeyMap[btn.dataset.key];
  if (!keyDef) return;

  var msg = {
    type: 'input',
    session: currentSession,
    pane: '0',
  };
  if (keyDef.keys) msg.keys = keyDef.keys;
  if (keyDef.specialKey) msg.specialKey = keyDef.specialKey;
  sendMessage(msg);
  resetScroll();
  btn.blur();
});

// --- Phase 7: Voice input (Task 14) ---

var voiceBtn = document.getElementById('voice-btn');
var recognition = null;
var isListening = false;

function initVoice() {
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    voiceBtn.classList.add('unsupported');
    voiceBtn.title = 'Speech recognition not supported in this browser';
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = function(event) {
    var interim = '';
    var final = '';
    for (var i = event.resultIndex; i < event.results.length; i++) {
      var transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        final += transcript;
      } else {
        interim += transcript;
      }
    }

    if (final) {
      textInput.value = final;
      textInput.style.color = '';
    } else if (interim) {
      textInput.value = interim;
      textInput.style.color = '#888';
    }
  };

  recognition.onend = function() {
    isListening = false;
    voiceBtn.classList.remove('listening');
    textInput.style.color = '';
  };

  recognition.onerror = function(event) {
    console.warn('[Voice] error:', event.error);
    isListening = false;
    voiceBtn.classList.remove('listening');
  };
}

voiceBtn.addEventListener('click', function() {
  if (!recognition) return;

  if (isListening) {
    recognition.abort();
    isListening = false;
    voiceBtn.classList.remove('listening');
  } else {
    textInput.value = '';
    recognition.start();
    isListening = true;
    voiceBtn.classList.add('listening');
  }
});

initVoice();

// --- Keyboard-aware input positioning ---
// When the virtual keyboard opens, visualViewport shrinks but window.innerHeight doesn't (on iOS).
// Position the input area at the bottom of the visual viewport so it floats above the keyboard.
(function setupKeyboardTracking() {
  const inputArea = document.getElementById('input-area');
  const terminalArea = document.getElementById('terminal-area');
  if (!inputArea) return;

  function updatePosition() {
    if (window.visualViewport) {
      const vv = window.visualViewport;
      const keyboardHeight = window.innerHeight - vv.height - vv.offsetTop;
      if (keyboardHeight > 50) {
        // Keyboard is open — position input area above it
        inputArea.style.bottom = keyboardHeight + 'px';
      } else {
        inputArea.style.bottom = '0';
      }
    }
    // Update CSS variable for terminal padding
    if (terminalArea && inputArea) {
      terminalArea.style.paddingBottom = inputArea.offsetHeight + 'px';
    }
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updatePosition);
    window.visualViewport.addEventListener('scroll', updatePosition);
  }
  window.addEventListener('resize', updatePosition);
  updatePosition();
})();

// --- Visibility change: reconnect when phone wakes from screen saver ---
document.addEventListener('visibilitychange', function() {
  if (!document.hidden) {
    // Page became visible — check if WS is still alive
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.log('[Mobile] visibility restored, WS dead — reconnecting');
      reconnectAttempt = 0; // reset backoff — this is a wake, not a failure
      fetchApiKeyAndConnect();
    } else {
      // WS looks alive but may be stale — re-subscribe to get fresh screen
      if (currentSession) {
        sendMessage({ type: 'subscribe', session: currentSession, source: 'claude-proxy' });
      }
    }
  }
});

// --- Init ---
console.log('[mobile] loaded');
fetchApiKeyAndConnect();

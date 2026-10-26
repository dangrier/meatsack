/**
 * meatsack prompt UI.
 *
 * Everything the model sends is untrusted text, so it only ever reaches the
 * page through textContent — never innerHTML.
 */

const state = new Map(); // id -> request
const cards = new Map(); // id -> { el, status }

const $pending = document.getElementById('pending');
const $pendingWrap = document.getElementById('pending-wrap');
const $pendingCount = document.getElementById('pending-count');
const $history = document.getElementById('history');
const $historyWrap = document.getElementById('history-wrap');
const $empty = document.getElementById('empty');
const $conn = document.getElementById('conn');
const $notify = document.getElementById('notify');
const $pair = document.getElementById('pair');
const $pairDialog = document.getElementById('pair-dialog');
const $pairBody = document.getElementById('pair-body');
const $pairClose = document.getElementById('pair-close');

/**
 * On a phone we arrive through a QR link carrying ?k=<token>. Stash it, wipe
 * it out of the address bar, and present it on everything from then on.
 */
const TOKEN_KEY = 'meatsack.token';
const token = (() => {
  const here = new URL(location.href);
  const fresh = here.searchParams.get('k');
  if (!fresh) return localStorage.getItem(TOKEN_KEY);
  localStorage.setItem(TOKEN_KEY, fresh);
  here.searchParams.delete('k');
  history.replaceState(null, '', here.pathname + here.search + here.hash);
  return fresh;
})();

/** True when this page is a paired phone rather than the machine itself. */
const isPhone = Boolean(token);

function authFetch(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(path, { ...options, headers });
}

const LABELS = {
  do: { badge: 'do this', confirm: 'Mark it done', refuse: "Can't do it", notes: 'Notes back to the robot (optional)' },
  answer: { badge: 'answer', confirm: 'Send answer', refuse: "I don't know", notes: 'Type your answer…' },
  physical: { badge: 'physical', confirm: 'I did it', refuse: 'Not doing that', notes: 'What happened? (optional)' },
};

const HAZARD_TEXT = {
  low: 'Low risk. Read it before you touch anything.',
  medium: 'Careful. This could break something or hurt a bit.',
  high: 'Dangerous. Do not do this unless you are sure it is safe.',
};

// ---------------------------------------------------------------- plumbing

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child) node.append(child);
  }
  return node;
}

function connect() {
  // EventSource cannot carry headers, so the token rides in the query string.
  const source = new EventSource(token ? `/api/events?k=${encodeURIComponent(token)}` : '/api/events');

  source.addEventListener('open', () => setConn('live', 'live'));
  source.addEventListener('error', () => setConn('lost', 'reconnecting…'));

  // The desk stopped sharing, or the pairing ran out of time.
  source.addEventListener('unpaired', (event) => {
    source.close();
    const { reason } = JSON.parse(event.data || '{}');
    showUnpaired(reason);
  });

  source.addEventListener('sync', (event) => {
    const data = JSON.parse(event.data);
    state.clear();
    for (const [, card] of cards) card.el.remove();
    cards.clear();
    for (const request of data.requests) upsert(request, false);
    paint();
    focusHash();
  });

  source.addEventListener('created', (event) => {
    upsert(JSON.parse(event.data), true);
    paint();
  });

  source.addEventListener('resolved', (event) => {
    upsert(JSON.parse(event.data), false);
    paint();
  });
}

function setConn(stateName, text) {
  $conn.dataset.state = stateName;
  $conn.textContent = text;
}

function upsert(request, isNew) {
  const previous = cards.get(request.id);
  state.set(request.id, request);

  // Same status: leave the card alone so half-typed answers survive.
  if (previous && previous.status === request.status) return;
  previous?.el.remove();

  const card = request.status === 'pending' ? pendingCard(request) : resolvedCard(request);
  cards.set(request.id, { el: card, status: request.status });

  if (request.status === 'pending') $pending.prepend(card);
  else $history.prepend(card);

  if (isNew && request.status === 'pending') announce(request);
}

function paint() {
  const pending = [...state.values()].filter((r) => r.status === 'pending');
  $pendingCount.textContent = String(pending.length);
  $pendingWrap.hidden = pending.length === 0;
  $historyWrap.hidden = $history.childElementCount === 0;
  $empty.hidden = pending.length > 0;
  document.title = pending.length ? `(${pending.length}) meatsack` : 'meatsack';
}

// ---------------------------------------------------------------- cards

function pendingCard(request) {
  const labels = LABELS[request.action] ?? LABELS.do;
  const draft = { choice: null, proof: null };

  const card = el('article', {
    class: 'card',
    'data-id': request.id,
    'data-urgency': request.urgency,
  });
  card._draft = draft;

  const timer = el('span', { class: 'timer' });
  card._timer = timer;

  card.append(
    el(
      'div',
      { class: 'card-top' },
      el('span', { class: 'badge', 'data-action': request.action, text: labels.badge }),
      request.asker ? el('span', { class: 'asker', text: `asked by ${request.asker}` }) : null,
      el('span', { class: 'spacer' }),
      timer,
    ),
  );

  const body = el('div', { class: 'card-body' });
  body.append(el('h3', { class: 'prompt', text: request.prompt }));
  if (request.detail) body.append(el('p', { class: 'detail', text: request.detail }));

  const chips = [];
  if (request.location) chips.push(chip(`📍 ${request.location}`));
  if (request.hazard && request.hazard !== 'none') chips.push(chip(`⚠️ hazard: ${request.hazard}`));
  if (request.requireProof) chips.push(chip('📷 photo required'));
  if (chips.length) body.append(el('div', { class: 'chips' }, chips));

  if (request.steps?.length) {
    body.append(
      el(
        'ul',
        { class: 'steps' },
        request.steps.map((step) =>
          el(
            'li',
            {},
            el(
              'label',
              {},
              el('input', { type: 'checkbox' }),
              el('span', { text: step }),
            ),
          ),
        ),
      ),
    );
  }

  let ackBox = null;
  if (request.hazard && request.hazard !== 'none') {
    ackBox = el('input', { type: 'checkbox', id: `ack-${request.id}` });
    body.append(
      el(
        'div',
        { class: 'hazard' },
        ackBox,
        el(
          'label',
          { for: `ack-${request.id}` },
          el('strong', { text: HAZARD_TEXT[request.hazard] ?? 'Be careful.' }),
          el('span', { text: 'I have read this and it is safe for me to do.' }),
        ),
      ),
    );
  }

  if (request.action === 'answer' && request.choices?.length) {
    const buttons = request.choices.map((choice) =>
      el('button', {
        type: 'button',
        class: 'choice',
        'aria-pressed': 'false',
        text: choice,
        onclick: (event) => {
          const picked = event.currentTarget.getAttribute('aria-pressed') === 'true';
          for (const b of buttons) b.setAttribute('aria-pressed', 'false');
          event.currentTarget.setAttribute('aria-pressed', picked ? 'false' : 'true');
          draft.choice = picked ? null : choice;
        },
      }),
    );
    body.append(el('div', { class: 'choices' }, buttons));
  }

  const notes = el('textarea', {
    placeholder: request.placeholder || labels.notes,
    rows: request.action === 'answer' && !request.choices?.length ? 3 : 2,
  });
  body.append(notes);

  const error = el('p', { class: 'error', role: 'alert' });

  if (request.requireProof) {
    const file = el('input', { type: 'file', accept: 'image/*', capture: 'environment' });
    const preview = el('img', { class: 'proof-preview', hidden: true, alt: 'your photo' });
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      if (!chosen) {
        draft.proof = null;
        preview.hidden = true;
        return;
      }
      if (chosen.size > 5 * 1024 * 1024) {
        error.textContent = 'That photo is too big. 5MB max.';
        file.value = '';
        return;
      }
      const dataUrl = await readAsDataUrl(chosen);
      draft.proof = {
        mimeType: chosen.type || 'application/octet-stream',
        data: dataUrl.slice(dataUrl.indexOf(',') + 1),
        filename: chosen.name,
      };
      preview.src = dataUrl;
      preview.hidden = !chosen.type.startsWith('image/');
      error.textContent = '';
    });
    body.append(el('div', { class: 'proof' }, file, preview));
  }

  const confirm = el('button', {
    type: 'button',
    class: 'btn btn-primary',
    'data-action': request.action,
    text: labels.confirm,
  });
  const refuse = el('button', { type: 'button', class: 'btn btn-ghost', text: labels.refuse });

  const send = async (outcome) => {
    const payload = { outcome, text: notes.value.trim() || undefined };
    if (outcome !== 'declined') {
      if (draft.choice) payload.choice = draft.choice;
      if (ackBox) payload.acknowledged = ackBox.checked;
      if (draft.proof) payload.proof = draft.proof;
    }
    confirm.disabled = true;
    refuse.disabled = true;
    error.textContent = '';
    try {
      const response = await authFetch(`/api/requests/${request.id}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        if (response.status === 401) {
          showUnpaired('this link stopped working');
          return;
        }
        const problem = await response.json().catch(() => ({}));
        throw new Error(problem.error || `something broke (${response.status})`);
      }
      // The SSE 'resolved' event swaps the card out for us.
    } catch (err) {
      error.textContent = err.message;
      confirm.disabled = false;
      refuse.disabled = false;
    }
  };

  confirm.addEventListener('click', () => send(request.action === 'answer' ? 'answered' : 'done'));
  refuse.addEventListener('click', () => send('declined'));
  notes.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') confirm.click();
  });

  body.append(
    el(
      'div',
      { class: 'actions' },
      confirm,
      refuse,
      el('span', { class: 'hint', text: '⌘↵ to send' }),
    ),
    error,
  );

  card.append(body);
  card._buttons = [confirm, refuse];
  updateTimer(card, request);
  return card;
}

function resolvedCard(request) {
  const r = request.resolution ?? { outcome: 'cancelled' };
  const said = [r.choice, r.text].filter(Boolean).join(' — ');
  const card = el('article', { class: 'card resolved', 'data-id': request.id });
  card.append(
    el(
      'div',
      { class: 'card-top' },
      el('span', { class: 'badge', 'data-action': request.action, text: LABELS[request.action]?.badge ?? request.action }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'outcome', 'data-outcome': r.outcome, text: r.outcome }),
    ),
    el(
      'div',
      { class: 'card-body' },
      el('h3', { class: 'prompt', text: request.prompt }),
      said ? el('p', { class: 'said', text: said }) : null,
      r.proof ? el('p', { class: 'said', text: `📎 ${r.proof.filename || 'attachment'} sent back` }) : null,
    ),
  );
  return card;
}

function chip(text) {
  return el('span', { class: 'chip', text });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('could not read that file'));
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------- timers

function updateTimer(card, request) {
  const timer = card._timer;
  if (!timer) return;
  const msLeft = request.expiresAt - Date.now();
  if (msLeft <= 0) {
    timer.textContent = 'expired';
    timer.className = 'timer urgent';
    for (const button of card._buttons ?? []) button.disabled = true;
    return;
  }
  const seconds = Math.ceil(msLeft / 1000);
  timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left`;
  timer.className = `timer${seconds <= 20 ? ' urgent' : seconds <= 60 ? ' soon' : ''}`;
}

setInterval(() => {
  for (const [id, card] of cards) {
    if (card.status !== 'pending') continue;
    const request = state.get(id);
    if (request) updateTimer(card.el, request);
  }
}, 1000);

// ---------------------------------------------------------------- noise

let audio = null;
function beep() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const now = audio.currentTime;
    for (const [i, freq] of [660, 880].entries()) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, now + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.12, now + i * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.11);
      osc.connect(gain).connect(audio.destination);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.12);
    }
  } catch {
    /* no sound, no problem */
  }
}

function announce(request) {
  beep();
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    const note = new Notification('meatsack needs you', { body: request.prompt, tag: request.id });
    note.onclick = () => {
      window.focus();
      note.close();
    };
  }
}

$notify.addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  const permission = await Notification.requestPermission();
  $notify.setAttribute('aria-pressed', permission === 'granted' ? 'true' : 'false');
  beep(); // Also unlocks audio, since this is a real user gesture.
});
if ('Notification' in window && Notification.permission === 'granted') {
  $notify.setAttribute('aria-pressed', 'true');
}

// ---------------------------------------------------------------- pairing

let pairState = { active: false };

/** The QR comes from our own backend, but keep the no-innerHTML rule anyway. */
function svgNode(svgText) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('could not draw the code');
  return document.importNode(doc.documentElement, true);
}

async function loadPairState() {
  const response = await authFetch('/api/pair');
  if (!response.ok) throw new Error('could not read the sharing state');
  pairState = await response.json();
  return pairState;
}

function renderPair(view) {
  $pairBody.replaceChildren();

  if (view.error) {
    $pairBody.append(
      el('p', { class: 'pair-error', text: view.error }),
      el('button', { class: 'btn btn-ghost', type: 'button', text: 'Try again', onclick: startPairing }),
    );
    return;
  }

  if (view.busy) {
    $pairBody.append(el('p', { class: 'pair-wait', text: 'Opening the door…' }));
    return;
  }

  if (!view.active) {
    $pairBody.append(
      el('p', {
        class: 'pair-lead',
        text: 'Put the prompts on your phone, so you can answer them while away from the desk — handy for jobs that need a photo.',
      }),
      el(
        'ul',
        { class: 'pair-facts' },
        el('li', { text: 'Your phone must be on the same Wi-Fi as this computer.' }),
        el('li', { text: 'Anyone who scans the code can answer your prompts, so keep it to yourself.' }),
        el('li', { text: 'It is plain HTTP on your local network, and it stops by itself after an hour.' }),
      ),
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: 'Show me the code',
        onclick: startPairing,
      }),
    );
    return;
  }

  const countdown = el('span', { class: 'pair-countdown' });
  const copy = el('button', {
    class: 'btn btn-ghost',
    type: 'button',
    text: 'Copy link',
    onclick: async (event) => {
      try {
        await navigator.clipboard.writeText(view.url);
        event.currentTarget.textContent = 'Copied';
        setTimeout(() => (event.currentTarget.textContent = 'Copy link'), 1500);
      } catch {
        event.currentTarget.textContent = 'Copy failed';
      }
    },
  });

  $pairBody.append(
    el('div', { class: 'qr' }, svgNode(view.qr)),
    el('p', { class: 'pair-lead', text: 'Point your phone camera at this.' }),
    el('code', { class: 'pair-url', text: view.url }),
    el('p', { class: 'pair-meta' }, countdown),
    el(
      'div',
      { class: 'actions' },
      copy,
      el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        text: 'Stop sharing',
        onclick: stopPairing,
      }),
    ),
    el('p', {
      class: 'pair-warn',
      text: 'While this is up, anyone on your Wi-Fi who has the link can read and answer your prompts.',
    }),
  );
  tickPair(countdown);
}

async function startPairing() {
  renderPair({ busy: true });
  try {
    const response = await authFetch('/api/pair', { method: 'POST' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'could not start sharing');
    pairState = body;
    renderPair(pairState);
  } catch (err) {
    renderPair({ error: err.message });
  }
}

async function stopPairing() {
  try {
    const response = await authFetch('/api/pair', { method: 'DELETE' });
    pairState = await response.json();
  } catch {
    pairState = { active: false };
  }
  renderPair(pairState);
}

function tickPair(node) {
  const left = Math.max(0, (pairState.expiresAt ?? 0) - Date.now());
  if (left <= 0) {
    node.textContent = 'sharing has stopped';
    return;
  }
  const minutes = Math.floor(left / 60000);
  const seconds = Math.floor((left % 60000) / 1000);
  const devices = pairState.devices ? ` · ${pairState.devices} phone${pairState.devices > 1 ? 's' : ''} connected` : '';
  node.textContent = `stops in ${minutes}:${String(seconds).padStart(2, '0')}${devices}`;
}

$pair.addEventListener('click', async () => {
  $pairDialog.showModal();
  renderPair({ busy: true });
  try {
    renderPair(await loadPairState());
  } catch (err) {
    renderPair({ error: err.message });
  }
});
$pairClose.addEventListener('click', () => $pairDialog.close());
$pairDialog.addEventListener('click', (event) => {
  // Clicking the backdrop (the dialog element itself) closes it.
  if (event.target === $pairDialog) $pairDialog.close();
});

setInterval(() => {
  if (!$pairDialog.open || !pairState.active) return;
  const node = $pairBody.querySelector('.pair-countdown');
  if (node) tickPair(node);
}, 1000);

// A phone cannot share itself onwards, so do not offer.
if (isPhone) $pair.hidden = true;

/** The desk stopped sharing. Say so plainly instead of dying quietly. */
function showUnpaired(reason) {
  document.body.replaceChildren(
    el(
      'div',
      { class: 'gone' },
      el('p', { class: 'empty-emoji', 'aria-hidden': 'true', text: '🔌' }),
      el('p', { class: 'empty-title', text: 'This phone has been unplugged.' }),
      el('p', { class: 'empty-sub', text: reason ? `Reason: ${reason}.` : 'The computer stopped sharing.' }),
      el('p', { class: 'empty-sub', text: 'Scan a fresh code from the computer to get back in.' }),
    ),
  );
  localStorage.removeItem(TOKEN_KEY);
  document.title = 'meatsack';
}

// ---------------------------------------------------------------- deep link

function focusHash() {
  const id = location.hash.slice(1);
  if (!id) return;
  const card = cards.get(id)?.el;
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.remove('flash');
  void card.offsetWidth;
  card.classList.add('flash');
}
window.addEventListener('hashchange', focusHash);

connect();
paint();

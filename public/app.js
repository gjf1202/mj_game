const SESSION_KEY = 'mj-session';
const SUITS = { m: '萬', p: '筒', s: '條' };
const HONOR_NAMES = { w1: '東', w2: '南', w3: '西', w4: '北', d1: '中', d2: '發', d3: '白' };
const WINDS = ['East', 'South', 'West', 'North'];
const ui = Object.fromEntries([
  'lobby', 'game', 'nickname', 'room-code', 'create-tab', 'join-tab', 'create-panel', 'join-panel',
  'create-button', 'join-button', 'room-number', 'copy-room', 'leave-button', 'wall-label',
  'seat-row', 'phase-label', 'turn-label', 'discard-grid', 'table-message', 'self-seat', 'hand-count',
  'melds', 'hand', 'actions', 'table-log', 'connection-dot', 'connection-label', 'toast', 'leave-dialog',
  'cancel-leave', 'confirm-leave'
].map((id) => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), document.getElementById(id)]));

let sessionToken = localStorage.getItem(SESSION_KEY);
let currentState = null;
let eventSource = null;
let toastTimer = 0;

function tileParts(tile) {
  if (HONOR_NAMES[tile]) {
    return { main: HONOR_NAMES[tile], sub: '', red: tile === 'd1' };
  }
  return { main: tile.slice(1), sub: SUITS[tile[0]], red: false };
}

function makeTileElement(tile, className = 'discard-tile') {
  const tileElement = document.createElement('span');
  const parts = tileParts(tile);
  tileElement.className = `${className}${parts.red ? ' red' : ''}`;
  tileElement.setAttribute('aria-label', `${parts.main}${parts.sub}`);
  tileElement.textContent = `${parts.main}${parts.sub}`;
  return tileElement;
}

async function api(path, body = {}) {
  const response = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}) },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || 'Request failed.');
  }
  if (result.token) {
    sessionToken = result.token;
    localStorage.setItem(SESSION_KEY, sessionToken);
    connectEvents();
  }
  if (result.state) {
    setState(result.state);
  }
  return result;
}

function setState(state) {
  currentState = state;
  ui.lobby.hidden = true;
  ui.game.hidden = false;
  render();
}

function connectEvents() {
  eventSource?.close();
  eventSource = new EventSource(`/events?token=${encodeURIComponent(sessionToken)}`);
  eventSource.onopen = () => {
    ui.connectionDot.parentElement.classList.remove('offline');
    ui.connectionLabel.textContent = 'ONLINE';
  };
  eventSource.onmessage = (event) => {
    setState(JSON.parse(event.data));
  };
  eventSource.onerror = () => {
    ui.connectionDot.parentElement.classList.add('offline');
    ui.connectionLabel.textContent = 'RECONNECT';
  };
}

function showToast(message) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 2500);
}

async function runAction(path, body = {}) {
  try {
    await api(path, body);
  } catch (error) {
    showToast(error.message);
  }
}

function render() {
  const state = currentState;
  ui.roomNumber.textContent = state.code;
  ui.wallLabel.textContent = `WALL ${state.wallCount}`;
  ui.phaseLabel.textContent = ({ waiting: 'Waiting', playing: 'In progress', claim: 'Claim tile', finished: 'Hand over' })[state.phase];
  ui.selfSeat.textContent = `${WINDS[(state.you - state.dealer + 4) % 4]} · SEAT ${state.you + 1}`;
  renderSeats(state);
  renderDiscards(state);
  renderHand(state);
  renderMelds(state);
  renderActions(state);
  renderLog(state);
}

function renderSeats(state) {
  ui.seatRow.replaceChildren();
  state.players.forEach((player, seat) => {
    const seatElement = document.createElement('div');
    const wind = WINDS[(seat - state.dealer + 4) % 4];
    seatElement.className = `seat${state.phase !== 'waiting' && seat === state.turn ? ' active' : ''}${player && !player.online ? ' offline' : ''}`;
    const number = document.createElement('span');
    number.className = 'seat-number';
    number.textContent = String(seat + 1);
    const name = document.createElement('span');
    name.className = 'seat-name';
    name.textContent = player ? player.name : 'Open seat';
    const meta = document.createElement('span');
    meta.className = 'seat-meta';
    const windLabel = document.createElement('span');
    windLabel.className = seat === state.dealer ? 'dealer' : '';
    windLabel.textContent = seat === state.dealer ? `${wind} · DEALER` : wind;
    meta.append(windLabel);
    if (player && state.phase !== 'waiting') {
      const count = document.createElement('span');
      count.className = 'tile-count';
      count.textContent = `${player.handCount} tiles`;
      meta.append(count);
    } else if (player) {
      const ready = document.createElement('span');
      ready.textContent = player.ready ? 'READY' : player.online ? 'HERE' : 'OFFLINE';
      meta.append(ready);
    }
    seatElement.append(number, name, meta);
    if (player?.melds.length) {
      const exposed = document.createElement('span');
      exposed.className = 'seat-melds';
      for (const meld of player.melds) {
        for (const tile of meld.tiles) {
          exposed.append(makeTileElement(tile, 'meld-tile'));
        }
      }
      seatElement.append(exposed);
    }
    ui.seatRow.append(seatElement);
  });
}

function renderDiscards(state) {
  ui.discardGrid.replaceChildren();
  for (const player of state.players) {
    if (!player) {
      continue;
    }
    for (const discard of player.discards) {
      const tile = makeTileElement(discard.tile);
      if (discard.claimed) {
        tile.classList.add('claimed');
      }
      ui.discardGrid.append(tile);
    }
  }
  if (state.phase === 'claim' && state.lastDiscard) {
    ui.tableMessage.textContent = `${state.players[state.lastDiscard.seat].name} discarded ${tileParts(state.lastDiscard.tile).main}${tileParts(state.lastDiscard.tile).sub}.`;
  } else if (state.phase === 'finished') {
    ui.tableMessage.textContent = state.winner === null ? 'Draw game.' : `${state.players[state.winner].name} wins.`;
  } else if (state.phase === 'waiting') {
    ui.tableMessage.textContent = `Ready up · ${state.players.filter(Boolean).length}/4 seats`;
  } else {
    ui.tableMessage.textContent = state.turn === state.you ? 'Your turn · draw complete' : `${state.players[state.turn]?.name || 'Player'} to move.`;
  }
  ui.turnLabel.textContent = state.phase === 'playing' ? `${state.players[state.turn]?.name || 'Player'} · ${WINDS[(state.turn - state.dealer + 4) % 4]}` : '';
}

function renderHand(state) {
  ui.hand.replaceChildren();
  ui.handCount.textContent = String(state.hand.length);
  const canDiscard = state.phase === 'playing' && state.turn === state.you;
  state.hand.forEach((tile, index) => {
    const button = document.createElement('button');
    const parts = tileParts(tile);
    button.type = 'button';
    button.className = `hand-tile${parts.red ? ' red' : ''}${index > 0 && state.hand[index - 1][0] !== tile[0] ? ' gap' : ''}`;
    button.setAttribute('aria-label', `Discard ${parts.main}${parts.sub}`);
    button.disabled = !canDiscard;
    const main = document.createElement('span');
    main.textContent = parts.main;
    button.append(main);
    if (parts.sub) {
      const suit = document.createElement('small');
      suit.textContent = parts.sub;
      button.append(suit);
    }
    button.addEventListener('click', () => runAction('discard', { tile }));
    ui.hand.append(button);
  });
}

function renderMelds(state) {
  ui.melds.replaceChildren();
  for (const meld of state.players[state.you]?.melds || []) {
    const meldElement = document.createElement('div');
    meldElement.className = 'meld';
    for (const tile of meld.tiles) {
      meldElement.append(makeTileElement(tile, 'meld-tile'));
    }
    const label = document.createElement('span');
    label.className = 'meld-label';
    label.textContent = meld.type;
    meldElement.append(label);
    ui.melds.append(meldElement);
  }
}

function addAction(label, action, options = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `button${options.primary ? ' primary' : ' secondary'}`;
  button.textContent = label;
  button.addEventListener('click', action);
  ui.actions.append(button);
}

function renderActions(state) {
  ui.actions.replaceChildren();
  if (state.phase === 'waiting') {
    const player = state.players[state.you];
    addAction(player.ready ? 'Not ready' : 'Ready', () => runAction('ready', { ready: !player.ready }), { primary: !player.ready });
    const allReady = state.players.length === 4 && state.players.every((entry) => entry?.ready && entry.online);
    if (state.host === state.you) {
      addAction('Start', () => runAction('start'), { primary: true });
      ui.actions.lastElementChild.disabled = !allReady;
    }
    return;
  }
  if (state.phase === 'finished') {
    const player = state.players[state.you];
    addAction(player.ready ? 'Ready' : 'Next hand', () => runAction('ready', { ready: !player.ready }), { primary: !player.ready });
    return;
  }
  if (state.phase === 'claim') {
    if (state.claimOptions.length === 0) {
      const pending = state.claimResponses.some((responded, seat) => seat !== state.you && !responded);
      ui.tableMessage.textContent += pending ? ' · Waiting for claims' : '';
      return;
    }
    if (state.claimOptions.includes('hu')) {
      addAction('Hu', () => runAction('claim', { type: 'hu' }), { primary: true });
    }
    if (state.claimOptions.includes('kong')) {
      addAction('Kong', () => runAction('claim', { type: 'kong' }), { primary: true });
    }
    if (state.claimOptions.includes('pung')) {
      addAction('Pung', () => runAction('claim', { type: 'pung' }));
    }
    for (const option of state.claimOptions.filter((entry) => entry.startsWith('chi:'))) {
      const tiles = option.slice(4).split(',');
      addAction(`Chi · ${tiles.map((tile) => tileParts(tile).main + tileParts(tile).sub).join(' ')}`, () => runAction('claim', { type: 'chi', tiles }));
    }
    addAction('Pass', () => runAction('claim', { type: 'pass' }));
    return;
  }
  if (state.phase === 'playing' && state.turn === state.you) {
    if (state.selfOptions.hu) {
      addAction('Hu', () => runAction('hu'), { primary: true });
    }
    for (const tile of state.selfOptions.kong) {
      const label = tile.startsWith('upgrade:') ? 'Upgrade Kong' : `Kong · ${tileParts(tile).main}${tileParts(tile).sub}`;
      addAction(label, () => runAction('kong', { tile }));
    }
    if (!state.selfOptions.hu && state.selfOptions.kong.length === 0) {
      ui.actions.textContent = 'Select a tile to discard.';
      ui.actions.classList.add('action-note');
    }
  }
}

function renderLog(state) {
  ui.tableLog.replaceChildren();
  for (const entry of state.log.slice(-5)) {
    const log = document.createElement('span');
    log.className = 'log-entry';
    log.textContent = entry.message;
    ui.tableLog.append(log);
  }
}

function selectEntry(mode) {
  const createMode = mode === 'create';
  ui.createTab.classList.toggle('active', createMode);
  ui.createTab.setAttribute('aria-selected', String(createMode));
  ui.joinTab.classList.toggle('active', !createMode);
  ui.joinTab.setAttribute('aria-selected', String(!createMode));
  ui.createPanel.hidden = !createMode;
  ui.joinPanel.hidden = createMode;
}

ui.createTab.addEventListener('click', () => selectEntry('create'));
ui.joinTab.addEventListener('click', () => selectEntry('join'));
ui.createButton.addEventListener('click', () => api('create', { name: ui.nickname.value }).catch((error) => showToast(error.message)));
ui.joinButton.addEventListener('click', () => api('join', { name: ui.nickname.value, code: ui.roomCode.value.trim() }).catch((error) => showToast(error.message)));
ui.roomCode.addEventListener('input', () => { ui.roomCode.value = ui.roomCode.value.replace(/\D/g, '').slice(0, 6); });
ui.copyRoom.addEventListener('click', async () => {
  const address = (await fetch('/api/info').then((response) => response.json())).addresses[0] || location.origin;
  try {
    await navigator.clipboard.writeText(`${address} · ${currentState.code}`);
    showToast('Invite copied.');
  } catch {
    showToast(`${address} · ${currentState.code}`);
  }
});
ui.leaveButton.addEventListener('click', () => ui.leaveDialog.showModal());
ui.cancelLeave.addEventListener('click', () => ui.leaveDialog.close());
ui.confirmLeave.addEventListener('click', async () => {
  await runAction('leave');
  eventSource?.close();
  localStorage.removeItem(SESSION_KEY);
  location.reload();
});

if (sessionToken) {
  api('resume').then(connectEvents).catch(() => {
    localStorage.removeItem(SESSION_KEY);
    sessionToken = null;
  });
}

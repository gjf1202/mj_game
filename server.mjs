import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { randomBytes, randomInt } from 'node:crypto';
import {
  PLAYER_COUNT, canWin, createWall, getClaimOptions, getSelfOptions,
  nextSeat, removeTiles, sortHand, validateTile
} from './game.mjs';

const PORT = Number(process.env.PORT || 3000);
const SEAT_RESERVE_MS = 2 * 60 * 1000;
const ROOM_TTL_MS = 30 * 60 * 1000;
const MAX_ROOMS = 200;
const rooms = new Map();
const sessions = new Map();
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']]
]);
const publicRoot = new URL('./public/', import.meta.url);

function createToken() {
  return randomBytes(24).toString('hex');
}

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function createPlayer(name, seat) {
  return { token: createToken(), name, seat, online: true, offlineAt: 0, ready: false, hand: [], melds: [], discards: [] };
}

function addLog(room, message) {
  room.log = [...room.log.slice(-39), { id: createToken().slice(0, 8), message }];
}

function bindSession(room, player) {
  sessions.set(player.token, { room, player, stream: null, requests: [] });
}

function makeRoom(name) {
  if (rooms.size >= MAX_ROOMS) {
    fail('Server full. Try later.', 503);
  }
  let code;
  do {
    code = String(randomInt(100000, 1000000));
  } while (rooms.has(code));
  const room = {
    code, host: 0, players: Array(PLAYER_COUNT).fill(null), phase: 'waiting',
    dealer: 0, turn: 0, wall: [], lastDiscard: null,
    claimResponses: Array(PLAYER_COUNT).fill(false), claimChoices: [], winner: null,
    log: [], updatedAt: Date.now()
  };
  const player = createPlayer(name, 0);
  room.players[0] = player;
  rooms.set(code, room);
  bindSession(room, player);
  addLog(room, `${name} opened a table.`);
  return { room, player };
}

function requireSession(token) {
  const session = typeof token === 'string' ? sessions.get(token) : null;
  if (!session) {
    fail('Session expired. Rejoin.', 401);
  }
  return session;
}

function validName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || [...name].length > 16 || /[\x00-\x1f\x7f]/.test(name)) {
    fail('Name: 1–16 characters.');
  }
  return name;
}

function roomView(room, player) {
  return {
    code: room.code,
    you: player.seat,
    host: room.host,
    players: room.players.map((entry) => entry ? {
      seat: entry.seat, name: entry.name, online: entry.online, ready: entry.ready,
      handCount: entry.hand.length, discards: entry.discards, melds: entry.melds
    } : null),
    phase: room.phase,
    dealer: room.dealer,
    turn: room.turn,
    hand: sortHand(player.hand),
    wallCount: room.wall.length,
    lastDiscard: room.lastDiscard,
    claimResponses: room.claimResponses.map((responded) => responded),
    claimOptions: getClaimOptions(room, player.seat),
    selfOptions: getSelfOptions(room, player.seat),
    winner: room.winner,
    log: room.log
  };
}

function push(room) {
  room.updatedAt = Date.now();
  for (const player of room.players.filter(Boolean)) {
    const session = sessions.get(player.token);
    if (session?.stream && !session.stream.destroyed) {
      session.stream.write(`data: ${JSON.stringify(roomView(room, player))}\n\n`);
    }
  }
}

function startGame(room) {
  room.wall = createWall();
  room.phase = 'playing';
  room.turn = room.dealer;
  room.lastDiscard = null;
  room.claimResponses = Array(PLAYER_COUNT).fill(false);
  room.claimChoices = [];
  room.winner = null;
  for (const player of room.players) {
    player.hand = [];
    player.melds = [];
    player.discards = [];
    player.ready = false;
  }
  for (let count = 0; count < 13; count++) {
    for (let offset = 0; offset < PLAYER_COUNT; offset++) {
      room.players[(room.dealer + offset) % PLAYER_COUNT].hand.push(room.wall.pop());
    }
  }
  room.players[room.dealer].hand.push(room.wall.pop());
  addLog(room, `${room.players[room.dealer].name} deals. East starts.`);
}

function draw(room, seat) {
  if (room.wall.length === 0) {
    room.phase = 'finished';
    room.winner = null;
    addLog(room, 'Wall empty. Draw game.');
    return false;
  }
  room.players[seat].hand.push(room.wall.pop());
  room.turn = seat;
  room.phase = 'playing';
  return true;
}

function discard(room, player, tile) {
  if (room.phase !== 'playing' || room.turn !== player.seat) {
    fail('Wait your turn.');
  }
  if (!validateTile(tile) || !player.hand.includes(tile)) {
    fail('Invalid tile.');
  }
  player.hand.splice(player.hand.indexOf(tile), 1);
  player.discards.push({ tile, claimed: false });
  room.lastDiscard = { tile, seat: player.seat };
  room.phase = 'claim';
  room.claimResponses = Array(PLAYER_COUNT).fill(false);
  room.claimResponses[player.seat] = true;
  room.claimChoices = [];
  for (const other of room.players) {
    if (other.seat !== player.seat && getClaimOptions(room, other.seat).length === 0) {
      room.claimResponses[other.seat] = true;
    }
  }
  addLog(room, `${player.name} discards a tile.`);
  settleClaims(room);
}

function chooseClaim(room, player, type, tiles = []) {
  if (room.phase !== 'claim') {
    fail('No tile to claim.');
  }
  const options = getClaimOptions(room, player.seat);
  let choice = { seat: player.seat, type, tiles: [] };
  if (type === 'chi') {
    if (!Array.isArray(tiles) || tiles.length !== 2) {
      fail('Choose a sequence.');
    }
    const key = `chi:${tiles.join(',')}`;
    if (!options.includes(key)) {
      fail('That sequence is not available.');
    }
    choice.tiles = tiles;
  } else if (type !== 'pass' && !options.includes(type)) {
    fail('That claim is not available.');
  }
  room.claimResponses[player.seat] = true;
  if (type !== 'pass') {
    room.claimChoices = room.claimChoices.filter((entry) => entry.seat !== player.seat);
    room.claimChoices.push(choice);
  }
  settleClaims(room);
}

function settleClaims(room) {
  if (room.phase !== 'claim' || room.claimResponses.some((responded) => !responded)) {
    return;
  }
  if (room.claimChoices.length === 0) {
    draw(room, nextSeat(room.lastDiscard.seat));
    room.lastDiscard = null;
    return;
  }
  const priority = { hu: 0, kong: 1, pung: 2, chi: 3 };
  room.claimChoices.sort((left, right) => {
    const priorityDiff = priority[left.type] - priority[right.type];
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    return (left.seat - room.lastDiscard.seat + PLAYER_COUNT) % PLAYER_COUNT
      - (right.seat - room.lastDiscard.seat + PLAYER_COUNT) % PLAYER_COUNT;
  });
  const claim = room.claimChoices[0];
  const claimer = room.players[claim.seat];
  const discardedTile = room.lastDiscard.tile;
  const discarder = room.players[room.lastDiscard.seat];
  if (claim.type === 'hu') {
    room.phase = 'finished';
    room.winner = claim.seat;
    addLog(room, `${claimer.name} wins on discard.`);
    return;
  }
  const removed = removeTiles(claimer.hand, claim.type === 'chi' ? claim.tiles : Array(claim.type === 'kong' ? 3 : 2).fill(discardedTile));
  if (!removed) {
    fail('Claim tiles changed.');
  }
  claimer.hand = removed;
  const claimedTiles = claim.type === 'chi'
    ? [...claim.tiles, discardedTile]
    : [...Array(claim.type === 'kong' ? 3 : 2).fill(discardedTile), discardedTile];
  claimer.melds.push({ type: claim.type === 'chi' ? 'chi' : claim.type, tiles: claimedTiles, open: true });
  discarder.discards.at(-1).claimed = true;
  room.phase = 'playing';
  room.turn = claim.seat;
  room.lastDiscard = null;
  room.claimResponses = Array(PLAYER_COUNT).fill(false);
  room.claimChoices = [];
  addLog(room, `${claimer.name} claims ${claim.type}.`);
  if (claim.type === 'kong') {
    draw(room, claim.seat);
  }
}

function concealedKong(room, player, tile) {
  if (room.phase !== 'playing' || room.turn !== player.seat || !getSelfOptions(room, player.seat).kong.includes(tile)) {
    fail('Kong is not available.');
  }
  if (tile.startsWith('upgrade:')) {
    const upgradedTile = tile.slice('upgrade:'.length);
    const remaining = removeTiles(player.hand, [upgradedTile]);
    const meld = player.melds.find((entry) => entry.type === 'pung' && entry.tiles[0] === upgradedTile);
    if (!remaining || !meld) {
      fail('Kong is not available.');
    }
    player.hand = remaining;
    meld.type = 'kong';
    meld.tiles.push(upgradedTile);
  } else {
    player.hand = removeTiles(player.hand, Array(4).fill(tile));
    player.melds.push({ type: 'kong', tiles: Array(4).fill(tile), open: false });
  }
  addLog(room, `${player.name} declares kong.`);
  draw(room, player.seat);
}

function removePlayer(room, player) {
  const session = sessions.get(player.token);
  sessions.delete(player.token);
  session?.stream?.end();
  room.players[player.seat] = null;
  const remaining = room.players.filter(Boolean);
  if (remaining.length === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.host === player.seat) {
    room.host = remaining[0].seat;
  }
  room.phase = 'waiting';
  room.wall = [];
  room.lastDiscard = null;
  room.claimChoices = [];
  room.claimResponses = Array(PLAYER_COUNT).fill(false);
  room.winner = null;
  for (const other of remaining) {
    other.ready = false;
    other.hand = [];
    other.melds = [];
    other.discards = [];
  }
  addLog(room, 'A player left. Table reset.');
  push(room);
}

async function readBody(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk.toString();
    if (text.length > 8192) {
      fail('Request too large.', 413);
    }
  }
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      fail('Invalid request.');
    }
    return body;
  } catch (error) {
    if (error.status) {
      throw error;
    }
    fail('Invalid request.');
  }
}

function sendJson(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function rateLimit(session) {
  session.requests = session.requests.filter((time) => time > Date.now() - 10000);
  if (session.requests.length >= 60) {
    fail('Slow down.', 429);
  }
  session.requests.push(Date.now());
}

async function handleApi(request, response, path) {
  const body = await readBody(request);
  if (path === '/api/create') {
    const { room, player } = makeRoom(validName(body.name));
    sendJson(response, { token: player.token, state: roomView(room, player) });
    return;
  }
  if (path === '/api/join') {
    const room = rooms.get(String(body.code));
    if (!room) {
      fail('Room not found.', 404);
    }
    if (room.phase !== 'waiting') {
      fail('Game already started.');
    }
    const seat = room.players.findIndex((player) => !player);
    if (seat < 0) {
      fail('Table full.');
    }
    const name = validName(body.name);
    if (room.players.some((player) => player?.name.toLowerCase() === name.toLowerCase())) {
      fail('Name taken.');
    }
    const player = createPlayer(name, seat);
    room.players[seat] = player;
    bindSession(room, player);
    addLog(room, `${name} joined the table.`);
    push(room);
    sendJson(response, { token: player.token, state: roomView(room, player) });
    return;
  }
  const token = request.headers.authorization?.replace(/^Bearer /, '');
  const session = requireSession(token);
  const { room, player } = session;
  rateLimit(session);
  if (path === '/api/resume') {
    sendJson(response, { state: roomView(room, player) });
    return;
  }
  if (path === '/api/leave') {
    removePlayer(room, player);
    sendJson(response, { ok: true });
    return;
  }
  if (path === '/api/ready') {
    if (!['waiting', 'finished'].includes(room.phase) || typeof body.ready !== 'boolean') {
      fail('Cannot change ready state.');
    }
    player.ready = body.ready;
    if (room.phase === 'finished' && room.players.every((entry) => entry.ready)) {
      room.dealer = nextSeat(room.dealer);
      startGame(room);
    }
    push(room);
  } else if (path === '/api/start') {
    if (room.host !== player.seat || room.phase !== 'waiting') {
      fail('Host only.');
    }
    if (!room.players.every((entry) => entry?.online && entry.ready)) {
      fail('All four players must be ready.');
    }
    startGame(room);
    push(room);
  } else if (path === '/api/discard') {
    discard(room, player, body.tile);
    push(room);
  } else if (path === '/api/claim') {
    chooseClaim(room, player, body.type, body.tiles || []);
    push(room);
  } else if (path === '/api/kong') {
    concealedKong(room, player, body.tile);
    push(room);
  } else if (path === '/api/hu') {
    if (room.phase !== 'playing' || room.turn !== player.seat || !canWin(player.hand, player.melds.length)) {
      fail('Hu is not available.');
    }
    room.phase = 'finished';
    room.winner = player.seat;
    addLog(room, `${player.name} wins on self draw.`);
    push(room);
  } else {
    fail('Unknown action.', 404);
  }
  sendJson(response, { state: roomView(room, player) });
}

const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) {
        fail('Invalid origin.', 403);
      }
      await handleApi(request, response, url.pathname);
      return;
    }
    if (request.method !== 'GET') {
      fail('Method not allowed.', 405);
    }
    if (url.pathname === '/api/info') {
      const addresses = [...new Set(Object.values(networkInterfaces()).flat().filter((entry) => entry.family === 'IPv4' && !entry.internal).map((entry) => `http://${entry.address}:${PORT}`))];
      sendJson(response, { addresses, port: PORT });
      return;
    }
    if (url.pathname === '/events') {
      const session = requireSession(url.searchParams.get('token'));
      session.stream?.end();
      session.stream = response;
      session.player.online = true;
      session.player.offlineAt = 0;
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
      response.write('retry: 2000\n\n');
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
      request.on('close', () => {
        clearInterval(heartbeat);
        if (session.stream !== response) {
          return;
        }
        session.stream = null;
        session.player.online = false;
        session.player.offlineAt = Date.now();
        if (rooms.has(session.room.code)) {
          push(session.room);
        }
      });
      push(session.room);
      return;
    }
    const file = staticFiles.get(url.pathname);
    if (!file) {
      fail('Not found.', 404);
    }
    const content = await readFile(new URL(file[0], publicRoot));
    response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
    response.end(content);
  } catch (error) {
    if (!error.status) {
      console.error('Request failed:', error);
    }
    if (!response.headersSent) {
      sendJson(response, { error: error.status ? error.message : 'Server error. Retry.' }, error.status || 500);
    } else {
      response.end();
    }
  }
});

const maintenance = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const expired = room.players.filter((player) => player && !player.online && player.offlineAt && now - player.offlineAt > SEAT_RESERVE_MS);
    for (const player of expired) {
      if (rooms.has(room.code)) {
        removePlayer(room, player);
      }
    }
    if (rooms.has(room.code) && now - room.updatedAt > ROOM_TTL_MS && !room.players.some((player) => player?.online)) {
      rooms.delete(room.code);
    }
  }
}, 1000);

server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${PORT} busy. Choose another PORT.` : error.message);
  clearInterval(maintenance);
  process.exitCode = 1;
});
server.listen(PORT, '0.0.0.0', () => {
  const lanAddresses = [...new Set(Object.values(networkInterfaces()).flat().filter((entry) => entry.family === 'IPv4' && !entry.internal).map((entry) => `http://${entry.address}:${PORT}`))];
  console.log(`\n  MJ · FOUR SEATS\n  Local: http://localhost:${PORT}\n${lanAddresses.map((address) => `  LAN: ${address}`).join('\n')}\n\n  Share the LAN address and six-digit room code.\n  Keep this window open. Ctrl+C to stop.\n`);
});

function shutdown() {
  clearInterval(maintenance);
  for (const session of sessions.values()) {
    session.stream?.end();
  }
  server.close();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

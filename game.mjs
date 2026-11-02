export const PLAYER_COUNT = 4;
export const SUITED_PREFIXES = ['m', 'p', 's'];
export const HONORS = ['w1', 'w2', 'w3', 'w4', 'd1', 'd2', 'd3'];
export const TILE_TYPES = [
  ...SUITED_PREFIXES.flatMap((prefix) => Array.from({ length: 9 }, (_, index) => `${prefix}${index + 1}`)),
  ...HONORS
];
const TILE_SET = new Set(TILE_TYPES);

export function nextSeat(seat) {
  return (seat + 1) % PLAYER_COUNT;
}

export function createWall(random = Math.random) {
  const wall = TILE_TYPES.flatMap((tile) => Array(4).fill(tile));
  for (let index = wall.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [wall[index], wall[swapIndex]] = [wall[swapIndex], wall[index]];
  }
  return wall;
}

export function tileName(tile) {
  const suits = { m: '萬', p: '筒', s: '條' };
  const honors = { w1: '東', w2: '南', w3: '西', w4: '北', d1: '中', d2: '發', d3: '白' };
  if (honors[tile]) {
    return honors[tile];
  }
  return `${tile.slice(1)}${suits[tile[0]] || ''}`;
}

export function canWin(hand, meldCount, winningTile = null) {
  const tiles = winningTile ? [...hand, winningTile] : [...hand];
  if (tiles.some((tile) => !TILE_SET.has(tile)) || tiles.length !== 14 - meldCount * 3) {
    return false;
  }
  const counts = new Map(TILE_TYPES.map((tile) => [tile, 0]));
  for (const tile of tiles) {
    counts.set(tile, counts.get(tile) + 1);
  }
  for (const tile of TILE_TYPES) {
    if (counts.get(tile) < 2) {
      continue;
    }
    counts.set(tile, counts.get(tile) - 2);
    if (canMakeMelds(counts)) {
      counts.set(tile, counts.get(tile) + 2);
      return true;
    }
    counts.set(tile, counts.get(tile) + 2);
  }
  return false;
}

function canMakeMelds(counts) {
  const tile = TILE_TYPES.find((candidate) => counts.get(candidate) > 0);
  if (!tile) {
    return true;
  }
  if (counts.get(tile) >= 3) {
    counts.set(tile, counts.get(tile) - 3);
    if (canMakeMelds(counts)) {
      counts.set(tile, counts.get(tile) + 3);
      return true;
    }
    counts.set(tile, counts.get(tile) + 3);
  }
  if (isSuited(tile)) {
    const number = Number(tile.slice(1));
    const nextTile = `${tile[0]}${number + 1}`;
    const lastTile = `${tile[0]}${number + 2}`;
    if (number <= 7 && counts.get(nextTile) > 0 && counts.get(lastTile) > 0) {
      counts.set(tile, counts.get(tile) - 1);
      counts.set(nextTile, counts.get(nextTile) - 1);
      counts.set(lastTile, counts.get(lastTile) - 1);
      if (canMakeMelds(counts)) {
        counts.set(tile, counts.get(tile) + 1);
        counts.set(nextTile, counts.get(nextTile) + 1);
        counts.set(lastTile, counts.get(lastTile) + 1);
        return true;
      }
      counts.set(tile, counts.get(tile) + 1);
      counts.set(nextTile, counts.get(nextTile) + 1);
      counts.set(lastTile, counts.get(lastTile) + 1);
    }
  }
  return false;
}

function isSuited(tile) {
  return SUITED_PREFIXES.includes(tile[0]);
}

export function getClaimOptions(room, seat) {
  if (room.phase !== 'claim' || seat === room.lastDiscard.seat || room.claimResponses[seat]) {
    return [];
  }
  const hand = room.players[seat].hand;
  const tile = room.lastDiscard.tile;
  const count = hand.filter((entry) => entry === tile).length;
  const options = [];
  if (canWin(hand, room.players[seat].melds.length, tile)) {
    options.push('hu');
  }
  if (count >= 3) {
    options.push('kong');
  }
  if (count >= 2) {
    options.push('pung');
  }
  if (seat === nextSeat(room.lastDiscard.seat)) {
    options.push(...getChowOptions(hand, tile).map((tiles) => `chi:${tiles.join(',')}`));
  }
  return options;
}

function getChowOptions(hand, tile) {
  if (!isSuited(tile)) {
    return [];
  }
  const number = Number(tile.slice(1));
  const candidates = [];
  for (const start of [number - 2, number - 1, number]) {
    if (start < 1 || start > 7) {
      continue;
    }
    const sequence = [0, 1, 2].map((offset) => `${tile[0]}${start + offset}`).filter((entry) => entry !== tile);
    if (sequence.every((entry) => hand.includes(entry))) {
      candidates.push(sequence);
    }
  }
  return candidates;
}

export function getSelfOptions(room, seat) {
  if (room.phase !== 'playing' || room.turn !== seat) {
    return { hu: false, kong: [] };
  }
  const player = room.players[seat];
  const counts = new Map(TILE_TYPES.map((tile) => [tile, player.hand.filter((entry) => entry === tile).length]));
  const kong = [...counts].filter(([, count]) => count === 4).map(([tile]) => tile);
  for (const meld of player.melds) {
    if (meld.type === 'pung' && counts.get(meld.tiles[0]) > 0) {
      kong.push(`upgrade:${meld.tiles[0]}`);
    }
  }
  return { hu: canWin(player.hand, player.melds.length), kong };
}

export function sortHand(hand) {
  return [...hand].sort((left, right) => TILE_TYPES.indexOf(left) - TILE_TYPES.indexOf(right));
}

export function validateTile(tile) {
  return TILE_SET.has(tile);
}

export function removeTiles(hand, tiles) {
  const remaining = [...hand];
  for (const tile of tiles) {
    const index = remaining.indexOf(tile);
    if (index < 0) {
      return null;
    }
    remaining.splice(index, 1);
  }
  return remaining;
}

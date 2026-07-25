export const ARCHIVE_KEY = "laser-war.matches.v1";
export const ARCHIVE_VERSION = 1;
export const SAVE_VERSION = 2;

export function createMatchId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `match-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function legacyMatchId(data) {
  const source = JSON.stringify({
    mode: data.mode,
    difficulty: data.difficulty,
    moves: data.moves || [],
  });
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `legacy-${(hash >>> 0).toString(16)}`;
}

export function loadMatchArchive(storage) {
  try {
    const archive = JSON.parse(storage.getItem(ARCHIVE_KEY));
    if (archive?.version === ARCHIVE_VERSION && Array.isArray(archive.matches)) return archive;
  } catch {
    // A malformed archive should not prevent the current match from being saved.
  }
  return { version: ARCHIVE_VERSION, matches: [] };
}

export function upsertMatchRecord(storage, record) {
  const archive = loadMatchArchive(storage);
  const index = archive.matches.findIndex((match) => match.id === record.id);
  if (index === -1) archive.matches.push(record);
  else archive.matches[index] = record;
  archive.matches.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  storage.setItem(ARCHIVE_KEY, JSON.stringify(archive));
  return archive;
}

export function buildActiveSave(session) {
  return {
    version: SAVE_VERSION,
    matchId: session.id,
    startedAt: session.startedAt,
    mode: session.mode,
    difficulty: session.difficulty,
    events: session.events,
    moves: session.history.map((record) => ({
      actor: record.actor,
      row: record.move.row,
      col: record.move.col,
      mirror: record.move.mirror,
    })),
  };
}

export function buildMatchRecord(session, requestedStatus = "active", timestamp = new Date().toISOString()) {
  const completed = Boolean(session.state.winner || session.state.draw);
  const status = completed ? "completed" : requestedStatus;
  return {
    version: ARCHIVE_VERSION,
    id: session.id,
    startedAt: session.startedAt,
    updatedAt: timestamp,
    endedAt: status === "active" ? null : timestamp,
    status,
    mode: session.mode,
    difficulty: session.difficulty,
    winner: session.state.winner,
    draw: session.state.draw,
    turn: session.state.turn,
    finalBoard: session.state.board.map((row) => row.join("")),
    moveCount: session.history.length,
    moves: session.history.map((record) => ({
      number: record.number,
      actor: record.actor,
      row: record.move.row,
      col: record.move.col,
      mirror: record.move.mirror,
      destroyed: record.outcome.destroyed.map(([row, col]) => [row, col]),
      hitKings: [...record.outcome.hitKings].sort(),
    })),
    events: session.events,
  };
}

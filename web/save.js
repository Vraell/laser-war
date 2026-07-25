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

export function buildActiveSave(session) {
  return {
    version: SAVE_VERSION,
    matchId: session.id,
    startedAt: session.startedAt,
    mode: session.mode,
    difficulty: session.difficulty,
    moves: session.history.map((record) => ({
      actor: record.actor,
      row: record.move.row,
      col: record.move.col,
      mirror: record.move.mirror,
    })),
  };
}

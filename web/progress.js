export const PROGRESS_KEY = "laser-war.progress.v1";
export const PROGRESS_VERSION = 1;

export function loadProgress(storage) {
  try {
    const data = JSON.parse(storage.getItem(PROGRESS_KEY));
    if (data?.version === PROGRESS_VERSION) {
      return { ultraUnlocked: Boolean(data.ultraUnlocked) };
    }
  } catch {
    // Invalid progression data falls back to a locked Ultra mode.
  }
  return { ultraUnlocked: false };
}

export function saveProgress(storage, progress) {
  storage.setItem(PROGRESS_KEY, JSON.stringify({
    version: PROGRESS_VERSION,
    ultraUnlocked: Boolean(progress.ultraUnlocked),
  }));
}

export function recordResult(progress, { mode, difficulty, winner }) {
  if (progress.ultraUnlocked || mode !== "computer" || difficulty !== "hard" || winner !== "bottom") {
    return false;
  }
  progress.ultraUnlocked = true;
  return true;
}

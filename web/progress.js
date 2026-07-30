export const PROGRESS_KEY = "laser-war.progress.v1";
export const PROGRESS_VERSION = 1;

/** Load validated Ultra progress or return the locked default. */
export function loadProgress(storage) {
  try {
    const data = JSON.parse(storage.getItem(PROGRESS_KEY));
    if (data?.ultraUnlocked === true) {
      return { ultraUnlocked: true };
    }
    if (data?.version === PROGRESS_VERSION) {
      return { ultraUnlocked: Boolean(data.ultraUnlocked) };
    }
  } catch {
    // Invalid progression data falls back to a locked Ultra mode.
  }
  return { ultraUnlocked: false };
}

/** Persist normalized Ultra progress in browser storage. */
export function saveProgress(storage, progress) {
  storage.setItem(PROGRESS_KEY, JSON.stringify({
    version: PROGRESS_VERSION,
    ultraUnlocked: Boolean(progress.ultraUnlocked),
  }));
}

/** Recover an earned Ultra unlock from a legacy active Ultra match. */
export function recoverUltraProgress(progress, activeSave) {
  if (progress.ultraUnlocked || activeSave?.difficulty !== "ultra") return false;
  progress.ultraUnlocked = true;
  return true;
}

/** Unlock Ultra after the first qualifying Hard-mode victory on either side. */
export function recordResult(progress, {
  mode,
  difficulty,
  winner,
  humanSide = "bottom",
}) {
  if (
    progress.ultraUnlocked
    || mode !== "computer"
    || difficulty !== "hard"
    || winner !== humanSide
  ) {
    return false;
  }
  progress.ultraUnlocked = true;
  return true;
}

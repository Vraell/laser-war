import { createComputerPlayer } from "./ai.js?v=0.14.0";
import { Game } from "./engine.js?v=0.14.0";

const game = new Game();
const chooseMove = createComputerPlayer(game);

self.addEventListener("message", ({ data }) => {
  try {
    const result = chooseMove(data.state, data.difficulty, {
      onProgress(progress) {
        self.postMessage({ type: "progress", requestId: data.requestId, progress });
      },
    });
    self.postMessage({ type: "result", requestId: data.requestId, result });
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId: data.requestId,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
});

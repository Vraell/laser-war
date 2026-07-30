import { createComputerPlayer } from "./ai.js?v=0.12.0";
import { Game } from "./engine.js?v=0.12.0";

const game = new Game();
const chooseMove = createComputerPlayer(game);

self.addEventListener("message", ({ data }) => {
  const result = chooseMove(data.state, data.difficulty, {
    onProgress(progress) {
      self.postMessage({ type: "progress", requestId: data.requestId, progress });
    },
  });
  self.postMessage({ type: "result", requestId: data.requestId, result });
});

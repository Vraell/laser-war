import { chooseComputerMove } from "./ai.js?v=0.11.8";
import { Game } from "./engine.js?v=0.11.8";

const game = new Game();

self.addEventListener("message", ({ data }) => {
  const result = chooseComputerMove(game, data.state, data.difficulty, {
    onProgress(progress) {
      self.postMessage({ type: "progress", requestId: data.requestId, progress });
    },
  });
  self.postMessage({ type: "result", requestId: data.requestId, result });
});

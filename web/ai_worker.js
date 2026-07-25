import { chooseComputerMove } from "./ai.js?v=0.10.2";
import { Game } from "./engine.js?v=0.10.2";

const game = new Game();

self.addEventListener("message", ({ data }) => {
  const result = chooseComputerMove(game, data.state, data.difficulty);
  self.postMessage({ requestId: data.requestId, result });
});

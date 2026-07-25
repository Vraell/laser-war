import { chooseComputerMove } from "./ai.js?v=0.11.4";
import { Game } from "./engine.js?v=0.11.4";

const game = new Game();

self.addEventListener("message", ({ data }) => {
  const result = chooseComputerMove(game, data.state, data.difficulty);
  self.postMessage({ requestId: data.requestId, result });
});

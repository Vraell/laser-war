import { chooseComputerMove } from "./ai.js";
import { Game } from "./engine.js";

const game = new Game();

self.addEventListener("message", ({ data }) => {
  const result = chooseComputerMove(game, data.state, data.difficulty);
  self.postMessage({ requestId: data.requestId, result });
});

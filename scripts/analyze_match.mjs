import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { UltraSearch } from "../web/ai.js";
import { Cell, Game } from "../web/engine.js";

const projectRoot = resolve(import.meta.dirname, "..");
const DEFAULT_PROFILE = {
  timeLimit: Infinity,
  maxDepth: 2,
  rootLimit: 28,
  branchLimits: [22, 14, 10],
};

/** Convert one internal move into standard one-based board notation. */
function moveLabel(move) {
  return move ? `${move.mirror} R${move.row + 1}C${move.col + 1}` : "none";
}

/** Analyze one played move with a wider and deeper profile than game Ultra. */
function analyzeTask(task) {
  const game = new Game();
  const state = structuredClone(task.state);
  const move = task.move;
  const profile = {
    ...DEFAULT_PROFILE,
    maxDepth: task.depth,
  };
  const search = new UltraSearch(game, () => 0, profile);
  const started = performance.now();
  const best = search.choose(state);
  const outcome = game.resolveMove(state, move, false);
  const playedChild = search.strictChild(state, move, outcome.state, true);
  if (!playedChild) throw new Error(`Analyzer received illegal move ${moveLabel(move)}.`);
  const playedScore = -search.negamax(
    playedChild,
    Math.max(0, best.depth - 1),
    -Infinity,
    Infinity,
    1,
  );
  const humanSign = state.turn === "bottom" ? 1 : -1;
  return {
    index: task.index,
    bestMove: best.move,
    bestMoveLabel: moveLabel(best.move),
    bestScoreForMover: best.score,
    playedScoreForMover: playedScore,
    humanEvaluation: playedScore * humanSign,
    loss: Math.max(0, best.score - playedScore),
    depth: best.depth,
    nodes: search.nodes,
    milliseconds: performance.now() - started,
  };
}

/** Parse the analyzer CLI without adding a package dependency. */
function parseArguments(argv) {
  const options = {
    input: null,
    output: null,
    depth: DEFAULT_PROFILE.maxDepth,
    refine: 6,
    refineDepth: 3,
    jobs: 2,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--") && !options.input) options.input = argument;
    else if (argument === "--output") options.output = argv[++index];
    else if (argument === "--depth") options.depth = Number(argv[++index]);
    else if (argument === "--refine") options.refine = Number(argv[++index]);
    else if (argument === "--refine-depth") options.refineDepth = Number(argv[++index]);
    else if (argument === "--jobs") options.jobs = Number(argv[++index]);
    else if (argument === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!options.input) throw new Error("Provide an exported match log or JSON fixture.");
  if (!Number.isInteger(options.depth) || options.depth < 1 || options.depth > 6) {
    throw new Error("--depth must be an integer from 1 to 6.");
  }
  if (!Number.isInteger(options.refine) || options.refine < 0) {
    throw new Error("--refine must be a non-negative integer.");
  }
  if (!Number.isInteger(options.refineDepth) || options.refineDepth < options.depth || options.refineDepth > 6) {
    throw new Error("--refine-depth must be between --depth and 6.");
  }
  if (!Number.isInteger(options.jobs) || options.jobs < 1 || options.jobs > 4) {
    throw new Error("--jobs must be an integer from 1 to 4.");
  }
  return options;
}

/** Parse a copied English or French match log. */
function parseTextLog(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const moves = [];
  for (const line of lines) {
    const match = line.match(
      /^(You|Computer|Vous|IA)\s*:\s*([/\\])\s+(?:at|sur)\s+[RL](\d+)C(\d+)/i,
    );
    if (!match) continue;
    moves.push({
      actor: /^(You|Vous)$/i.test(match[1]) ? "You" : "Computer",
      mirror: match[2],
      row: Number(match[3]) - 1,
      col: Number(match[4]) - 1,
      source: line,
    });
  }
  if (!moves.length) throw new Error("No moves were found in the copied match log.");
  const metadataLine = lines.find((line, index) => index > 0 && line.includes("·"));
  return {
    title: lines[0] || "LASER WAR · MATCH ANALYSIS",
    metadata: metadataLine || "",
    moves,
  };
}

/** Normalize the fixture and saved-match JSON forms used by the project. */
function parseJsonLog(text) {
  const data = JSON.parse(text);
  const sourceMoves = data.moves || data.matches?.[0]?.moves;
  if (!Array.isArray(sourceMoves) || !sourceMoves.length) {
    throw new Error("JSON input does not contain a non-empty moves array.");
  }
  const moves = sourceMoves.map((move, index) => {
    if (Array.isArray(move)) {
      return {
        actor: index % 2 === 0 ? "You" : "Computer",
        row: Number(move[0]) - 1,
        col: Number(move[1]) - 1,
        mirror: move[2],
      };
    }
    return {
      actor: move.actor || (index % 2 === 0 ? "You" : "Computer"),
      row: Number(move.row),
      col: Number(move.col),
      mirror: move.mirror,
    };
  });
  return {
    title: data.title || "LASER WAR · MATCH ANALYSIS",
    metadata: data.metadata || data.description || "",
    moves,
  };
}

/** Read either a copied log or a JSON fixture from disk. */
function readMatch(inputPath) {
  const text = readFileSync(inputPath, "utf8");
  return text.trimStart().startsWith("{") ? parseJsonLog(text) : parseTextLog(text);
}

/** Count shields around each king using the production evaluation radius. */
function shieldMetrics(game, board) {
  return {
    top: game.nearbyShields(board, Cell.TOP_KING),
    bottom: game.nearbyShields(board, Cell.BOTTOM_KING),
    total: board.flat().filter((cell) => cell === Cell.SHIELD).length,
  };
}

/** Replay every move authoritatively and retain display-ready snapshots. */
function replayMatch(match) {
  const game = new Game();
  let state = game.initialState();
  const tasks = [];
  const snapshots = [{
    board: state.board.map((row) => row.join("")),
    turn: state.turn,
    winner: state.winner,
    draw: state.draw,
    beams: game.fireLasers(state.board),
    routes: game.routeCostsByLaser(state.board),
    shields: shieldMetrics(game, state.board),
  }];
  const moves = [];
  for (let index = 0; index < match.moves.length; index += 1) {
    const move = match.moves[index];
    tasks.push({
      index,
      state: structuredClone(state),
      move: { row: move.row, col: move.col, mirror: move.mirror },
    });
    const outcome = game.resolveMove(state, move);
    state = outcome.state;
    moves.push({
      ...move,
      number: index + 1,
      label: moveLabel(move),
      destroyed: outcome.destroyed,
      hitKings: [...outcome.hitKings],
    });
    snapshots.push({
      board: state.board.map((row) => row.join("")),
      turn: state.turn,
      winner: state.winner,
      draw: state.draw,
      beams: game.fireLasers(state.board),
      routes: game.routeCostsByLaser(state.board),
      shields: shieldMetrics(game, state.board),
    });
  }
  return { tasks, moves, snapshots, finalState: state };
}

/** Run CPU-heavy positions through a small persistent worker pool. */
async function analyzeInParallel(tasks, depth, jobs, label = "Analyzed") {
  const results = new Map();
  let nextTask = 0;
  let completed = 0;
  const workers = [];

  await new Promise((resolvePromise, rejectPromise) => {
    const startNext = (worker) => {
      if (nextTask >= tasks.length) {
        if (completed === tasks.length) resolvePromise();
        return;
      }
      const task = { ...tasks[nextTask], depth };
      nextTask += 1;
      worker.postMessage(task);
    };

    for (let index = 0; index < Math.min(jobs, tasks.length); index += 1) {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { analyzerWorker: true },
      });
      workers.push(worker);
      worker.on("message", (message) => {
        if (message.error) {
          rejectPromise(new Error(message.error));
          return;
        }
        results.set(message.result.index, message.result);
        completed += 1;
        process.stdout.write(`\r${label} ${completed}/${tasks.length} positions`);
        startNext(worker);
      });
      worker.on("error", rejectPromise);
      startNext(worker);
    }
  });

  await Promise.all(workers.map((worker) => worker.terminate()));
  process.stdout.write("\n");
  return tasks.map((task) => results.get(task.index));
}

/** Escape embedded report data so it cannot terminate its script element. */
function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/** Describe move quality from the mover's searched centipawn-like loss. */
function qualityLabel(loss) {
  if (loss >= 8000) return "Terminal blunder";
  if (loss >= 500) return "Blunder";
  if (loss >= 220) return "Major mistake";
  if (loss >= 90) return "Inaccuracy";
  return "Sound";
}

/** Produce one self-contained interactive HTML analysis report. */
function buildReport(payload) {
  const terminal = payload.finalState.winner
    ? `${payload.finalState.winner === "bottom" ? "You" : "Ultra"} won`
    : payload.finalState.draw ? "Draw" : "Unfinished";
  const enriched = payload.moves.map((move, index) => ({
    ...move,
    ...payload.analysis[index],
    positionEvaluation: payload.positionEvaluations[index + 1],
    quality: qualityLabel(payload.analysis[index].loss),
  }));
  const worstHuman = [...enriched]
    .filter((move) => move.actor === "You")
    .sort((left, right) => right.loss - left.loss)[0];
  const worstComputer = [...enriched]
    .filter((move) => move.actor === "Computer")
    .sort((left, right) => right.loss - left.loss)[0];
  const reportData = {
    ...payload,
    terminal,
    moves: enriched,
    summary: {
      worstHuman,
      worstComputer,
      totalNodes: payload.analysis.reduce((total, item) => total + item.nodes, 0),
      totalMilliseconds: payload.analysis.reduce((total, item) => total + item.milliseconds, 0),
    },
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Laser War Match Analysis</title>
  <style>
    :root { --bg:#0e1316; --panel:#171e22; --line:#344149; --text:#eef3f5; --muted:#94a4ad;
      --orange:#f2a62b; --cyan:#35c5f4; --red:#ff5f68; --green:#3fc49a; --cell:#d7d8d3; --cell2:#c9cdca; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:15px/1.45 Inter,system-ui,sans-serif; }
    header { border-bottom:1px solid var(--line); padding:22px clamp(18px,4vw,48px); display:flex;
      justify-content:space-between; gap:24px; align-items:end; }
    h1,h2,h3,p { margin:0; } h1 { font-size:clamp(24px,4vw,38px); letter-spacing:0; }
    .eyebrow { color:var(--cyan); font-size:12px; font-weight:800; text-transform:uppercase; }
    .meta,.muted { color:var(--muted); }
    main { display:grid; grid-template-columns:minmax(0,1.5fr) minmax(320px,.8fr); min-height:calc(100vh - 105px); }
    .analysis { padding:28px clamp(18px,4vw,48px); border-right:1px solid var(--line); }
    .sidebar { background:var(--panel); padding:28px; }
    .summary { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:1px; background:var(--line);
      border:1px solid var(--line); margin:24px 0; }
    .metric { background:var(--panel); padding:16px; min-height:86px; }
    .metric strong { display:block; margin-top:5px; font-size:20px; }
    .metric span { color:var(--muted); font-size:11px; text-transform:uppercase; font-weight:800; }
    .chart-wrap { border:1px solid var(--line); background:#11171a; padding:14px; }
    canvas { display:block; width:100%; height:300px; }
    .legend { display:flex; justify-content:space-between; color:var(--muted); font-size:12px; margin-top:8px; }
    .orange { color:var(--orange); } .cyan { color:var(--cyan); }
    .position-head { display:flex; align-items:center; justify-content:space-between; gap:14px; margin-bottom:16px; }
    .position-head button { width:40px; height:36px; border:1px solid var(--line); background:#202a2f;
      color:var(--text); font-size:20px; cursor:pointer; }
    .board-shell { max-width:600px; margin:auto; }
    .board { display:grid; grid-template-columns:repeat(9,1fr); border:2px solid #6f7c82; aspect-ratio:1; }
    .cell { position:relative; display:grid; place-items:center; color:#122027; font-size:clamp(17px,3vw,31px);
      font-weight:800; background:var(--cell); border-right:1px solid #657179; border-bottom:1px solid #657179; }
    .cell:nth-child(even) { background:var(--cell2); }
    .cell.left-beam { box-shadow:inset 0 4px var(--red); }
    .cell.right-beam { box-shadow:inset 0 -4px var(--cyan); }
    .cell.last { outline:3px solid var(--orange); outline-offset:-4px; }
    .cell.shield { color:#087c73; } .cell.top-king { background:#c9eef7; color:#05637d; }
    .cell.bottom-king { background:#ffe5a9; color:#8b5700; }
    .move-detail { margin-top:18px; border-top:1px solid var(--line); padding-top:16px; }
    .eval-meter { height:18px; background:#263137; position:relative; margin:12px 0; }
    .eval-meter::after { content:""; position:absolute; left:50%; top:0; bottom:0; width:1px; background:#dce5e9; }
    .eval-fill { position:absolute; top:0; bottom:0; }
    .detail-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .detail-grid div { border-top:1px solid var(--line); padding-top:8px; }
    .detail-grid small { display:block; color:var(--muted); }
    .move-list { margin-top:28px; max-height:440px; overflow:auto; border-top:1px solid var(--line); }
    .move-row { width:100%; display:grid; grid-template-columns:34px 1fr 84px; gap:8px; align-items:center;
      padding:10px 6px; background:transparent; color:var(--text); border:0; border-bottom:1px solid #2a353a;
      text-align:left; cursor:pointer; }
    .move-row:hover,.move-row.active { background:#222c31; }
    .move-row .score { text-align:right; font-variant-numeric:tabular-nums; }
    .quality { color:var(--muted); font-size:11px; display:block; }
    @media (max-width:900px) { main { grid-template-columns:1fr; } .analysis { border-right:0; }
      .summary { grid-template-columns:1fr 1fr; } .sidebar { border-top:1px solid var(--line); } }
  </style>
</head>
<body>
  <header>
    <div><div class="eyebrow">Offline Ultra · depth ${payload.depth} · selected depth ${payload.refineDepth}</div><h1>Match analysis</h1>
      <p class="meta">${payload.match.metadata || "You vs Ultra AI"}</p></div>
    <div><strong>${terminal}</strong><div class="muted">${payload.moves.length} moves</div></div>
  </header>
  <main>
    <section class="analysis">
      <h2>Evaluation timeline</h2>
      <p class="muted">Above the center favors you; below favors Ultra. Mate scores use the chart edge.</p>
      <div class="summary">
        <div class="metric"><span>Result</span><strong>${terminal}</strong></div>
        <div class="metric"><span>Largest human loss</span><strong>${Math.round(worstHuman?.loss || 0)}</strong></div>
        <div class="metric"><span>Largest Ultra loss</span><strong>${Math.round(worstComputer?.loss || 0)}</strong></div>
        <div class="metric"><span>Positions searched</span><strong>${reportData.summary.totalNodes.toLocaleString()}</strong></div>
      </div>
      <div class="chart-wrap"><canvas id="chart"></canvas>
        <div class="legend"><span class="orange">You</span><span>click a point to inspect</span><span class="cyan">Ultra</span></div>
      </div>
      <div class="move-list" id="move-list"></div>
    </section>
    <aside class="sidebar">
      <div class="position-head"><button id="previous" title="Previous move">‹</button>
        <div><div class="eyebrow" id="position-number"></div><h2 id="position-title"></h2></div>
        <button id="next" title="Next move">›</button></div>
      <div class="board-shell"><div class="board" id="board"></div></div>
      <div class="move-detail">
        <div id="evaluation-label"></div><div class="eval-meter"><div class="eval-fill" id="eval-fill"></div></div>
        <div class="detail-grid">
          <div><small>Best offline move</small><strong id="best-move"></strong></div>
          <div><small>Move quality</small><strong id="quality"></strong></div>
          <div><small>Analysis</small><strong id="telemetry"></strong></div>
          <div><small>Shields remaining</small><strong id="shields"></strong></div>
        </div>
      </div>
    </aside>
  </main>
  <script>
    const data = ${safeJson(reportData)};
    const chart = document.querySelector("#chart");
    const context = chart.getContext("2d");
    let selected = data.moves.length;
    const normalize = value => Math.abs(value) >= 9000 ? Math.sign(value) : Math.tanh(value / 650);
    const scoreText = value => Math.abs(value) >= 9000 ? (value > 0 ? "Mate · You" : "Mate · Ultra")
      : (value > 0 ? "+" : "") + Math.round(value);
    function drawChart() {
      const ratio = devicePixelRatio || 1; const box = chart.getBoundingClientRect();
      chart.width = Math.round(box.width * ratio); chart.height = Math.round(box.height * ratio);
      context.scale(ratio, ratio); const width = box.width; const height = box.height; const pad = 24;
      context.clearRect(0, 0, width, height); context.strokeStyle = "#344149"; context.lineWidth = 1;
      context.beginPath(); context.moveTo(pad, height / 2); context.lineTo(width - pad, height / 2); context.stroke();
      const values = data.positionEvaluations;
      const x = index => pad + index * (width - pad * 2) / Math.max(1, values.length - 1);
      const y = value => height / 2 - normalize(value) * (height / 2 - pad);
      context.strokeStyle = "#dce5e9"; context.lineWidth = 2; context.beginPath();
      values.forEach((value, index) => index ? context.lineTo(x(index), y(value)) : context.moveTo(x(index), y(value)));
      context.stroke();
      values.forEach((value, index) => { context.beginPath(); context.fillStyle = value >= 0 ? "#f2a62b" : "#35c5f4";
        context.arc(x(index), y(value), index === selected ? 6 : 3.5, 0, Math.PI * 2); context.fill(); });
      chart.onclick = event => { const rect = chart.getBoundingClientRect();
        selected = Math.max(0, Math.min(values.length - 1, Math.round((event.clientX - rect.left - pad)
          / (rect.width - pad * 2) * (values.length - 1)))); render(); };
    }
    function renderBoard(snapshot, move) {
      const board = document.querySelector("#board"); board.replaceChildren();
      const left = new Set(snapshot.beams[0].path.map(step => step[0] + "," + step[1]));
      const right = new Set(snapshot.beams[1].path.map(step => step[0] + "," + step[1]));
      snapshot.board.forEach((row, rowIndex) => [...row].forEach((cell, colIndex) => {
        const square = document.createElement("div"); const key = rowIndex + "," + colIndex;
        square.className = "cell" + (left.has(key) ? " left-beam" : "") + (right.has(key) ? " right-beam" : "")
          + (move && move.row === rowIndex && move.col === colIndex ? " last" : "")
          + (cell === "O" ? " shield" : "") + (cell === "k" ? " top-king" : "")
          + (cell === "K" ? " bottom-king" : "");
        square.textContent = cell === "." ? "" : cell === "O" ? "◉" : cell === "k" || cell === "K" ? "♛" : cell;
        board.append(square);
      }));
    }
    function renderList() {
      const list = document.querySelector("#move-list"); list.replaceChildren();
      data.moves.forEach((move, index) => { const button = document.createElement("button");
        button.className = "move-row" + (selected === index + 1 ? " active" : "");
        button.innerHTML = "<span>" + move.number + ".</span><span><strong>" + move.actor + " · " + move.label
          + "</strong><span class=quality>" + move.quality + " · loss " + Math.round(move.loss)
          + "</span></span><span class=score>" + scoreText(move.positionEvaluation) + "</span>";
        button.onclick = () => { selected = index + 1; render(); }; list.append(button); });
      list.querySelector(".active")?.scrollIntoView({ block:"nearest" });
    }
    function render() {
      const move = selected ? data.moves[selected - 1] : null; const snapshot = data.snapshots[selected];
      document.querySelector("#position-number").textContent = selected ? "Move " + selected : "Opening";
      document.querySelector("#position-title").textContent = move ? move.actor + " · " + move.label : "Initial position";
      renderBoard(snapshot, move);
      const value = data.positionEvaluations[selected]; const amount = Math.abs(normalize(value)) * 50;
      const fill = document.querySelector("#eval-fill"); fill.style.width = amount + "%";
      fill.style.left = value >= 0 ? "50%" : (50 - amount) + "%"; fill.style.background = value >= 0 ? "#f2a62b" : "#35c5f4";
      document.querySelector("#evaluation-label").textContent = "Evaluation: " + scoreText(value);
      document.querySelector("#best-move").textContent = move ? move.bestMoveLabel : "—";
      document.querySelector("#quality").textContent = move ? move.quality + " (" + Math.round(move.loss) + ")" : "—";
      document.querySelector("#telemetry").textContent = move ? "depth " + move.depth + " · " + move.nodes.toLocaleString() : "—";
      document.querySelector("#shields").textContent = snapshot.shields.total;
      document.querySelector("#previous").disabled = selected === 0;
      document.querySelector("#next").disabled = selected === data.moves.length;
      renderList(); drawChart();
    }
    document.querySelector("#previous").onclick = () => { selected = Math.max(0, selected - 1); render(); };
    document.querySelector("#next").onclick = () => { selected = Math.min(data.moves.length, selected + 1); render(); };
    addEventListener("resize", drawChart); render();
  </script>
</body>
</html>`;
}

/** Print concise terminal findings alongside the richer HTML report. */
function printSummary(payload, outputPath) {
  const moves = payload.moves.map((move, index) => ({
    ...move,
    ...payload.analysis[index],
    positionEvaluation: payload.positionEvaluations[index + 1],
  }));
  const important = [...moves].sort((left, right) => right.loss - left.loss).slice(0, 6);
  console.log(`Report: ${outputPath}`);
  console.log(`Result: ${payload.finalState.winner || (payload.finalState.draw ? "draw" : "unfinished")}`);
  console.log("Largest move losses:");
  for (const move of important) {
    console.log(
      `  ${move.number}. ${move.actor} ${move.label} · loss ${Math.round(move.loss)}`
      + ` · best ${move.bestMoveLabel} · eval ${Math.round(move.positionEvaluation)}`,
    );
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: node scripts/analyze_match.mjs MATCH_LOG [--depth 2] [--refine 6] "
      + "[--refine-depth 3] [--jobs 2] [--output REPORT.html]",
    );
    return;
  }
  const inputPath = resolve(options.input);
  const match = readMatch(inputPath);
  const replay = replayMatch(match);
  const analysis = await analyzeInParallel(replay.tasks, options.depth, options.jobs);
  const refinementIndexes = [...analysis]
    .sort((left, right) => right.loss - left.loss)
    .slice(0, Math.min(options.refine, analysis.length))
    .map(({ index }) => index);
  if (options.refineDepth > options.depth && refinementIndexes.length) {
    const refinementTasks = refinementIndexes.map((index) => replay.tasks[index]);
    const refined = await analyzeInParallel(
      refinementTasks,
      options.refineDepth,
      options.jobs,
      "Refined",
    );
    for (const result of refined) analysis[result.index] = result;
  }
  const positionEvaluations = analysis.map((item, index) => (
    item.bestScoreForMover * (replay.tasks[index].state.turn === "bottom" ? 1 : -1)
  ));
  const finalEvaluation = replay.finalState.winner
    ? replay.finalState.winner === "bottom" ? 10000 : -10000
    : replay.finalState.draw ? 0 : (() => {
      const game = new Game();
      const search = new UltraSearch(game, () => 0, { ...DEFAULT_PROFILE, maxDepth: 1 });
      const score = search.strategicEvaluation(replay.finalState);
      return score * (replay.finalState.turn === "bottom" ? 1 : -1);
    })();
  positionEvaluations.push(finalEvaluation);
  const outputPath = resolve(
    options.output
      || joinArtifactName(inputPath),
  );
  const payload = {
    depth: options.depth,
    refineDepth: options.refineDepth,
    match,
    moves: replay.moves,
    snapshots: replay.snapshots,
    finalState: replay.finalState,
    analysis,
    positionEvaluations,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, buildReport(payload));
  writeFileSync(outputPath.replace(/\.html?$/i, ".json"), `${JSON.stringify(payload, null, 2)}\n`);
  printSummary(payload, outputPath);
}

/** Derive a stable ignored artifact path from an input filename. */
function joinArtifactName(inputPath) {
  const stem = basename(inputPath).replace(/\.[^.]+$/, "").replace(/[^a-z0-9-]+/gi, "-");
  return resolve(projectRoot, "artifacts", `${stem}-analysis.html`);
}

if (isMainThread) {
  await main();
} else if (workerData?.analyzerWorker) {
  parentPort.on("message", (task) => {
    try {
      parentPort.postMessage({ result: analyzeTask(task) });
    } catch (error) {
      parentPort.postMessage({ error: error.stack || error.message });
    }
  });
}

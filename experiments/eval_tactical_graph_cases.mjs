import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Game } from "../web/engine.js";
import {
  analyzeTacticalPotential,
  buildShieldDependencyGraph,
  hasSplitSingletonAssignment,
  routeOnlyEvaluation,
  tacticalMoveLabel,
} from "./eval_tactical_graph_model.mjs";

const FIXTURE_DIRECTORY = resolve(import.meta.dirname, "../web/fixtures");
const OPPONENT = Object.freeze({ top: "bottom", bottom: "top" });

/** Normalize a one-based fixture move into the engine's zero-based form. */
export function normalizeFixtureMove(move) {
  return { row: move[0] - 1, col: move[1] - 1, mirror: move[2] };
}

/** Load one historical fixture without weakening exact move validation. */
export function loadTacticalFixture(name) {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIRECTORY, name), "utf8"));
}

/** Replay a historical prefix through the authoritative exact rules engine. */
export function replayTacticalFixture(name, plies) {
  const fixture = loadTacticalFixture(name);
  const game = new Game();
  let state = game.initialState();
  for (const encoded of fixture.moves.slice(0, plies)) {
    state = game.resolveMove(state, normalizeFixtureMove(encoded), false, true).state;
  }
  return { game, state, fixture };
}

/** Return whether a child permits an exact opponent mate on the next move. */
export function concedesMateInOne(game, child, player) {
  if (child.winner || child.draw) return child.winner === OPPONENT[player];
  return game.legalChildren(child, true).some(
    ({ state }) => state.winner === OPPONENT[player],
  );
}

/** Return whether the opponent can make one laser permanently exclusive to the victim. */
export function concedesDedicatedLaser(game, child, victim) {
  if (child.winner || child.draw) return false;
  const victimMask = victim === "top" ? 1 : 2;
  for (const { move, state } of game.legalChildren(child, false)) {
    if (!game.reachableKingMasksByLaser(state.board).includes(victimMask)) continue;
    if (game.isLegalMove(child, move)) return true;
  }
  return false;
}

/** Locate one exact child by its one-based report notation. */
function findChild(children, oneBasedMove) {
  const target = normalizeFixtureMove(oneBasedMove);
  return children.find(({ move }) => (
    move.row === target.row && move.col === target.col && move.mirror === target.mirror
  ));
}

/** Build repeatable historical move-ranking cases with independent tactical labels. */
export function historicalTacticalCases() {
  const cases = [];

  {
    const context = replayTacticalFixture("ultra_loss_13_move_log.json", 11);
    const children = context.game.legalChildren(context.state, true);
    cases.push({
      name: "mate-in-one defense outside old root shortlist",
      partition: "development",
      ...context,
      children,
      preferred: children.filter(
        ({ state }) => !concedesMateInOne(context.game, state, context.state.turn),
      ),
      blunders: children.filter(
        ({ state }) => concedesMateInOne(context.game, state, context.state.turn),
      ),
      knownDefense: findChild(children, [4, 7, "\\"]),
      reportedBlunder: findChild(children, [2, 2, "/"]),
    });
  }

  {
    const context = replayTacticalFixture("ultra_loss_18_move_log.json", 17);
    const children = context.game.legalChildren(context.state, true);
    const opponent = OPPONENT[context.state.turn];
    cases.push({
      name: "only legal survival under two-stage attack",
      partition: "held-out",
      ...context,
      children,
      preferred: children.filter(({ state }) => state.winner !== opponent),
      blunders: children.filter(({ state }) => state.winner === opponent),
      knownDefense: findChild(children, [3, 4, "\\"]),
      reportedBlunder: findChild(children, [9, 2, "\\"]),
    });
  }

  {
    const context = replayTacticalFixture("ultra_choke_46_move_log.json", 44);
    const children = context.game.legalChildren(context.state, true);
    cases.push({
      name: "take mate in one instead of the reported choke",
      partition: "held-out",
      ...context,
      children,
      preferred: children.filter(({ state }) => state.winner === context.state.turn),
      blunders: children.filter(({ state }) => state.winner !== context.state.turn),
      knownDefense: findChild(children, [6, 3, "\\"]),
      reportedBlunder: findChild(children, [5, 3, "\\"]),
    });
  }

  {
    const context = replayTacticalFixture("ultra_loss_26_move_log.json", 15);
    const children = context.game.legalChildren(context.state, true);
    cases.push({
      name: "avoid permanent single-laser assignment concession",
      partition: "held-out",
      ...context,
      children,
      preferred: children.filter(
        ({ state }) => !concedesDedicatedLaser(context.game, state, context.state.turn),
      ),
      blunders: children.filter(
        ({ state }) => concedesDedicatedLaser(context.game, state, context.state.turn),
      ),
      knownDefense: null,
      reportedBlunder: findChild(children, [3, 3, "\\"]),
    });
  }

  return cases;
}

/** Find a route-close state whose legal tactical graph contains no attack at all. */
function generateOpenButHarmlessCase() {
  const prefix = replayTacticalFixture("ultra_choke_46_move_log.json", 36);
  for (const attacker of ["top", "bottom"]) {
    const profile = analyzeTacticalPotential(prefix.game, prefix.state, attacker, { proofPlies: 0 });
    if (
      profile.routes.nearestAttack <= 1
      && !profile.alreadyLoaded
      && !profile.immediateWins
      && !profile.loadedThreats
    ) {
      return {
        ...prefix,
        name: "ultra_choke_46_move_log.json",
        plies: 36,
        attacker,
        profile,
        type: "open-but-harmless",
      };
    }
  }
  throw new Error("Unable to generate an open-but-harmless route case.");
}

/** Find a similarly close route that is already enforceable by legal tactics. */
function generateEnforceableRouteCase() {
  const prefix = replayTacticalFixture("forced_loss_40_move_log.json", 2);
  for (const attacker of ["top", "bottom"]) {
    const profile = analyzeTacticalPotential(prefix.game, prefix.state, attacker, { proofPlies: 1 });
    if (
      profile.routes.nearestAttack <= 1
      && (profile.immediateWins > 0 || profile.certificate.status === "proven")
    ) {
      return {
        ...prefix,
        name: "forced_loss_40_move_log.json",
        plies: 2,
        attacker,
        profile,
        type: "enforceable-route",
      };
    }
  }
  throw new Error("Unable to generate an enforceable route case.");
}

/** Find an exact legal move that assigns one laser exclusively to each king. */
function generateSplitAssignmentCase() {
  const prefix = replayTacticalFixture("forced_loss_40_move_log.json", 35);
  for (const child of prefix.game.legalChildren(prefix.state, true)) {
    if (hasSplitSingletonAssignment(prefix.game, child.state)) {
      return {
        ...prefix,
        name: "forced_loss_40_move_log.json",
        plies: 35,
        type: "split-singleton-assignment",
        move: child.move,
        state: child.state,
        masks: prefix.game.reachableKingMasksByLaser(child.state.board),
      };
    }
  }
  throw new Error("Unable to generate a split singleton assignment case.");
}

/** Find a real shield cascade whose attack remains defensible and unproven. */
function generateCascadeDecoyCase() {
  const prefix = replayTacticalFixture("ultra_choke_46_move_log.json", 26);
  const graph = buildShieldDependencyGraph(prefix.game, prefix.state.board);
  for (const attacker of ["top", "bottom"]) {
    const profile = analyzeTacticalPotential(prefix.game, prefix.state, attacker, {
      dependencyGraph: graph,
      proofPlies: 3,
      proofMaxNodes: 3_000,
    });
    if (
      profile.cascade.kingChains
      && !profile.immediateWins
      && profile.certificate.status !== "proven"
      && profile.bestDefensiveMoves >= 3
    ) {
      return {
        ...prefix,
        name: "ultra_choke_46_move_log.json",
        plies: 26,
        attacker,
        profile,
        graph,
        type: "cascade-decoy",
      };
      }
  }
  throw new Error("Unable to generate a harmless shield-cascade case.");
}

/** Find a route-only ranking inversion among independently labelled tactical moves. */
function generateRouteRankingTrap(cases) {
  for (const tacticalCase of cases) {
    const perspective = tacticalCase.state.turn;
    const preferred = tacticalCase.preferred.map((item) => ({
      ...item,
      geometry: routeOnlyEvaluation(tacticalCase.game, item.state, perspective),
    }));
    const blunders = tacticalCase.blunders.map((item) => ({
      ...item,
      geometry: routeOnlyEvaluation(tacticalCase.game, item.state, perspective),
    }));
    for (const blunder of blunders) {
      const defense = preferred.find(({ geometry }) => blunder.geometry >= geometry);
      if (defense) {
        return {
          type: "route-ranking-trap",
          name: tacticalCase.name,
          game: tacticalCase.game,
          state: tacticalCase.state,
          perspective,
          defense,
          blunder,
          geometryGap: blunder.geometry - defense.geometry,
        };
      }
    }
  }
  throw new Error("Unable to generate a route-only tactical ranking trap.");
}

/** Generate deterministic adversarial cases without consulting graph scores. */
export function generatedAdversarialCases(historical = historicalTacticalCases()) {
  return {
    openButHarmless: generateOpenButHarmlessCase(),
    enforceableRoute: generateEnforceableRouteCase(),
    splitAssignment: generateSplitAssignmentCase(),
    cascadeDecoy: generateCascadeDecoyCase(),
    routeRankingTrap: generateRouteRankingTrap(historical),
  };
}

/** Format one generated case's provenance for machine-readable reports. */
export function generatedCaseSummary(item) {
  return {
    type: item.type,
    fixture: item.name,
    plies: item.plies,
    attacker: item.attacker,
    move: item.move ? tacticalMoveLabel(item.move) : undefined,
  };
}

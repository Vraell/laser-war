import json
import unittest
from pathlib import Path

from laser_war.engine import Cell, Game, Move, State


class EngineTests(unittest.TestCase):
    def test_reported_forced_loss_still_enforces_terminal_path_rules(self):
        fixture = json.loads(
            (Path(__file__).parent / "fixtures" / "forced_loss_40_move_log.json").read_text(encoding="utf-8")
        )
        game = Game()
        state = game.initial_state()
        for row, col, mirror in fixture["moves"][:-1]:
            state = game.resolve_move(state, Move(row - 1, col - 1, Cell(mirror))).state

        row, col, mirror = fixture["moves"][-1]
        reported_move = Move(row - 1, col - 1, Cell(mirror))
        self.assertEqual(game.illegal_move_reason(state, reported_move), "right_laser_stranded")
        with self.assertRaisesRegex(ValueError, "right laser"):
            game.resolve_move(state, reported_move)

        legal_children = game.legal_children(state)
        self.assertTrue(legal_children)
        self.assertTrue(all(child.winner == "bottom" for _move, child in legal_children))

    def test_initial_position_and_laser_entry_squares(self):
        game = Game()
        state = game.initial_state()

        self.assertEqual(state.board[0][4], Cell.TOP_KING)
        self.assertEqual(state.board[8][4], Cell.BOTTOM_KING)
        self.assertIn((4, 0), game.laser_entry_squares)
        self.assertIn((4, 8), game.laser_entry_squares)

    def test_cannot_place_in_front_of_lasers(self):
        game = Game()
        state = game.initial_state()

        for col in (0, 8):
            self.assertEqual(
                game.illegal_move_reason(state, Move(4, col, Cell.MIRROR_SLASH)),
                "laser_entry",
            )
            with self.assertRaises(ValueError):
                game.apply_move(state, Move(4, col, Cell.MIRROR_SLASH))

    def test_occupied_kings_and_shields_have_specific_rejection_reasons(self):
        game = Game()
        state = game.initial_state()

        self.assertEqual(
            game.illegal_move_reason(state, Move(0, 4, Cell.MIRROR_SLASH)),
            "occupied_king",
        )
        self.assertEqual(
            game.illegal_move_reason(state, Move(0, 3, Cell.MIRROR_SLASH)),
            "occupied_shield",
        )

    def test_opening_move_count(self):
        game = Game()
        state = game.initial_state()

        self.assertEqual(len(game.legal_moves(state)), 130)
        self.assertEqual(
            game.reachable_kings_by_laser(state.board),
            (frozenset({"top", "bottom"}), frozenset({"top", "bottom"})),
        )

    def test_apply_move_places_mirror_and_changes_turn(self):
        game = Game()
        state = game.initial_state()
        next_state = game.apply_move(state, Move(4, 4, Cell.MIRROR_SLASH))

        self.assertEqual(next_state.board[4][4], Cell.MIRROR_SLASH)
        self.assertEqual(next_state.turn, "top")

    def test_cannot_replace_destroyed_shield_with_mirror_next_to_king(self):
        game = Game()
        state = game.initial_state()
        board = [list(row) for row in state.board]
        board[1][4] = Cell.EMPTY
        exposed_state = State(tuple(tuple(row) for row in board), turn="bottom")

        for mirror in (Cell.MIRROR_SLASH, Cell.MIRROR_BACKSLASH):
            self.assertEqual(
                game.illegal_move_reason(exposed_state, Move(1, 4, mirror)),
                "king_adjacent",
            )
            with self.assertRaisesRegex(ValueError, "adjacent to a king"):
                game.apply_move(exposed_state, Move(1, 4, mirror))

    def test_king_diagonals_are_also_protected(self):
        game = Game()
        state = game.initial_state()
        board = [list(row) for row in state.board]
        board[1][3] = Cell.EMPTY
        exposed_state = State(tuple(tuple(row) for row in board), turn="bottom")

        self.assertFalse(game.is_legal_move(exposed_state, Move(1, 3, Cell.MIRROR_SLASH)))

    def test_forbidden_squares_include_laser_entries_and_king_neighbors(self):
        game = Game()
        state = game.initial_state()
        forbidden = game.mirror_forbidden_squares(state.board)

        self.assertIn((4, 0), forbidden)
        self.assertIn((4, 8), forbidden)
        self.assertIn((1, 3), forbidden)
        self.assertIn((7, 5), forbidden)

    def test_screenshot_fortress_is_detected_as_unreachable(self):
        game = Game()
        layout = (
            ".\\\\.kO//\\",
            "\\...../..",
            "\\\\./////.",
            ".//\\/\\.\\.",
            "./.../.\\.",
            ".........",
            "....\\....",
            "....O....",
            "...OK....",
        )
        board = tuple(tuple(Cell(symbol) for symbol in row) for row in layout)

        self.assertFalse(game.has_possible_path_to_king(board, "top"))
        self.assertTrue(game.has_possible_path_to_king(board, "bottom"))
        self.assertEqual(game.legal_moves(State(board, turn="bottom")), [])

    def test_possible_path_cannot_pass_through_the_other_king(self):
        game = Game()
        layout = (
            "...OkO...",
            "...OOO\\..",
            "....O./..",
            "\\.....\\..",
            ".\\.....\\.",
            "\\/......\\",
            "....O....",
            "...OOO...",
            "...OKO...",
        )
        board = tuple(tuple(Cell(symbol) for symbol in row) for row in layout)

        self.assertTrue(game.has_possible_path_to_king(board, "top"))
        self.assertFalse(game.has_possible_path_to_king(board, "bottom"))

    def test_move_cannot_permanently_strand_a_laser(self):
        game = Game()
        state = game.initial_state()
        setup = (
            Move(4, 7, Cell.MIRROR_BACKSLASH),
            Move(8, 7, Cell.MIRROR_SLASH),
            Move(4, 1, Cell.MIRROR_SLASH),
            Move(0, 0, Cell.MIRROR_SLASH),
            Move(0, 1, Cell.MIRROR_SLASH),
            Move(0, 2, Cell.MIRROR_SLASH),
            Move(1, 1, Cell.MIRROR_SLASH),
            Move(1, 2, Cell.MIRROR_BACKSLASH),
            Move(2, 2, Cell.MIRROR_BACKSLASH),
            Move(2, 4, Cell.MIRROR_BACKSLASH),
            Move(3, 1, Cell.MIRROR_BACKSLASH),
            Move(3, 7, Cell.MIRROR_BACKSLASH),
            Move(3, 6, Cell.MIRROR_BACKSLASH),
            Move(2, 6, Cell.MIRROR_SLASH),
            Move(2, 7, Cell.MIRROR_SLASH),
            Move(1, 7, Cell.MIRROR_SLASH),
            Move(1, 8, Cell.MIRROR_SLASH),
            Move(0, 6, Cell.MIRROR_BACKSLASH),
            Move(0, 8, Cell.MIRROR_BACKSLASH),
        )
        for move in setup:
            state = game.apply_move(state, move)

        self.assertEqual(
            game.reachable_kings_by_laser(state.board),
            (frozenset({"top", "bottom"}), frozenset({"top", "bottom"})),
        )

        stranding_move = Move(0, 7, Cell.MIRROR_BACKSLASH)

        self.assertFalse(game.is_legal_move(state, stranding_move))
        self.assertEqual(game.illegal_move_reason(state, stranding_move), "right_laser_stranded")
        with self.assertRaisesRegex(ValueError, "right laser"):
            game.apply_move(state, stranding_move)

    def test_simultaneous_beams_destroy_a_shared_shield_once(self):
        game = Game()
        board = [[Cell.EMPTY for _ in range(game.size)] for _ in range(game.size)]
        board[0][4] = Cell.TOP_KING
        board[4][4] = Cell.SHIELD
        board[8][4] = Cell.BOTTOM_KING
        state = State(tuple(tuple(row) for row in board), turn="bottom")

        outcome = game.resolve_move(
            state,
            Move(0, 0, Cell.MIRROR_SLASH),
            check_no_legal_moves=False,
        )

        self.assertEqual(outcome.destroyed, ((4, 4),))
        self.assertEqual(tuple(beam.hit_shield for beam in outcome.beams), ((4, 4), (4, 4)))
        self.assertEqual(outcome.state.board[4][4], Cell.EMPTY)

    def test_evaluation_recognizes_immediate_king_pressure(self):
        game = Game()
        board = [[Cell.EMPTY for _ in range(game.size)] for _ in range(game.size)]
        board[0][4] = Cell.TOP_KING
        board[4][1] = Cell.SHIELD
        board[8][4] = Cell.BOTTOM_KING

        board[4][4] = Cell.MIRROR_SLASH
        bottom_threatened = State(tuple(tuple(row) for row in board), turn="bottom")

        board[4][4] = Cell.MIRROR_BACKSLASH
        top_threatened = State(tuple(tuple(row) for row in board), turn="bottom")

        self.assertLess(game.evaluate(bottom_threatened), 0)
        self.assertGreater(game.evaluate(top_threatened), 0)


if __name__ == "__main__":
    unittest.main()

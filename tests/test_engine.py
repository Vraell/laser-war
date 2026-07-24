import unittest

from laser_war.engine import Cell, Game, Move, State


class EngineTests(unittest.TestCase):
    def test_initial_position_and_no_mirror_squares(self):
        game = Game()
        state = game.initial_state()

        self.assertEqual(state.board[0][4], Cell.TOP_KING)
        self.assertEqual(state.board[8][4], Cell.BOTTOM_KING)
        self.assertIn((4, 0), game.no_mirror_squares)
        self.assertIn((4, 8), game.no_mirror_squares)

    def test_cannot_place_in_front_of_lasers(self):
        game = Game()
        state = game.initial_state()

        for col in (0, 8):
            with self.assertRaises(ValueError):
                game.apply_move(state, Move(4, col, Cell.MIRROR_SLASH))

    def test_opening_move_count(self):
        game = Game()
        state = game.initial_state()

        self.assertEqual(len(game.legal_moves(state)), 130)

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


if __name__ == "__main__":
    unittest.main()

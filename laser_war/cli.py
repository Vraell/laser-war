from .engine import Game


def main() -> None:
    game = Game()
    state = game.initial_state()
    print(game.render(state, show_coords=True))
    print()
    print(f"legal opening moves: {len(game.legal_moves(state))}")
    move, score = game.best_move(state, depth=2)
    print(f"best depth-2 move: {move}, score={score}")


if __name__ == "__main__":
    main()

from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from threading import Event
from time import monotonic

import pygame

from .ai import DIFFICULTIES, ComputerAI, SearchResult
from .audio import AudioBank
from .engine import BOARD_SIZE, MIDDLE_ROW, Cell, Move, State
from .session import GameSession, TurnRecord

DESIGN_SIZE = (1280, 800)
FPS = 60
BOARD_RECT = pygame.Rect(76, 98, 612, 612)
CELL_SIZE = BOARD_RECT.width // BOARD_SIZE
SAVE_PATH = Path.home() / "Library" / "Application Support" / "Laser War" / "autosave.json"

COLORS = {
    "ink": "#e7edf1",
    "muted": "#8c9aa4",
    "background": "#0e1215",
    "panel": "#171d22",
    "panel_light": "#20282e",
    "line": "#46545d",
    "cell_a": "#d9d8d1",
    "cell_b": "#c8c8c2",
    "blocked": "#7f8587",
    "blocked_line": "#666c6e",
    "legal": "#53b5a1",
    "hover": "#f1bd4b",
    "red": "#ff4d57",
    "blue": "#42c8f5",
    "amber": "#e8a12d",
    "teal": "#2d998e",
    "glass": "#d7f4ff",
    "danger": "#dc5961",
}


def color(name: str) -> pygame.Color:
    return pygame.Color(COLORS[name])


class CrispFont:
    def __init__(self, path: Path, size: int, *, bold: bool = False, scale: int = 2):
        self.scale = scale
        self.font = pygame.font.Font(path, size * scale)
        self.font.set_bold(bold)

    def render(self, value: str, antialias: bool, foreground: pygame.Color) -> pygame.Surface:
        rendered = self.font.render(value, antialias, foreground)
        target_size = (
            max(1, round(rendered.get_width() / self.scale)),
            max(1, round(rendered.get_height() / self.scale)),
        )
        return pygame.transform.smoothscale(rendered, target_size)

    def size(self, value: str) -> tuple[int, int]:
        width, height = self.font.size(value)
        return round(width / self.scale), round(height / self.scale)

    def get_linesize(self) -> int:
        return round(self.font.get_linesize() / self.scale)


@dataclass
class Button:
    rect: pygame.Rect
    label: str
    action: Callable[[], None]
    selected: bool = False
    enabled: bool = True
    danger: bool = False

    def draw(self, surface: pygame.Surface, font: CrispFont, mouse: tuple[int, int]) -> None:
        hovered = self.enabled and self.rect.collidepoint(mouse)
        if not self.enabled:
            fill = color("panel_light")
            foreground = color("muted")
        elif self.danger:
            fill = color("danger") if hovered else pygame.Color("#913c43")
            foreground = pygame.Color("white")
        elif self.selected:
            fill = color("amber")
            foreground = color("background")
        else:
            fill = pygame.Color("#303a41") if hovered else color("panel_light")
            foreground = color("ink")
        pygame.draw.rect(surface, fill, self.rect, border_radius=6)
        pygame.draw.rect(surface, color("line"), self.rect, 1, border_radius=6)
        text = font.render(self.label, True, foreground)
        surface.blit(text, text.get_rect(center=self.rect.center))

    def click(self, position: tuple[int, int]) -> bool:
        if self.enabled and self.rect.collidepoint(position):
            self.action()
            return True
        return False


@dataclass
class MoveAnimation:
    record: TurnRecord
    elapsed: float = 0.0
    damage_played: bool = False

    @property
    def placed_board(self) -> tuple[tuple[Cell, ...], ...]:
        board = [list(row) for row in self.record.before.board]
        move = self.record.move
        board[move.row][move.col] = move.mirror
        return tuple(tuple(row) for row in board)


@dataclass
class Particle:
    position: pygame.Vector2
    velocity: pygame.Vector2
    color: pygame.Color
    life: float
    size: float


class LaserWarGame:
    def __init__(self) -> None:
        pygame.mixer.pre_init(44_100, -16, 1, 512)
        pygame.init()
        pygame.display.set_caption("Laser War")
        self.window = pygame.display.set_mode(DESIGN_SIZE, pygame.RESIZABLE)
        pygame.display.set_icon(pygame.image.load(Path(__file__).parent / "assets" / "app-icon.png"))
        self.canvas = pygame.Surface(DESIGN_SIZE)
        self.clock = pygame.time.Clock()
        self.running = True

        font_path = Path(__file__).parent / "assets" / "fonts" / "InterVariable.ttf"
        self.fonts = {
            "title": CrispFont(font_path, 64, bold=True),
            "h1": CrispFont(font_path, 34, bold=True),
            "h2": CrispFont(font_path, 22, bold=True),
            "body": CrispFont(font_path, 17),
            "small": CrispFont(font_path, 14),
            "tiny": CrispFont(font_path, 12, bold=True),
        }
        self.audio = AudioBank()
        self.background = self._load_background()
        self.scene = "menu"
        self.paused = False
        self.menu_mode = "computer"
        self.menu_difficulty = "medium"
        self.session = GameSession(mode=self.menu_mode, difficulty=self.menu_difficulty)
        self.selected_mirror = Cell.MIRROR_SLASH
        self.hover_cell: tuple[int, int] | None = None
        self.legal_moves: set[Move] = set()
        self.animation: MoveAnimation | None = None
        self.final_animation: MoveAnimation | None = None
        self.animation_speed = 1.0
        self.particles: list[Particle] = []
        self.toast = ""
        self.toast_until = 0.0
        self.ai_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="laser-war-ai")
        self.ai_future: Future[SearchResult] | None = None
        self.ai_state: State | None = None
        self.ai_cancel = Event()
        self.ai_started = 0.0
        self.last_search: SearchResult | None = None
        self.buttons: list[Button] = []
        self._refresh_legal_moves()

    def _load_background(self) -> pygame.Surface:
        path = Path(__file__).parent / "assets" / "menu-background.png"
        image = pygame.image.load(path).convert()
        return pygame.transform.smoothscale(image, DESIGN_SIZE)

    def run(self) -> None:
        while self.running:
            dt = min(self.clock.tick(FPS) / 1000.0, 0.05)
            mouse = self._virtual_mouse()
            self._handle_events(mouse)
            self._update(dt)
            self._draw(mouse)
            self._present()
        self.close()

    def close(self) -> None:
        self.ai_cancel.set()
        self.ai_executor.shutdown(wait=False, cancel_futures=True)
        pygame.quit()

    def _virtual_mouse(self) -> tuple[int, int]:
        window_w, window_h = self.window.get_size()
        scale = min(window_w / DESIGN_SIZE[0], window_h / DESIGN_SIZE[1])
        width, height = DESIGN_SIZE[0] * scale, DESIGN_SIZE[1] * scale
        offset_x = (window_w - width) / 2
        offset_y = (window_h - height) / 2
        mouse_x, mouse_y = pygame.mouse.get_pos()
        return int((mouse_x - offset_x) / scale), int((mouse_y - offset_y) / scale)

    def _handle_events(self, mouse: tuple[int, int]) -> None:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                self.running = False
            elif event.type == pygame.KEYDOWN:
                self._handle_key(event.key)
            elif event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                self._handle_click(mouse)

        self.hover_cell = self._cell_at(mouse) if self.scene == "game" else None

    def _handle_key(self, key: int) -> None:
        if key == pygame.K_ESCAPE:
            if self.scene == "game":
                self.paused = not self.paused
            elif self.scene == "rules":
                self.scene = "menu"
        if self.scene != "game" or self.paused:
            return
        if key in (pygame.K_q, pygame.K_SLASH):
            self.selected_mirror = Cell.MIRROR_SLASH
        elif key in (pygame.K_e, pygame.K_BACKSLASH):
            self.selected_mirror = Cell.MIRROR_BACKSLASH
        elif key == pygame.K_u:
            self._undo()
        elif key == pygame.K_r:
            self._restart()

    def _handle_click(self, mouse: tuple[int, int]) -> None:
        for button in reversed(self.buttons):
            if button.click(mouse):
                return
        if self.scene == "game" and not self.paused:
            cell = self._cell_at(mouse)
            if cell is not None:
                self._play_human_move(cell)

    def _update(self, dt: float) -> None:
        self._update_particles(dt)
        if self.scene != "game" or self.paused:
            return
        if self.animation:
            self.animation.elapsed += dt * self.animation_speed
            if self.animation.elapsed >= 0.42 and not self.animation.damage_played:
                self.animation.damage_played = True
                self.audio.play("impact" if self.animation.record.outcome.destroyed else "laser")
                self._spawn_damage_particles(self.animation.record)
            if self.animation.elapsed >= 1.15:
                completed = self.animation
                winner = completed.record.outcome.state.winner
                if winner or completed.record.outcome.state.draw:
                    self.final_animation = completed
                self.animation = None
                if winner:
                    self.audio.play("victory")
                elif self._computer_turn():
                    self._start_ai()

        if self.ai_future and self.ai_future.done():
            future = self.ai_future
            searched_state = self.ai_state
            self.ai_future = None
            self.ai_state = None
            try:
                result = future.result()
            except Exception as exc:
                self._show_toast(f"Computer error: {exc}")
                return
            if searched_state != self.session.state:
                if self._computer_turn():
                    self._start_ai()
                return
            self.last_search = result
            if result.move is None:
                self._show_toast("No legal moves. The game is a draw.")
                return
            if not self.session.game.is_legal_move(self.session.state, result.move):
                self._show_toast("Position changed. Computer is searching again.")
                if self._computer_turn():
                    self._start_ai()
                return
            record = self.session.play(result.move, "Computer")
            self._begin_animation(record)
            self._autosave()

    def _draw(self, mouse: tuple[int, int]) -> None:
        self.buttons = []
        if self.scene == "menu":
            self._draw_menu(mouse)
        elif self.scene == "rules":
            self._draw_rules(mouse)
        else:
            self._draw_game(mouse)
        if self.toast and monotonic() < self.toast_until:
            self._draw_toast()

    def _present(self) -> None:
        window_w, window_h = self.window.get_size()
        scale = min(window_w / DESIGN_SIZE[0], window_h / DESIGN_SIZE[1])
        size = (int(DESIGN_SIZE[0] * scale), int(DESIGN_SIZE[1] * scale))
        scaled = pygame.transform.smoothscale(self.canvas, size)
        self.window.fill(color("background"))
        self.window.blit(scaled, ((window_w - size[0]) // 2, (window_h - size[1]) // 2))
        pygame.display.flip()

    def _draw_menu(self, mouse: tuple[int, int]) -> None:
        self.canvas.blit(self.background, (0, 0))
        shade = pygame.Surface(DESIGN_SIZE, pygame.SRCALPHA)
        shade.fill((3, 7, 10, 82))
        pygame.draw.rect(shade, (3, 7, 10, 190), (0, 0, 510, DESIGN_SIZE[1]))
        self.canvas.blit(shade, (0, 0))

        self._text("LASER WAR", self.fonts["title"], color("ink"), (62, 74))
        self._text("TACTICAL MIRROR STRATEGY", self.fonts["small"], color("blue"), (67, 145))

        y = 220
        self._menu_button("Play vs Computer", y, lambda: self._start_game("computer"), self.menu_mode == "computer")
        self._menu_button("Local Two Player", y + 58, lambda: self._start_game("local"), self.menu_mode == "local")
        self._menu_button("Continue", y + 116, self._continue_game, False, SAVE_PATH.exists())

        self._text("DIFFICULTY", self.fonts["tiny"], color("muted"), (67, 425))
        difficulty_buttons = []
        for index, key in enumerate(DIFFICULTIES):
            profile = DIFFICULTIES[key]
            rect = pygame.Rect(62 + index * 128, 450, 118, 42)
            difficulty_buttons.append(
                Button(rect, profile.label, lambda value=key: self._set_difficulty(value), self.menu_difficulty == key)
            )
        self._add_buttons(difficulty_buttons, mouse)

        self._menu_button("Rules", 530, self._show_rules)
        self._menu_button("Quit", 588, self._quit, danger=True)
        sound = "Sound: On" if self.audio.enabled else "Sound: Off"
        self._menu_button(sound, 676, self.audio.toggle)

        version = self.fonts["tiny"].render("v0.2", True, color("muted"))
        self.canvas.blit(version, (448, 757))

    def _draw_rules(self, mouse: tuple[int, int]) -> None:
        self.canvas.fill(color("background"))
        pygame.draw.rect(self.canvas, color("panel"), (0, 0, 1280, 800))
        self._text("HOW TO PLAY", self.fonts["h1"], color("ink"), (76, 58))
        self._text(
            "Redirect either side laser. Break the shields. Hit the opposing king.",
            self.fonts["body"],
            color("blue"),
            (76, 110),
        )

        sections = [
            ("PLACE", "Choose / or \\ and place one mirror on any highlighted empty cell."),
            ("FIRE", "Both lasers fire after every move. Mirrors redirect beams by 90 degrees."),
            ("DAMAGE", "A beam destroys the first shield it touches. Mirrors cannot be destroyed."),
            ("WIN", "Hit the opposing king without hitting your own. A simultaneous king hit is a draw."),
            ("RESTRICTIONS", "Grey cells reject mirrors. Every legal move must leave a possible route to both kings."),
            ("CONTROLS", "Q and E select mirrors. U undoes. R restarts. Escape pauses."),
        ]
        for index, (heading, body) in enumerate(sections):
            column = index % 2
            row = index // 2
            x = 76 + column * 586
            y = 180 + row * 150
            self._text(heading, self.fonts["h2"], color("amber"), (x, y))
            self._wrapped_text(body, self.fonts["body"], color("ink"), pygame.Rect(x, y + 38, 500, 88))

        self._add_button(Button(pygame.Rect(76, 708, 180, 48), "Back", self._show_menu), mouse)

    def _draw_game(self, mouse: tuple[int, int]) -> None:
        self.canvas.fill(color("background"))
        pygame.draw.rect(self.canvas, color("panel"), (732, 0, 548, 800))
        self._draw_board()
        self._draw_side_panel(mouse)
        if self.paused:
            self._draw_pause(mouse)
        elif (self.session.state.winner or self.session.state.draw) and not self.animation:
            self._draw_result(mouse)

    def _draw_board(self) -> None:
        board = self.session.state.board
        if self.animation and self.animation.elapsed < 0.58:
            board = self.animation.placed_board
        forbidden = self.session.game.mirror_forbidden_squares(board)
        legal_cells = {(move.row, move.col) for move in self.legal_moves}

        pygame.draw.rect(self.canvas, pygame.Color("#090d0f"), BOARD_RECT.inflate(16, 16), border_radius=4)
        for row in range(BOARD_SIZE):
            for col in range(BOARD_SIZE):
                rect = self._cell_rect(row, col)
                fill = color("cell_a" if (row + col) % 2 == 0 else "cell_b")
                if (row, col) in forbidden:
                    fill = color("blocked")
                pygame.draw.rect(self.canvas, fill, rect)
                pygame.draw.rect(self.canvas, color("line"), rect, 1)
                if (row, col) in forbidden:
                    hatch = pygame.Surface(rect.size, pygame.SRCALPHA)
                    for offset in range(-CELL_SIZE, CELL_SIZE * 2, 12):
                        pygame.draw.line(
                            hatch,
                            color("blocked_line"),
                            (offset, CELL_SIZE),
                            (offset + CELL_SIZE, 0),
                            1,
                        )
                    self.canvas.blit(hatch, rect)
                elif (row, col) in legal_cells and self._human_turn() and not self.animation and not self.ai_future:
                    pygame.draw.circle(self.canvas, color("legal"), rect.center, 4)

        pygame.draw.rect(self.canvas, pygame.Color("#68757d"), BOARD_RECT, 3)
        self._draw_sources()
        self._draw_coordinates()

        for row, cells in enumerate(board):
            for col, cell in enumerate(cells):
                self._draw_piece(cell, self._cell_rect(row, col), row, col)

        if self.hover_cell and self._human_turn() and not self.animation:
            move = Move(*self.hover_cell, self.selected_mirror)
            if move in self.legal_moves:
                rect = self._cell_rect(*self.hover_cell)
                overlay = pygame.Surface(rect.size, pygame.SRCALPHA)
                overlay.fill((*color("hover")[:3], 58))
                self.canvas.blit(overlay, rect)
                self._draw_mirror(rect, self.selected_mirror, ghost=True)

        visible_beams = self.animation
        if visible_beams is None and (self.session.state.winner or self.session.state.draw):
            visible_beams = self.final_animation
        if visible_beams:
            self._draw_beam_animation(visible_beams)
        self._draw_particles()

    def _draw_piece(self, cell: Cell, rect: pygame.Rect, row: int, col: int) -> None:
        if cell == Cell.EMPTY:
            return
        if cell in (Cell.MIRROR_SLASH, Cell.MIRROR_BACKSLASH):
            self._draw_mirror(rect, cell)
        elif cell == Cell.SHIELD:
            self._draw_shield(rect)
        elif cell in (Cell.TOP_KING, Cell.BOTTOM_KING):
            self._draw_king(rect, cell == Cell.TOP_KING)

    def _draw_mirror(self, rect: pygame.Rect, mirror: Cell, ghost: bool = False) -> None:
        margin = 14
        if mirror == Cell.MIRROR_SLASH:
            start, end = (rect.left + margin, rect.bottom - margin), (rect.right - margin, rect.top + margin)
        else:
            start, end = (rect.left + margin, rect.top + margin), (rect.right - margin, rect.bottom - margin)
        alpha = 120 if ghost else 255
        layer = pygame.Surface(rect.size, pygame.SRCALPHA)
        local_start = (start[0] - rect.left, start[1] - rect.top)
        local_end = (end[0] - rect.left, end[1] - rect.top)
        pygame.draw.line(layer, (38, 48, 55, alpha), local_start, local_end, 11)
        pygame.draw.line(layer, (*color("glass")[:3], alpha), local_start, local_end, 6)
        pygame.draw.line(layer, (255, 255, 255, alpha), local_start, local_end, 2)
        self.canvas.blit(layer, rect)

    def _draw_shield(self, rect: pygame.Rect) -> None:
        center = pygame.Vector2(rect.center)
        radius = 23
        points = [center + pygame.Vector2(radius, 0).rotate(index * 45) for index in range(8)]
        pygame.draw.polygon(self.canvas, pygame.Color("#176b68"), points)
        pygame.draw.polygon(self.canvas, color("teal"), points, 4)
        pygame.draw.circle(self.canvas, pygame.Color("#b9e1db"), rect.center, 10, 2)
        pygame.draw.line(
            self.canvas,
            pygame.Color("#73bdb3"),
            (rect.centerx - 8, rect.centery),
            (rect.centerx + 8, rect.centery),
            2,
        )

    def _draw_king(self, rect: pygame.Rect, top: bool) -> None:
        accent = color("blue" if top else "amber")
        plate = rect.inflate(-18, -18)
        pygame.draw.rect(self.canvas, pygame.Color("#11181c"), plate, border_radius=5)
        pygame.draw.rect(self.canvas, accent, plate, 3, border_radius=5)
        cx, cy = rect.center
        crown = [
            (cx - 18, cy + 11),
            (cx - 19, cy - 10),
            (cx - 8, cy - 1),
            (cx, cy - 17),
            (cx + 8, cy - 1),
            (cx + 19, cy - 10),
            (cx + 18, cy + 11),
        ]
        pygame.draw.polygon(self.canvas, accent, crown)
        pygame.draw.line(self.canvas, pygame.Color("white"), (cx - 17, cy + 5), (cx + 17, cy + 5), 2)

    def _draw_sources(self) -> None:
        y = BOARD_RECT.top + MIDDLE_ROW * CELL_SIZE + CELL_SIZE // 2
        for x, beam_color, direction in (
            (BOARD_RECT.left - 40, color("red"), 1),
            (BOARD_RECT.right + 40, color("blue"), -1),
        ):
            pygame.draw.circle(self.canvas, pygame.Color("#20272c"), (x, y), 17)
            pygame.draw.circle(self.canvas, beam_color, (x, y), 9, 3)
            pygame.draw.line(self.canvas, beam_color, (x + direction * 10, y), (x + direction * 30, y), 4)

    def _draw_coordinates(self) -> None:
        for index in range(BOARD_SIZE):
            label = self.fonts["tiny"].render(str(index + 1), True, color("muted"))
            x = BOARD_RECT.left + index * CELL_SIZE + CELL_SIZE // 2
            y = BOARD_RECT.top + index * CELL_SIZE + CELL_SIZE // 2
            self.canvas.blit(label, label.get_rect(center=(x, BOARD_RECT.top - 23)))
            self.canvas.blit(label, label.get_rect(center=(BOARD_RECT.left - 24, y)))

    def _draw_beam_animation(self, animation: MoveAnimation) -> None:
        progress = min(1.0, max(0.0, (animation.elapsed - 0.12) / 0.48))
        for index, beam in enumerate(animation.record.outcome.beams):
            beam_color = color("red" if index == 0 else "blue")
            source_x = BOARD_RECT.left - 40 if index == 0 else BOARD_RECT.right + 40
            source_y = BOARD_RECT.top + MIDDLE_ROW * CELL_SIZE + CELL_SIZE // 2
            points = [(source_x, source_y)]
            points.extend(self._cell_rect(row, col).center for row, col, _direction in beam.path)
            self._draw_partial_line(points, progress, beam_color)

    def _draw_partial_line(
        self,
        points: list[tuple[int, int]],
        progress: float,
        beam_color: pygame.Color,
    ) -> None:
        if len(points) < 2 or progress <= 0:
            return
        segment_progress = progress * (len(points) - 1)
        completed = int(segment_progress)
        visible = points[: completed + 1]
        if completed < len(points) - 1:
            fraction = segment_progress - completed
            start = pygame.Vector2(points[completed])
            end = pygame.Vector2(points[completed + 1])
            visible.append(start.lerp(end, fraction))
        if len(visible) >= 2:
            pygame.draw.lines(self.canvas, pygame.Color("#ffffff"), False, visible, 8)
            pygame.draw.lines(self.canvas, beam_color, False, visible, 4)

    def _draw_side_panel(self, mouse: tuple[int, int]) -> None:
        status, status_color = self._status()
        self._text(status, self.fonts["h1"], status_color, (780, 54))
        mode = "VS COMPUTER" if self.session.mode == "computer" else "LOCAL TWO PLAYER"
        self._text(mode, self.fonts["tiny"], color("muted"), (783, 101))

        self._text("MIRROR", self.fonts["tiny"], color("muted"), (783, 151))
        slash = Button(
            pygame.Rect(780, 174, 104, 56),
            "/",
            lambda: self._select(Cell.MIRROR_SLASH),
            self.selected_mirror == Cell.MIRROR_SLASH,
        )
        backslash = Button(
            pygame.Rect(894, 174, 104, 56),
            "\\",
            lambda: self._select(Cell.MIRROR_BACKSLASH),
            self.selected_mirror == Cell.MIRROR_BACKSLASH,
        )
        self._add_buttons([slash, backslash], mouse)

        controls = [
            Button(
                pygame.Rect(780, 254, 104, 44),
                "Undo",
                self._undo,
                enabled=bool(self.session.history) and not self.animation,
            ),
            Button(
                pygame.Rect(894, 254, 104, 44),
                "Redo",
                self._redo,
                enabled=bool(self.session.redo_stack) and not self.animation,
            ),
            Button(pygame.Rect(1008, 254, 104, 44), "Pause", self._toggle_pause),
        ]
        self._add_buttons(controls, mouse)

        self._text("MATCH LOG", self.fonts["tiny"], color("muted"), (783, 342))
        if not self.session.history:
            self._text("Awaiting the first move.", self.fonts["body"], color("muted"), (783, 374))
        else:
            y = 374
            for record in self.session.history[-6:]:
                y = (
                    self._wrapped_text(
                        record.summary,
                        self.fonts["small"],
                        color("ink"),
                        pygame.Rect(783, y, 438, 54),
                    )
                    + 7
                )

        if self.ai_future:
            seconds = monotonic() - self.ai_started
            self._text(f"Searching {seconds:.1f}s", self.fonts["small"], color("blue"), (783, 704))
        elif self.last_search:
            result = self.last_search
            detail = f"AI depth {result.depth} | {result.nodes:,} nodes | {result.elapsed:.2f}s"
            self._text(detail, self.fonts["tiny"], color("muted"), (783, 708))

        footer_buttons = [
            Button(pygame.Rect(780, 742, 150, 42), "New Match", self._restart),
            Button(pygame.Rect(940, 742, 150, 42), "Main Menu", self._return_to_menu),
            Button(pygame.Rect(1100, 742, 120, 42), "Sound", self.audio.toggle, self.audio.enabled),
        ]
        self._add_buttons(footer_buttons, mouse)

    def _draw_pause(self, mouse: tuple[int, int]) -> None:
        self._draw_overlay()
        self.buttons = []
        self._text("PAUSED", self.fonts["h1"], color("ink"), (548, 230))
        buttons = [
            Button(pygame.Rect(500, 302, 280, 50), "Resume", self._toggle_pause),
            Button(pygame.Rect(500, 366, 280, 50), "Restart Match", self._restart),
            Button(pygame.Rect(500, 430, 280, 50), "Main Menu", self._return_to_menu),
        ]
        self._add_buttons(buttons, mouse)

    def _draw_result(self, mouse: tuple[int, int]) -> None:
        self._draw_overlay()
        if self.final_animation:
            self._draw_beam_animation(self.final_animation)
        self.buttons = []
        if self.session.state.draw:
            heading, accent = "DRAW", color("ink")
        else:
            winner = self.session.state.winner or ""
            if self.session.mode == "computer":
                heading = "VICTORY" if winner == "bottom" else "DEFEAT"
            else:
                heading = f"{winner.upper()} WINS"
            accent = color("amber" if winner == "bottom" else "blue")
        text = self.fonts["title"].render(heading, True, accent)
        self.canvas.blit(text, text.get_rect(center=(640, 277)))
        buttons = [
            Button(pygame.Rect(500, 360, 280, 50), "Play Again", self._restart),
            Button(pygame.Rect(500, 424, 280, 50), "Main Menu", self._return_to_menu),
        ]
        self._add_buttons(buttons, mouse)

    def _draw_overlay(self) -> None:
        overlay = pygame.Surface(DESIGN_SIZE, pygame.SRCALPHA)
        overlay.fill((5, 8, 10, 210))
        self.canvas.blit(overlay, (0, 0))

    def _draw_toast(self) -> None:
        text = self.fonts["body"].render(self.toast, True, pygame.Color("white"))
        rect = text.get_rect(center=(640, 752)).inflate(32, 20)
        pygame.draw.rect(self.canvas, pygame.Color("#752f36"), rect, border_radius=6)
        self.canvas.blit(text, text.get_rect(center=rect.center))

    def _update_particles(self, dt: float) -> None:
        alive = []
        for particle in self.particles:
            particle.life -= dt
            if particle.life <= 0:
                continue
            particle.position += particle.velocity * dt
            particle.velocity *= 0.94
            alive.append(particle)
        self.particles = alive

    def _spawn_damage_particles(self, record: TurnRecord) -> None:
        for row, col in record.outcome.destroyed:
            center = pygame.Vector2(self._cell_rect(row, col).center)
            for index in range(18):
                angle = index * (360 / 18)
                speed = 55 + (index % 5) * 13
                self.particles.append(
                    Particle(center.copy(), pygame.Vector2(speed, 0).rotate(angle), color("teal"), 0.65, 4)
                )

    def _draw_particles(self) -> None:
        for particle in self.particles:
            radius = max(1, int(particle.size * particle.life / 0.65))
            pygame.draw.circle(self.canvas, particle.color, particle.position, radius)

    def _play_human_move(self, cell: tuple[int, int]) -> None:
        if not self._human_turn() or self.animation or self.ai_future or self.session.state.winner:
            return
        move = Move(*cell, self.selected_mirror)
        if move not in self.legal_moves:
            self._show_toast("That mirror placement is not legal.")
            return
        actor = "You" if self.session.mode == "computer" else self.session.state.turn.title()
        record = self.session.play(move, actor)
        self._begin_animation(record)
        self._autosave()

    def _begin_animation(self, record: TurnRecord) -> None:
        self.final_animation = None
        self.animation = MoveAnimation(record)
        self.audio.play("place")
        self._refresh_legal_moves()

    def _start_ai(self) -> None:
        if not self._computer_turn() or self.ai_future:
            return
        self.ai_cancel = Event()
        state = self.session.state
        difficulty = self.session.difficulty
        ai = ComputerAI(self.session.game)
        self.ai_started = monotonic()
        self.ai_state = state
        self.ai_future = self.ai_executor.submit(ai.choose_move, state, difficulty, self.ai_cancel)

    def _cancel_ai(self) -> None:
        self.ai_cancel.set()
        if self.ai_future:
            self.ai_future.cancel()
            self.ai_future = None
        self.ai_state = None

    def _start_game(self, mode: str) -> None:
        self.menu_mode = mode
        self.session.new_game(mode=mode, difficulty=self.menu_difficulty)
        self.scene = "game"
        self.paused = False
        self.last_search = None
        self.final_animation = None
        self._refresh_legal_moves()
        self._autosave()

    def _continue_game(self) -> None:
        try:
            self.session = GameSession.load(SAVE_PATH)
        except (OSError, ValueError, KeyError) as exc:
            self._show_toast(f"Could not load save: {exc}")
            return
        self.menu_mode = self.session.mode
        self.menu_difficulty = self.session.difficulty
        self.scene = "game"
        self.paused = False
        self._restore_terminal_animation()
        self._refresh_legal_moves()
        if self._computer_turn():
            self._start_ai()

    def _undo(self) -> None:
        self._cancel_ai()
        self.animation = None
        self.final_animation = None
        if self.session.undo():
            self.audio.play("undo")
            self.last_search = None
            self._refresh_legal_moves()
            self._autosave()

    def _redo(self) -> None:
        self._cancel_ai()
        restored = self.session.redo()
        if restored:
            self.audio.play("place")
            self.last_search = None
            self._restore_terminal_animation()
            self._refresh_legal_moves()
            self._autosave()
            if self._computer_turn() and not self.session.redo_stack:
                self._start_ai()

    def _restart(self) -> None:
        self._cancel_ai()
        self.session.new_game()
        self.animation = None
        self.final_animation = None
        self.particles.clear()
        self.paused = False
        self.last_search = None
        self._refresh_legal_moves()
        self._autosave()

    def _return_to_menu(self) -> None:
        self._cancel_ai()
        self.animation = None
        self.final_animation = None
        self.paused = False
        self.scene = "menu"

    def _autosave(self) -> None:
        try:
            self.session.save(SAVE_PATH)
        except OSError:
            self._show_toast("Autosave is unavailable.")

    def _refresh_legal_moves(self) -> None:
        self.legal_moves = set(self.session.game.legal_moves(self.session.state))

    def _restore_terminal_animation(self) -> None:
        self.final_animation = None
        if (self.session.state.winner or self.session.state.draw) and self.session.history:
            self.final_animation = MoveAnimation(self.session.history[-1], elapsed=1.15, damage_played=True)

    def _human_turn(self) -> bool:
        return self.session.mode == "local" or self.session.state.turn == "bottom"

    def _computer_turn(self) -> bool:
        state = self.session.state
        return self.session.mode == "computer" and state.turn == "top" and not state.winner and not state.draw

    def _status(self) -> tuple[str, pygame.Color]:
        state = self.session.state
        if state.winner:
            return f"{state.winner.title()} wins", color("amber" if state.winner == "bottom" else "blue")
        if state.draw:
            return "Draw", color("ink")
        if self.ai_future:
            return "Computer thinking", color("blue")
        if self.session.mode == "computer":
            return "Your turn", color("amber")
        return f"{state.turn.title()} to move", color("amber" if state.turn == "bottom" else "blue")

    def _cell_at(self, position: tuple[int, int]) -> tuple[int, int] | None:
        if not BOARD_RECT.collidepoint(position):
            return None
        col = (position[0] - BOARD_RECT.left) // CELL_SIZE
        row = (position[1] - BOARD_RECT.top) // CELL_SIZE
        if 0 <= row < BOARD_SIZE and 0 <= col < BOARD_SIZE:
            return row, col
        return None

    def _cell_rect(self, row: int, col: int) -> pygame.Rect:
        return pygame.Rect(
            BOARD_RECT.left + col * CELL_SIZE,
            BOARD_RECT.top + row * CELL_SIZE,
            CELL_SIZE,
            CELL_SIZE,
        )

    def _select(self, mirror: Cell) -> None:
        self.selected_mirror = mirror

    def _set_difficulty(self, difficulty: str) -> None:
        self.menu_difficulty = difficulty

    def _show_rules(self) -> None:
        self.scene = "rules"

    def _show_menu(self) -> None:
        self.scene = "menu"

    def _toggle_pause(self) -> None:
        self.paused = not self.paused

    def _show_toast(self, message: str) -> None:
        self.toast = message
        self.toast_until = monotonic() + 2.8

    def _quit(self) -> None:
        self.running = False

    def _menu_button(
        self,
        label: str,
        y: int,
        action: Callable[[], None],
        selected: bool = False,
        enabled: bool = True,
        danger: bool = False,
    ) -> None:
        self.buttons.append(Button(pygame.Rect(62, y, 388, 48), label, action, selected, enabled, danger))
        self.buttons[-1].draw(self.canvas, self.fonts["body"], self._virtual_mouse())

    def _add_button(self, button: Button, mouse: tuple[int, int]) -> None:
        self.buttons.append(button)
        button.draw(self.canvas, self.fonts["body"], mouse)

    def _add_buttons(self, buttons: list[Button], mouse: tuple[int, int]) -> None:
        for button in buttons:
            self._add_button(button, mouse)

    def _text(
        self,
        value: str,
        font: CrispFont,
        foreground: pygame.Color,
        position: tuple[int, int],
    ) -> None:
        self.canvas.blit(font.render(value, True, foreground), position)

    def _wrapped_text(
        self,
        value: str,
        font: CrispFont,
        foreground: pygame.Color,
        rect: pygame.Rect,
    ) -> int:
        words = value.split()
        lines: list[str] = []
        line = ""
        for word in words:
            candidate = f"{line} {word}".strip()
            if font.size(candidate)[0] <= rect.width:
                line = candidate
            else:
                lines.append(line)
                line = word
        if line:
            lines.append(line)
        y = rect.top
        for line in lines:
            self._text(line, font, foreground, (rect.left, y))
            y += font.get_linesize()
        return y


def main() -> None:
    LaserWarGame().run()


if __name__ == "__main__":
    main()

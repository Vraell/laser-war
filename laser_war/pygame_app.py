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
from .engine import BOARD_SIZE, MIDDLE_ROW, BeamResult, Cell, Move, State
from .i18n import translate
from .paths import MATCH_LOG_DIRECTORY, PREFERENCES_PATH, PROGRESS_PATH, SAVE_PATH
from .preferences import Preferences
from .progress import Progress
from .session import GameSession, TurnRecord

DESIGN_SIZE = (1280, 800)
FPS = 60
BOARD_RECT = pygame.Rect(76, 98, 612, 612)
CELL_SIZE = BOARD_RECT.width // BOARD_SIZE
BEAM_TRAVEL_START_SECONDS = 0.12
BEAM_TRAVEL_SECONDS = 0.48
BEAM_HOLD_SECONDS = 0.30
MOVE_ANIMATION_SECONDS = BEAM_TRAVEL_START_SECONDS + BEAM_TRAVEL_SECONDS + BEAM_HOLD_SECONDS

COLORS = {
    "ink": "#e7edf1",
    "muted": "#8c9aa4",
    "background": "#0e1215",
    "panel": "#171d22",
    "panel_light": "#20282e",
    "line": "#46545d",
    "cell_a": "#d9d8d1",
    "cell_b": "#c8c8c2",
    "blocked": "#d8c16f",
    "blocked_line": "#af9337",
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
        """Render fonts supersampled for crisp downscaled text."""
        self.scale = scale
        self.font = pygame.font.Font(path, size * scale)
        self.font.set_bold(bold)

    def render(self, value: str, antialias: bool, foreground: pygame.Color) -> pygame.Surface:
        """Render text at high resolution and downscale it cleanly."""
        rendered = self.font.render(value, antialias, foreground)
        target_size = (
            max(1, round(rendered.get_width() / self.scale)),
            max(1, round(rendered.get_height() / self.scale)),
        )
        return pygame.transform.smoothscale(rendered, target_size)

    def size(self, value: str) -> tuple[int, int]:
        """Measure text in final display pixels."""
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
        """Draw the button for its enabled, selected, and hover state."""
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
        """Invoke the action when an enabled button contains the click."""
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
        """Return the pre-damage board with the new mirror placed."""
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
        """Initialize Pygame, persistent state, rendering assets, and AI resources."""
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
        self.preferences = Preferences.load(PREFERENCES_PATH)
        self.progress = Progress.load(PROGRESS_PATH)
        self.ultra_unlocked_this_match = False
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
        """Load and scale the main-menu background artwork."""
        path = Path(__file__).parent / "assets" / "menu-background.png"
        image = pygame.image.load(path).convert()
        return pygame.transform.smoothscale(image, DESIGN_SIZE)

    def run(self) -> None:
        """Run the fixed-rate event, update, draw, and present loop."""
        while self.running:
            dt = min(self.clock.tick(FPS) / 1000.0, 0.05)
            mouse = self._virtual_mouse()
            self._handle_events(mouse)
            self._update(dt)
            self._draw(mouse)
            self._present()
        self.close()

    def close(self) -> None:
        """Cancel background work and release Pygame resources."""
        self.ai_cancel.set()
        self.ai_executor.shutdown(wait=False, cancel_futures=True)
        pygame.quit()

    def _virtual_mouse(self) -> tuple[int, int]:
        """Map window-space mouse coordinates into the design canvas."""
        window_w, window_h = self.window.get_size()
        scale = min(window_w / DESIGN_SIZE[0], window_h / DESIGN_SIZE[1])
        width, height = DESIGN_SIZE[0] * scale, DESIGN_SIZE[1] * scale
        offset_x = (window_w - width) / 2
        offset_y = (window_h - height) / 2
        mouse_x, mouse_y = pygame.mouse.get_pos()
        return int((mouse_x - offset_x) / scale), int((mouse_y - offset_y) / scale)

    def _handle_events(self, mouse: tuple[int, int]) -> None:
        """Dispatch queued window, keyboard, and pointer events."""
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                self.running = False
            elif event.type == pygame.KEYDOWN:
                self._handle_key(event.key)
            elif event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                self._handle_click(mouse)

        self.hover_cell = self._cell_at(mouse) if self.scene == "game" else None

    def _handle_key(self, key: int) -> None:
        """Apply scene-aware keyboard controls."""
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
        """Dispatch a click to controls before attempting a board move."""
        for button in reversed(self.buttons):
            if button.click(mouse):
                return
        if self.scene == "game" and not self.paused:
            cell = self._cell_at(mouse)
            if cell is not None:
                self._play_human_move(cell)

    def _update(self, dt: float) -> None:
        """Advance animation, particles, and completed AI searches."""
        self._update_particles(dt)
        if self.scene != "game" or self.paused:
            return
        if self.animation:
            self.animation.elapsed += dt * self.animation_speed
            if self.animation.elapsed >= 0.42 and not self.animation.damage_played:
                self.animation.damage_played = True
                self.audio.play("impact" if self.animation.record.outcome.destroyed else "laser")
                self._spawn_damage_particles(self.animation.record)
            if self.animation.elapsed >= MOVE_ANIMATION_SECONDS:
                completed = self.animation
                winner = completed.record.outcome.state.winner
                if winner or completed.record.outcome.state.draw:
                    self.final_animation = completed
                self.animation = None
                if winner:
                    self._record_progress()
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
                self._show_toast(self._t("computer_error", error=exc))
                return
            if searched_state != self.session.state:
                if self._computer_turn():
                    self._start_ai()
                return
            self.last_search = result
            if result.move is None:
                self._show_toast(self._t("no_legal_moves"))
                return
            if not self.session.game.is_legal_move(self.session.state, result.move):
                self._show_toast(self._t("position_changed"))
                if self._computer_turn():
                    self._start_ai()
                return
            record = self.session.play(result.move, "computer")
            self._begin_animation(record)
            self._autosave()

    def _draw(self, mouse: tuple[int, int]) -> None:
        """Render the active scene and any transient toast."""
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
        """Scale the design canvas into the current window with letterboxing."""
        window_w, window_h = self.window.get_size()
        scale = min(window_w / DESIGN_SIZE[0], window_h / DESIGN_SIZE[1])
        size = (int(DESIGN_SIZE[0] * scale), int(DESIGN_SIZE[1] * scale))
        scaled = pygame.transform.smoothscale(self.canvas, size)
        self.window.fill(color("background"))
        self.window.blit(scaled, ((window_w - size[0]) // 2, (window_h - size[1]) // 2))
        pygame.display.flip()

    def _draw_menu(self, mouse: tuple[int, int]) -> None:
        """Render the localized main menu and its controls."""
        self.canvas.blit(self.background, (0, 0))
        shade = pygame.Surface(DESIGN_SIZE, pygame.SRCALPHA)
        shade.fill((3, 7, 10, 72))
        pygame.draw.rect(shade, (3, 7, 10, 214), (0, 0, 520, DESIGN_SIZE[1]))
        self.canvas.blit(shade, (0, 0))

        self._text(self._t("tagline"), self.fonts["tiny"], color("blue"), (67, 70))
        self._text("LASER WAR", self.fonts["title"], color("ink"), (62, 96))

        y = 220
        self._menu_button(
            self._t("play_computer"),
            y,
            lambda: self._start_game("computer"),
            self.menu_mode == "computer",
        )
        self._menu_button(
            self._t("local_two_player"),
            y + 58,
            lambda: self._start_game("local"),
            self.menu_mode == "local",
        )
        self._menu_button(self._t("continue"), y + 116, self._continue_game, False, SAVE_PATH.exists())

        self._text(self._t("difficulty"), self.fonts["tiny"], color("muted"), (67, 418))
        difficulty_buttons = []
        for index, key in enumerate(DIFFICULTIES):
            enabled = key != "ultra" or self.progress.ultra_unlocked
            rect = pygame.Rect(62 + index * 98, 442, 92, 44)
            difficulty_buttons.append(
                Button(
                    rect,
                    self._t(key),
                    lambda value=key: self._set_difficulty(value),
                    self.menu_difficulty == key,
                    enabled=enabled,
                )
            )
        self._add_buttons(difficulty_buttons, mouse)
        progress_note = self._t("ultra_ready" if self.progress.ultra_unlocked else "ultra_locked")
        self._text(
            progress_note,
            self.fonts["tiny"],
            color("legal" if self.progress.ultra_unlocked else "muted"),
            (67, 499),
        )

        self._menu_button(self._t("rules"), 540, self._show_rules)
        self._menu_button(self._t("quit"), 598, self._quit, danger=True)

        self._text(self._t("language"), self.fonts["tiny"], color("muted"), (67, 668))
        language_buttons = [
            Button(
                pygame.Rect(62, 692, 82, 42),
                "EN",
                lambda: self._set_language("en"),
                self.preferences.language == "en",
            ),
            Button(
                pygame.Rect(152, 692, 82, 42),
                "FR",
                lambda: self._set_language("fr"),
                self.preferences.language == "fr",
            ),
            Button(
                pygame.Rect(242, 692, 208, 42),
                self._t("sound_on" if self.audio.enabled else "sound_off"),
                self.audio.toggle,
            ),
        ]
        self._add_buttons(language_buttons, mouse)

        version = self.fonts["tiny"].render("v0.6", True, color("muted"))
        self.canvas.blit(version, (448, 757))

    def _draw_rules(self, mouse: tuple[int, int]) -> None:
        """Render the localized rules reference screen."""
        self.canvas.fill(color("background"))
        pygame.draw.rect(self.canvas, color("panel"), (0, 0, 1280, 800))
        self._text(self._t("how_to_play"), self.fonts["h1"], color("ink"), (76, 58))
        self._text(
            self._t("rules_intro"),
            self.fonts["body"],
            color("blue"),
            (76, 110),
        )

        sections = [
            (self._t("place"), self._t("place_rule")),
            (self._t("fire"), self._t("fire_rule")),
            (self._t("damage"), self._t("damage_rule")),
            (self._t("win"), self._t("win_rule")),
            (self._t("restrictions"), self._t("restrictions_rule")),
            (self._t("paths"), self._t("paths_rule")),
        ]
        for index, (heading, body) in enumerate(sections):
            column = index % 2
            row = index // 2
            x = 76 + column * 586
            y = 180 + row * 150
            self._text(heading, self.fonts["h2"], color("amber"), (x, y))
            self._wrapped_text(body, self.fonts["body"], color("ink"), pygame.Rect(x, y + 38, 500, 88))

        self._add_button(Button(pygame.Rect(76, 708, 180, 48), self._t("back"), self._show_menu), mouse)

    def _draw_game(self, mouse: tuple[int, int]) -> None:
        """Render the board, side panel, and active modal state."""
        self.canvas.fill(color("background"))
        pygame.draw.rect(self.canvas, color("panel"), (732, 0, 548, 800))
        self._draw_board()
        self._draw_side_panel(mouse)
        if self.paused:
            self._draw_pause(mouse)
        elif (self.session.state.winner or self.session.state.draw) and not self.animation:
            self._draw_result(mouse)

    def _draw_board(self) -> None:
        """Render board cells, pieces, legal markers, beams, and particles."""
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
                            (*color("blocked_line")[:3], 120),
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
        """Dispatch one occupied cell to its piece renderer."""
        if cell == Cell.EMPTY:
            return
        if cell in (Cell.MIRROR_SLASH, Cell.MIRROR_BACKSLASH):
            self._draw_mirror(rect, cell)
        elif cell == Cell.SHIELD:
            self._draw_shield(rect)
        elif cell in (Cell.TOP_KING, Cell.BOTTOM_KING):
            self._draw_king(rect, cell == Cell.TOP_KING)

    def _draw_mirror(self, rect: pygame.Rect, mirror: Cell, ghost: bool = False) -> None:
        """Draw a slash-oriented glass mirror inside a cell."""
        margin = 14
        if mirror == Cell.MIRROR_SLASH:
            start, end = (rect.left + margin, rect.bottom - margin), (rect.right - margin, rect.top + margin)
        else:
            start, end = (rect.left + margin, rect.top + margin), (rect.right - margin, rect.bottom - margin)
        alpha = 120 if ghost else 255
        layer = pygame.Surface(rect.size, pygame.SRCALPHA)
        local_start = (start[0] - rect.left, start[1] - rect.top)
        local_end = (end[0] - rect.left, end[1] - rect.top)
        pygame.draw.line(layer, (31, 105, 120, alpha), local_start, local_end, 10)
        pygame.draw.line(layer, (*color("glass")[:3], alpha), local_start, local_end, 5)
        pygame.draw.line(layer, (255, 255, 255, alpha), local_start, local_end, 2)
        self.canvas.blit(layer, rect)

    def _draw_shield(self, rect: pygame.Rect) -> None:
        """Draw a shield token with its glassy inner mark."""
        center = pygame.Vector2(rect.center)
        radius = 23
        points = [center + pygame.Vector2(radius, 0).rotate(index * 45) for index in range(8)]
        pygame.draw.polygon(self.canvas, pygame.Color("#238c82"), points)
        pygame.draw.polygon(self.canvas, pygame.Color("#57c8b7"), points, 4)
        pygame.draw.circle(self.canvas, pygame.Color("#e0fff9"), rect.center, 10, 2)
        pygame.draw.line(
            self.canvas,
            pygame.Color("#b9ece4"),
            (rect.centerx - 8, rect.centery),
            (rect.centerx + 8, rect.centery),
            2,
        )

    def _draw_king(self, rect: pygame.Rect, top: bool) -> None:
        """Draw a color-coded king plate and crown."""
        accent = color("blue" if top else "amber")
        plate = rect.inflate(-18, -18)
        fill = pygame.Color("#176f82") if top else pygame.Color("#a66a10")
        pygame.draw.rect(self.canvas, fill, plate, border_radius=4)
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
        """Draw both laser emitters aligned to the middle row."""
        y = BOARD_RECT.top + MIDDLE_ROW * CELL_SIZE + CELL_SIZE // 2
        for x, beam_color, direction in (
            (BOARD_RECT.left - 40, color("red"), 1),
            (BOARD_RECT.right + 40, color("blue"), -1),
        ):
            housing = pygame.Rect(0, 0, 34, 28)
            housing.center = (x, y)
            pygame.draw.rect(self.canvas, pygame.Color("#11181c"), housing, border_radius=3)
            pygame.draw.rect(self.canvas, pygame.Color("#65737b"), housing, 2, border_radius=3)
            pygame.draw.circle(self.canvas, beam_color, (x, y), 8)
            pygame.draw.circle(self.canvas, pygame.Color("#f1fbff"), (x, y), 4)
            pygame.draw.line(self.canvas, beam_color, (x + direction * 13, y), (x + direction * 30, y), 4)
            pygame.draw.line(
                self.canvas,
                pygame.Color("#65737b"),
                (x - 9, housing.top - 4),
                (x + 9, housing.top - 4),
                3,
            )

    def _draw_coordinates(self) -> None:
        """Draw one-based row and column labels around the board."""
        for index in range(BOARD_SIZE):
            label = self.fonts["tiny"].render(str(index + 1), True, color("muted"))
            x = BOARD_RECT.left + index * CELL_SIZE + CELL_SIZE // 2
            y = BOARD_RECT.top + index * CELL_SIZE + CELL_SIZE // 2
            self.canvas.blit(label, label.get_rect(center=(x, BOARD_RECT.top - 23)))
            self.canvas.blit(label, label.get_rect(center=(BOARD_RECT.left - 24, y)))

    def _draw_beam_animation(self, animation: MoveAnimation) -> None:
        """Draw both beams at their current travel progress."""
        progress = min(
            1.0,
            max(0.0, (animation.elapsed - BEAM_TRAVEL_START_SECONDS) / BEAM_TRAVEL_SECONDS),
        )
        for index, beam in enumerate(animation.record.outcome.beams):
            beam_color = color("red" if index == 0 else "blue")
            self._draw_partial_line(self._beam_points(beam, index), progress, beam_color)

    def _beam_points(self, beam: BeamResult, source_index: int) -> list[tuple[int, int]]:
        """Convert a traced beam into render points that reach the board edge."""
        source_x = BOARD_RECT.left - 40 if source_index == 0 else BOARD_RECT.right + 40
        source_y = BOARD_RECT.top + MIDDLE_ROW * CELL_SIZE + CELL_SIZE // 2
        points = [(source_x, source_y)]
        points.extend(self._cell_rect(row, col).center for row, col, _direction in beam.path)
        if beam.exited and beam.path:
            row, col, direction = beam.path[-1]
            x, y = self._cell_rect(row, col).center
            edge = {
                "N": (x, BOARD_RECT.top),
                "E": (BOARD_RECT.right, y),
                "S": (x, BOARD_RECT.bottom),
                "W": (BOARD_RECT.left, y),
            }
            points.append(edge[direction])
        return points

    def _draw_partial_line(
        self,
        points: list[tuple[int, int]],
        progress: float,
        beam_color: pygame.Color,
    ) -> None:
        """Draw a glowing polyline up to a normalized path progress."""
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
        """Render status, mirror controls, match history, and footer actions."""
        status, status_color = self._status()
        self._text(self._t("match_status"), self.fonts["tiny"], color("muted"), (780, 36))
        pygame.draw.circle(self.canvas, status_color, (789, 82), 6)
        self._text(status, self.fonts["h1"], status_color, (810, 62))
        mode = (
            self._t("versus_computer", difficulty=self._t(self.session.difficulty).upper())
            if self.session.mode == "computer"
            else self._t("local_mode")
        )
        self._text(mode, self.fonts["tiny"], color("muted"), (783, 108))
        pygame.draw.line(self.canvas, pygame.Color("#2b343b"), (780, 135), (1220, 135), 1)

        self._text(self._t("mirror"), self.fonts["tiny"], color("muted"), (783, 157))
        slash = Button(
            pygame.Rect(780, 180, 214, 58),
            "/",
            lambda: self._select(Cell.MIRROR_SLASH),
            self.selected_mirror == Cell.MIRROR_SLASH,
        )
        backslash = Button(
            pygame.Rect(1006, 180, 214, 58),
            "\\",
            lambda: self._select(Cell.MIRROR_BACKSLASH),
            self.selected_mirror == Cell.MIRROR_BACKSLASH,
        )
        self._add_buttons([slash, backslash], mouse)

        pygame.draw.line(self.canvas, pygame.Color("#2b343b"), (780, 260), (1220, 260), 1)
        self._text(self._t("match_log"), self.fonts["tiny"], color("muted"), (783, 284))
        move_count = self._move_count(len(self.session.history))
        count_surface = self.fonts["tiny"].render(move_count, True, color("muted"))
        self.canvas.blit(count_surface, count_surface.get_rect(topright=(1220, 284)))
        if not self.session.history:
            self._text(self._t("empty_log"), self.fonts["body"], color("muted"), (783, 320))
        else:
            y = 318
            for record in self.session.history[-8:]:
                y = (
                    self._wrapped_text(
                        record.summary_for(self.preferences.language),
                        self.fonts["small"],
                        color("ink"),
                        pygame.Rect(783, y, 438, 45),
                    )
                    + 5
                )

        if self.ai_future:
            seconds = monotonic() - self.ai_started
            label = self._t("ultra_search" if self.session.difficulty == "ultra" else "computer_search")
            pygame.draw.circle(self.canvas, color("blue"), (789, 710), 4)
            self._text(
                self._t("search_detail", label=label, seconds=f"{seconds:.1f}"),
                self.fonts["small"],
                color("blue"),
                (803, 699),
            )
        elif self.last_search:
            result = self.last_search
            detail = self._t(
                "ai_detail",
                depth=result.depth,
                nodes=f"{result.nodes:,}",
                seconds=f"{result.elapsed:.2f}",
            )
            self._text(detail, self.fonts["tiny"], color("muted"), (783, 704))

        footer_buttons = [
            Button(pygame.Rect(780, 742, 172, 42), self._t("new_match"), self._restart),
            Button(pygame.Rect(962, 742, 172, 42), self._t("main_menu"), self._return_to_menu),
            Button(pygame.Rect(1144, 742, 76, 42), self._t("sound"), self.audio.toggle, self.audio.enabled),
        ]
        self._add_buttons(footer_buttons, mouse)

    def _draw_pause(self, mouse: tuple[int, int]) -> None:
        """Render the pause overlay and its actions."""
        self._draw_overlay()
        self.buttons = []
        self._text(self._t("paused"), self.fonts["h1"], color("ink"), (548, 230))
        buttons = [
            Button(pygame.Rect(500, 302, 280, 50), self._t("resume"), self._toggle_pause),
            Button(pygame.Rect(500, 366, 280, 50), self._t("restart"), self._restart),
            Button(pygame.Rect(500, 430, 280, 50), self._t("main_menu"), self._return_to_menu),
        ]
        self._add_buttons(buttons, mouse)

    def _draw_result(self, mouse: tuple[int, int]) -> None:
        """Render the terminal result while redrawing the final volley above it."""
        self._draw_overlay()
        if self.final_animation:
            self._draw_beam_animation(self.final_animation)
        self.buttons = []
        if self.session.state.draw:
            heading, accent = self._t("draw"), color("ink")
        else:
            winner = self.session.state.winner or ""
            if self.session.mode == "computer":
                heading = self._t("victory" if winner == "bottom" else "defeat")
            else:
                heading = self._t("side_wins", side=self._t(winner)).upper()
            accent = color("amber" if winner == "bottom" else "blue")
        text = self.fonts["title"].render(heading, True, accent)
        self.canvas.blit(text, text.get_rect(center=(640, 258)))
        if self.ultra_unlocked_this_match:
            detail = self._t("ultra_unlocked")
        else:
            detail = self._t(
                "result_detail",
                difficulty=self._t(self.session.difficulty).upper(),
                count=self._move_count(len(self.session.history)),
            )
        detail_surface = self.fonts["small"].render(detail, True, color("ink"))
        self.canvas.blit(detail_surface, detail_surface.get_rect(center=(640, 324)))
        buttons = [
            Button(pygame.Rect(500, 374, 280, 50), self._t("play_again"), self._restart),
            Button(pygame.Rect(500, 438, 280, 50), self._t("main_menu"), self._return_to_menu),
        ]
        self._add_buttons(buttons, mouse)

    def _draw_overlay(self) -> None:
        """Dim the current game view behind a modal state."""
        overlay = pygame.Surface(DESIGN_SIZE, pygame.SRCALPHA)
        overlay.fill((5, 8, 10, 210))
        self.canvas.blit(overlay, (0, 0))

    def _draw_toast(self) -> None:
        """Render the current transient message at the bottom edge."""
        text = self.fonts["body"].render(self.toast, True, pygame.Color("white"))
        rect = text.get_rect(center=(640, 752)).inflate(32, 20)
        pygame.draw.rect(self.canvas, color("panel_light"), rect, border_radius=6)
        pygame.draw.rect(self.canvas, pygame.Color("#a97b2b"), rect, 1, border_radius=6)
        self.canvas.blit(text, text.get_rect(center=rect.center))

    def _update_particles(self, dt: float) -> None:
        """Advance particles and discard expired effects."""
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
        """Spawn deterministic impact particles at every destroyed shield."""
        for row, col in record.outcome.destroyed:
            center = pygame.Vector2(self._cell_rect(row, col).center)
            for index in range(18):
                angle = index * (360 / 18)
                speed = 55 + (index % 5) * 13
                self.particles.append(
                    Particle(center.copy(), pygame.Vector2(speed, 0).rotate(angle), color("teal"), 0.65, 4)
                )

    def _draw_particles(self) -> None:
        """Draw all live particles with life-based size."""
        for particle in self.particles:
            radius = max(1, int(particle.size * particle.life / 0.65))
            pygame.draw.circle(self.canvas, particle.color, particle.position, radius)

    def _play_human_move(self, cell: tuple[int, int]) -> None:
        """Validate a clicked placement and begin its resolved animation."""
        if (
            not self._human_turn()
            or self.animation
            or self.ai_future
            or self.session.state.winner
            or self.session.state.draw
        ):
            return
        move = Move(*cell, self.selected_mirror)
        if move not in self.legal_moves:
            reason = self.session.game.illegal_move_reason(self.session.state, move)
            key = f"illegal_{reason}" if reason else "illegal_move"
            message = self._t(key)
            self._show_toast(self._t("illegal_move") if message == key else message)
            return
        actor = "you" if self.session.mode == "computer" else self.session.state.turn
        record = self.session.play(move, actor)
        self._begin_animation(record)
        self._autosave()

    def _begin_animation(self, record: TurnRecord) -> None:
        """Start the placement and laser animation for a recorded move."""
        self.final_animation = None
        self.animation = MoveAnimation(record)
        self.audio.play("place")
        self._refresh_legal_moves()

    def _start_ai(self) -> None:
        """Submit a cancellable computer search for the current state."""
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
        """Invalidate any active computer search without blocking the UI."""
        self.ai_cancel.set()
        if self.ai_future:
            self.ai_future.cancel()
            self.ai_future = None
        self.ai_state = None

    def _start_game(self, mode: str) -> None:
        """Create and autosave a fresh match from the menu selection."""
        self.menu_mode = mode
        self.session.new_game(mode=mode, difficulty=self.menu_difficulty)
        self.ultra_unlocked_this_match = False
        self.scene = "game"
        self.paused = False
        self.last_search = None
        self.final_animation = None
        self._refresh_legal_moves()
        self._autosave()

    def _continue_game(self) -> None:
        """Load an autosave, restore terminal visuals, and resume computer play."""
        try:
            self.session = GameSession.load(SAVE_PATH)
        except (OSError, ValueError, KeyError) as exc:
            self._show_toast(self._t("load_failed", error=exc))
            return
        self.menu_mode = self.session.mode
        self.menu_difficulty = self.session.difficulty
        if self.session.difficulty == "ultra" and not self.progress.ultra_unlocked:
            self.progress.ultra_unlocked = True
            try:
                self.progress.save(PROGRESS_PATH)
            except OSError:
                self._show_toast(self._t("progress_failed"))
        self._record_progress()
        self.scene = "game"
        self.paused = False
        self._restore_terminal_animation()
        self._refresh_legal_moves()
        if self._computer_turn():
            self._start_ai()

    def _undo(self) -> None:
        """Undo at most one move and refresh all derived UI state."""
        self._cancel_ai()
        self.animation = None
        self.final_animation = None
        if self.session.undo():
            self.audio.play("undo")
            self.last_search = None
            self._refresh_legal_moves()
            self._autosave()

    def _redo(self) -> None:
        """Redo at most one still-valid move and resume computer play if needed."""
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
        """Archive the current match and reset it with the same settings."""
        self._cancel_ai()
        self._archive_match("abandoned")
        self.session.new_game()
        self.ultra_unlocked_this_match = False
        self.animation = None
        self.final_animation = None
        self.particles.clear()
        self.paused = False
        self.last_search = None
        self._refresh_legal_moves()
        self._autosave()

    def _return_to_menu(self) -> None:
        """Archive the current match and return to the main menu."""
        self._cancel_ai()
        self._archive_match("abandoned")
        self.animation = None
        self.final_animation = None
        self.paused = False
        self.scene = "menu"

    def _autosave(self) -> None:
        """Persist resumable state and the current match record."""
        try:
            self.session.save(SAVE_PATH)
            self.session.save_match_log(MATCH_LOG_DIRECTORY)
        except OSError:
            self._show_toast(self._t("autosave_failed"))

    def _archive_match(self, status: str) -> None:
        """Write the latest match state with an archive status."""
        try:
            self.session.save_match_log(MATCH_LOG_DIRECTORY, status)
        except OSError:
            self._show_toast(self._t("log_storage_failed"))

    def _refresh_legal_moves(self) -> None:
        self.legal_moves = set(self.session.game.legal_moves(self.session.state))

    def _restore_terminal_animation(self) -> None:
        """Reconstruct a completed volley when loading a terminal save."""
        self.final_animation = None
        if (self.session.state.winner or self.session.state.draw) and self.session.history:
            self.final_animation = MoveAnimation(
                self.session.history[-1],
                elapsed=MOVE_ANIMATION_SECONDS,
                damage_played=True,
            )

    def _human_turn(self) -> bool:
        return self.session.mode == "local" or self.session.state.turn == "bottom"

    def _computer_turn(self) -> bool:
        """Return whether an unfinished computer match awaits the top side."""
        state = self.session.state
        return self.session.mode == "computer" and state.turn == "top" and not state.winner and not state.draw

    def _status(self) -> tuple[str, pygame.Color]:
        """Return localized status text and the active-side accent color."""
        state = self.session.state
        if state.winner:
            return (
                self._t("side_wins", side=self._t(state.winner)),
                color("amber" if state.winner == "bottom" else "blue"),
            )
        if state.draw:
            return self._t("draw"), color("ink")
        if self.ai_future:
            return self._t("computer_thinking"), color("blue")
        if self.session.mode == "computer":
            return self._t("your_turn"), color("amber")
        return (
            self._t("side_to_move", side=self._t(state.turn)),
            color("amber" if state.turn == "bottom" else "blue"),
        )

    def _cell_at(self, position: tuple[int, int]) -> tuple[int, int] | None:
        """Map a canvas position to a board cell when it is in bounds."""
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
        """Select an available computer difficulty or explain its lock."""
        if difficulty == "ultra" and not self.progress.ultra_unlocked:
            self._show_toast(self._t("unlock_instruction"))
            return
        self.menu_difficulty = difficulty

    def _set_language(self, language: str) -> None:
        """Apply and persist the selected interface language."""
        self.preferences.set_language(language)
        try:
            self.preferences.save(PREFERENCES_PATH)
        except OSError:
            self._show_toast(self._t("progress_failed"))

    def _record_progress(self) -> None:
        """Record a qualifying result and persist any new unlock."""
        progress = getattr(self, "progress", None)
        if progress is None:
            return
        unlocked = progress.record_result(
            mode=self.session.mode,
            difficulty=self.session.difficulty,
            winner=self.session.state.winner,
        )
        if not unlocked:
            return
        self.ultra_unlocked_this_match = True
        try:
            progress.save(PROGRESS_PATH)
        except OSError:
            self._show_toast(self._t("progress_failed"))

    def _show_rules(self) -> None:
        self.scene = "rules"

    def _show_menu(self) -> None:
        self.scene = "menu"

    def _toggle_pause(self) -> None:
        self.paused = not self.paused

    def _t(self, key: str, **values: object) -> str:
        """Translate a UI key using the active preference."""
        preferences = getattr(self, "preferences", None)
        language = preferences.language if preferences else "en"
        return translate(language, key, **values)

    def _move_count(self, count: int) -> str:
        return f"{count} {self._t('move' if count == 1 else 'moves')}"

    def _show_toast(self, message: str) -> None:
        """Display a transient message for the standard toast duration."""
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
        """Create and draw one full-width main-menu button."""
        self.buttons.append(Button(pygame.Rect(62, y, 388, 48), label, action, selected, enabled, danger))
        self.buttons[-1].draw(self.canvas, self.fonts["body"], self._virtual_mouse())

    def _add_button(self, button: Button, mouse: tuple[int, int]) -> None:
        """Register and draw one interactive button."""
        self.buttons.append(button)
        button.draw(self.canvas, self.fonts["body"], mouse)

    def _add_buttons(self, buttons: list[Button], mouse: tuple[int, int]) -> None:
        """Register and draw a sequence of interactive buttons."""
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
        """Wrap text into a rectangle and return the next vertical position."""
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

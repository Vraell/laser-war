# Laser War Rules

This is a formal reconstruction of the school game described in the referenced conversation.

## Board

- The game is played on a 9 by 9 square board.
- Two lasers sit outside the board, aligned with the center row.
- The left laser starts outside row 5, column 0 in 1-based board terms and fires east.
- The right laser starts outside row 5, column 10 in 1-based board terms and fires west.
- The lasers are not board pieces.
- The squares directly in front of the lasers cannot contain mirrors:
  - row 5, column 1;
  - row 5, column 9.

In engine coordinates, those no-mirror squares are `(4, 0)` and `(4, 8)`.

## Starting Position

Each player has one king and six protection blocks.

Top formation:

```text
. . . O k O . . .
. . . O O O . . .
. . . . O . . . .
```

Bottom formation:

```text
. . . . O . . . .
. . . O O O . . .
. . . O K O . . .
```

Full starting board:

```text
. . . O k O . . .
. . . O O O . . .
. . . . O . . . .
. . . . . . . . .
. . . . . . . . .
. . . . . . . . .
. . . . O . . . .
. . . O O O . . .
. . . O K O . . .
```

`K` is the bottom king. `k` is the top king. `O` is a protection block.

## Turn

On your turn, place exactly one mirror on an empty board square that:

- is not a no-mirror laser-entry square;
- is not horizontally, vertically, or diagonally adjacent to either king.

The king-adjacency restriction remains in force after a protection block is destroyed. A mirror cannot replace a destroyed block next to a king.

A mirror has one of two diagonal orientations:

- `/`
- `\`

Mirrors are permanent and indestructible.

After the mirror is placed, both lasers fire.

## Laser Movement

A laser travels in a straight line until something changes or stops it.

If a laser enters:

- an empty square, it continues straight;
- a `/` mirror, it reflects by 90 degrees;
- a `\` mirror, it reflects by 90 degrees;
- a protection block, that block is destroyed and the beam stops;
- a king, that king is hit;
- a previously visited `(square, direction)` state, the beam is considered to be in a loop and stops;
- the outside of the board, it exits and stops.

The two lasers are resolved from the same board position. If both lasers hit protection blocks, both blocks are removed.

## Winning

If your move causes the opponent's king to be hit and your own king is not hit, you win.

If your move causes your own king to be hit and the opponent's king is not hit, you lose.

If both kings are hit on the same turn, the engine records the result as a draw. This can be changed if the original game used a different convention.

## Anti-Fortress Rule

After a move is applied and laser damage is resolved:

- at least one laser must still have a possible path to each king;
- each laser must still have a possible path to at least one king.

A player cannot make either king permanently unreachable or leave either laser permanently stranded.
This validation applies to every move, including a volley that hits one or both kings.

For this reconstruction:

- existing mirrors are fixed and must reflect beams normally;
- kings are target squares;
- protection blocks are ignored for this reachability test because they are temporary;
- empty squares count as possible future routing squares.
- forbidden laser-entry and king-adjacent squares can be crossed by a beam, but cannot be treated as possible future mirror turns.

That means a move is illegal if it completely seals either king away from both side lasers, or if one side laser
can no longer possibly reach either king.

## No Legal Move

If a player has no legal mirror placement and has not already lost, the result is a draw.

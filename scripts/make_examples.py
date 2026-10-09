"""Make the example puzzles in puzzles/ and their pictures in docs/img/examples/.

    python3 scripts/make_examples.py

Every picture here is drawn (or computed) for this repository, so the puzzles are free to
include. Each puzzle is written in Hugi's plain format, and each SVG shows the clues and the
picture. Python standard library only.
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HEART = """
...............
..###.....###..
.#####...#####.
#######.#######
###############
###############
###############
.#############.
..###########..
...#########...
....#######....
.....#####.....
......###......
.......#.......
...............
"""

SMILE = """
..######..
.########.
##########
##..##..##
##..##..##
##########
#.######.#
##......##
.########.
..######..
"""

HOUSE = """
.......#.......
......###......
.....#####.....
....#######....
...#########...
..###########..
.#############.
###############
.#############.
.##..#####..##.
.##..#####..##.
.#############.
.#####...#####.
.#####...#####.
.#####...#####.
"""

HUGI = """
#...#.#...#..####.###
#...#.#...#.#......#.
#...#.#...#.#......#.
#####.#...#.#..##..#.
#...#.#...#.#...#..#.
#...#.#...#.#...#..#.
#...#..###...####.###
""".replace(".#.\n", ".#.\n")


def rings(n=31):
    c = (n - 1) / 2
    return "\n".join("".join("#" if int(((x - c) ** 2 + (y - c) ** 2) ** 0.5) % 4 < 2 else "." for x in range(n)) for y in range(n))


def sierpinski(n=32):
    return "\n".join("".join("#" if x & y == 0 else "." for x in range(n)) for y in range(n))


PUZZLES = {
    "smile": ("A smiley, 10×10", SMILE),
    "heart": ("A heart, 15×15", HEART),
    "house": ("A house, 15×15", HOUSE),
    "hugi": ("The name, 21×7", HUGI),
    "rings": ("Rings, 31×31 (computed)", rings()),
    "sierpinski": ("Sierpinski's triangle, 32×32 (computed)", sierpinski()),
}


def clues(lines):
    out = []
    for l in lines:
        runs, n = [], 0
        for ch in l + ".":
            if ch == "#":
                n += 1
            elif n:
                runs.append(n)
                n = 0
        out.append(runs or [0])
    return out


def grid(text):
    g = [l for l in text.strip("\n").split("\n")]
    assert len({len(l) for l in g}) == 1, "ragged picture"
    return g


def write_puzzle(name, title, g):
    rows = clues(g)
    cols = clues(["".join(g[r][c] for r in range(len(g))) for c in range(len(g[0]))])
    path = os.path.join(ROOT, "puzzles", name + ".txt")
    with open(path, "w") as f:
        f.write(f"# {title}. Drawn for this repository.\nrows\n")
        f.write("\n".join(" ".join(map(str, r)) for r in rows))
        f.write("\ncols\n")
        f.write("\n".join(" ".join(map(str, c)) for c in cols) + "\n")
    return rows, cols


def svg(rows, cols, g, cell=14, solved=True):
    h, w = len(rows), len(cols)
    rmax, cmax = max(len(r) for r in rows), max(len(c) for c in cols)
    fs = max(8, cell - 3)
    left, top = rmax * (fs + 1) + 10, cmax * (fs + 3) + 8
    W, H = left + w * cell + 2, top + h * cell + 2
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="sans-serif" font-size="{fs}">',
         f'<rect width="{W}" height="{H}" fill="#fff"/>']
    if solved:
        for r in range(h):
            for c in range(w):
                if g[r][c] == "#":
                    o.append(f'<rect x="{left + c * cell}" y="{top + r * cell}" width="{cell}" height="{cell}" fill="#1d1d1b"/>')
    for i in range(w + 1):
        o.append(f'<line x1="{left + i * cell}" y1="{top}" x2="{left + i * cell}" y2="{top + h * cell}" stroke="{"#444" if i % 5 == 0 else "#ccc"}" stroke-width="{1.2 if i % 5 == 0 else 0.6}"/>')
    for i in range(h + 1):
        o.append(f'<line x1="{left}" y1="{top + i * cell}" x2="{left + w * cell}" y2="{top + i * cell}" stroke="{"#444" if i % 5 == 0 else "#ccc"}" stroke-width="{1.2 if i % 5 == 0 else 0.6}"/>')
    for r, clue in enumerate(rows):
        for k, v in enumerate(reversed(clue)):
            o.append(f'<text x="{left - 5 - k * (fs + 1)}" y="{top + r * cell + cell / 2 + fs / 3}" text-anchor="end" fill="#333">{v}</text>')
    for c, clue in enumerate(cols):
        for k, v in enumerate(reversed(clue)):
            o.append(f'<text x="{left + c * cell + cell / 2}" y="{top - 4 - k * (fs + 3)}" text-anchor="middle" fill="#333">{v}</text>')
    o.append("</svg>")
    return "\n".join(o)


if __name__ == "__main__":
    os.makedirs(os.path.join(ROOT, "docs", "img", "examples"), exist_ok=True)
    for name, (title, pic) in PUZZLES.items():
        g = grid(pic)
        rows, cols = write_puzzle(name, title, g)
        cell = 14 if len(g) <= 21 else 10
        if name != "smile":  # the smiley has its own, larger figures below
            with open(os.path.join(ROOT, "docs", "img", "examples", name + ".svg"), "w") as f:
                f.write(svg(rows, cols, g, cell))
        print(f"{name:12} {len(g[0])}x{len(g)}")
    # The figure for the explanation: the smiley's clues, empty, next to the solved picture.
    g = grid(SMILE)
    rows, cols = clues(g), clues(["".join(g[r][c] for r in range(len(g))) for c in range(len(g[0]))])
    with open(os.path.join(ROOT, "docs", "img", "examples", "smile-unsolved.svg"), "w") as f:
        f.write(svg(rows, cols, g, 22, solved=False))
    with open(os.path.join(ROOT, "docs", "img", "examples", "smile-solved.svg"), "w") as f:
        f.write(svg(rows, cols, g, 22, solved=True))

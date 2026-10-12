"""Build web/pack.json: the puzzle pack of Hugi's Play mode (docs/game-design.md section 3).

    nix shell --impure --expr '(builtins.getFlake "nixpkgs").legacyPackages.x86_64-linux.python3.withPackages (p: [p.pillow])' \
        --command python3 scripts/make_pack.py [--sheet] [--first-hour]

    (no flag)     rasterise, rate, select, write web/pack.json
    --sheet       also write target/pack-cache/sheet.png, a contact sheet of every picture in the pack
    --icons N     write target/pack-cache/icons-N-<page>.png: every curated icon at N cells, for curation
    --first-hour  only write target/pack-cache/sheet.png for 60 curated icons at 15, 20 and 30 cells,
                  with their tier when ./target/release/hugi can rate; writes no pack

Needs Pillow and, for the rating, ./target/release/hugi with the `rate` subcommand. The font and its
name list are fetched at a pinned commit and checked against their sha256. The output has no
timestamps and uses sorted keys, so the same inputs give the same bytes.
"""
import base64
import hashlib
import json
import os
import subprocess
import sys
import urllib.request

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "target", "pack-cache")
HUGI = os.environ.get("HUGI_BIN") or os.path.join(ROOT, "target", "release", "hugi")
PACK = os.path.join(ROOT, "web", "pack.json")

COMMIT = "49d4db35df873165d6bd6ba09b063c7dafbac2f4"
SOURCES = {
    "MaterialIcons-Regular.ttf": "ef149f08bdd2ff09a4e2c8573476b7b0f3fbb15b623954ade59899e7175bedda",
    "MaterialIcons-Regular.codepoints": "530f25bf7b2d71c8e1da9476d53f9a9bb6b7e187bff69bb7128bb679b8194894",
}
URL = "https://raw.githubusercontent.com/google/material-design-icons/%s/font/%s"

SIZES = [10, 15, 20, 25, 30, 40, 50]
CREDITS = ("Pictures of 10×10 and larger are made from Material Icons by Google (Apache License 2.0). "
           "The others are drawn for Hugi.")
TIERS = [
    ("tabby", "Tabby", "Small pictures, one line at a time.", 0),
    ("twill", "Twill", "15×15, still line by line.", 20),
    ("satin", "Satin", "20×20, with a few cells to try both ways.", 20),
    ("brocade", "Brocade", "Bigger pictures and some tricky ones.", 20),
    ("tapestry", "Tapestry", "Up to 50×50. Best on a large screen.", 20),
]
NOTES = [
    "Each number is a run of filled cells, in order.",
    "Two runs in one line always have at least one empty cell between them.",
    "Start with the biggest numbers: a long run has little room to move.",
]
# The repository pictures: (id source name in make_examples, display name, thread)
REPO = {"smile": ("Smile", 3), "heart": ("Heart", 2), "house": ("House", 5), "hugi": ("Hugi", 5),
        "sierpinski": ("Sierpinski", 4)}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


def fetch_sources():
    os.makedirs(CACHE, exist_ok=True)
    for name, want in SOURCES.items():
        path = os.path.join(CACHE, name)
        if not os.path.exists(path) or sha256(path) != want:
            with urllib.request.urlopen(URL % (COMMIT, name), timeout=60) as r, open(path, "wb") as f:
                f.write(r.read())
        got = sha256(path)
        if got != want:
            sys.exit(f"STOP: sha256 of {name} is {got}, expected {want}")
    codes = {}
    with open(os.path.join(CACHE, "MaterialIcons-Regular.codepoints")) as f:
        for line in f:
            n, cp = line.split()
            codes[n] = int(cp, 16)
    return os.path.join(CACHE, "MaterialIcons-Regular.ttf"), codes


# ---------------------------------------------------------------- rasterising

_ink_cache = {}


def glyph_ink(font, ch):
    """The glyph at 960 px, cropped to the ink and centred in a square: an 'L' image."""
    if ch in _ink_cache:
        return _ink_cache[ch]
    canvas = Image.new("L", (1500, 1500), 0)
    ImageDraw.Draw(canvas).text((200, 200), ch, font=font, fill=255)
    box = canvas.point(lambda v: 255 if v > 0 else 0).getbbox()
    if box is None:
        _ink_cache[ch] = None
        return None
    ink = canvas.crop(box)
    side = max(ink.size)
    sq = Image.new("L", (side, side), 0)
    sq.paste(ink, ((side - ink.size[0]) // 2, (side - ink.size[1]) // 2))
    _ink_cache[ch] = sq
    return sq


def raster(sq, n):
    """Area average to n x n; a cell is filled when at least half ink. Rows of '#' and '.'."""
    small = sq.resize((n, n), Image.BOX)
    px = small.load()
    return ["".join("#" if px[x, y] >= 128 else "." for x in range(n)) for y in range(n)]


def fill_ratio(rows):
    n = sum(r.count("#") for r in rows)
    return n / (len(rows) * len(rows[0]))


def specks(rows):
    """Filled cells with no filled neighbour on the four sides: noise from thin strokes."""
    h, w = len(rows), len(rows[0])
    k = 0
    for y in range(h):
        for x in range(w):
            if rows[y][x] == "#" and not any(
                    0 <= y + dy < h and 0 <= x + dx < w and rows[y + dy][x + dx] == "#"
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                k += 1
    return k


def keep_render(rows):
    n = len(rows)
    return 0.2 <= fill_ratio(rows) <= 0.8 and specks(rows) <= n // 10


# ---------------------------------------------------------------- inputs

def load_icons():
    out = []
    with open(os.path.join(ROOT, "scripts", "pack", "icons.tsv")) as f:
        for line in f:
            line = line.rstrip("\n")
            if line and not line.startswith("#"):
                icon, name, thread = line.split("\t")
                out.append((icon, name, int(thread)))
    return out


def load_tabby():
    with open(os.path.join(ROOT, "scripts", "pack", "tabby.txt")) as f:
        return {l.strip() for l in f if l.strip() and not l.startswith("#")}


def load_small():
    out = []
    with open(os.path.join(ROOT, "scripts", "pack", "small.txt")) as f:
        text = f.read()
    for block in text.strip().split("\n\n"):
        lines = [l for l in block.split("\n")]
        while lines and lines[0].startswith("#") and "|" not in lines[0]:
            lines.pop(0)  # a comment line, such as the file header
        if not lines:
            continue
        head, rows = lines[0], lines[1:]
        name, thread = [s.strip() for s in head[1:].split("|")]
        assert len(rows) == 5 and all(len(r) == 5 for r in rows), name
        out.append((name, int(thread), rows))
    return out


def load_repo():
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    import make_examples  # the data of the repository pictures

    sys.path.pop(0)
    out = []
    for key, (name, thread) in REPO.items():
        _title, text = make_examples.PUZZLES[key]
        rows = [l for l in text.strip("\n").split("\n")]
        out.append((key, name, thread, rows))
    return out


def slug(name):
    s = "".join(c.lower() if c.isalnum() else "-" for c in name)
    return "-".join(p for p in s.split("-") if p)


# ---------------------------------------------------------------- rating

def hugi_can_rate():
    if not os.path.exists(HUGI):
        return False
    r = subprocess.run([HUGI, "rate", "-"], input="..#..\n.###.\n#####\n", capture_output=True, text=True)
    try:
        return r.returncode == 0 and json.loads(r.stdout.strip().split("\n")[0]).get("tier") == "tabby"
    except (ValueError, IndexError):
        return False


def rate(pictures):
    """One rating dict per picture (rows of '#' and '.'), from `hugi rate -`."""
    text = "\n\n".join("\n".join(p) for p in pictures) + "\n"
    r = subprocess.run([HUGI, "rate", "-"], input=text, capture_output=True, text=True, check=True)
    lines = [l for l in r.stdout.split("\n") if l.strip()]
    if len(lines) != len(pictures):
        sys.exit(f"STOP: hugi rate gave {len(lines)} lines for {len(pictures)} pictures")
    return [json.loads(l) for l in lines]


# ---------------------------------------------------------------- selection

def spread(pool, k):
    """k picks evenly spaced over a list sorted by effort."""
    pool = sorted(pool, key=lambda c: (c["rating"]["effort"], c["icon"], c["n"]))
    if len(pool) < k:
        sys.exit(f"STOP: only {len(pool)} candidates for {k} slots")
    if k == 1:
        return [pool[len(pool) // 2]]
    idx = []
    for i in range(k):
        j = round(i * (len(pool) - 1) / (k - 1))
        while j in idx:
            j += 1
        idx.append(j)
    return [pool[j] for j in idx]


def pick(cands, used, tier, sizes, k, prefer):
    """k picks of tier `tier` from candidates of the given sizes, an icon at most once, never one in `used`."""
    best = {}
    for c in cands:
        if c["tier"] != tier or c["n"] not in sizes or c["icon"] in used:
            continue
        old = best.get(c["icon"])
        if old is None or abs(c["n"] - prefer) < abs(old["n"] - prefer):
            best[c["icon"]] = c
    got = spread(list(best.values()), k)
    used.update(c["icon"] for c in got)
    return got


def bits_of(rows):
    h, w = len(rows), len(rows[0])
    b = bytearray((w * h + 7) // 8)
    for i in range(w * h):
        if rows[i // w][i % w] == "#":
            b[i >> 3] |= 1 << (i & 7)
    return base64.urlsafe_b64encode(bytes(b)).decode().rstrip("=")


def entry(c, daily=False):
    r = c["rating"]
    e = {
        "id": ("d-" if daily else "") + slug(c["name"]) + "-" + str(c["n"]),
        "name": c["name"],
        "w": c["w"], "h": c["h"],
        "bits": bits_of(c["rows"]),
        "thread": c["thread"],
        "tier": c["tier"],
        "rating": {k: r[k] for k in ("moves", "probes", "max_steps", "sum_steps", "effort")},
    }
    return e


def build_pack(ttf, codes):
    font = ImageFont.truetype(ttf, 960)
    cands = []
    tabby = load_tabby()
    for icon, name, thread in load_icons():
        sq = glyph_ink(font, chr(codes[icon]))
        if sq is None:
            continue
        for n in SIZES:
            if n == 10 and icon not in tabby:
                continue  # most icons are noise at 10x10; tabby.txt lists the ones that read
            rows = raster(sq, n)
            if keep_render(rows):
                cands.append({"icon": icon, "name": name, "thread": thread, "n": n, "w": n, "h": n, "rows": rows})
    fixed = []
    for name, thread, rows in load_small():
        fixed.append({"icon": "small:" + name, "name": name, "thread": thread, "n": 5, "w": 5, "h": 5, "rows": rows})
    for key, name, thread, rows in load_repo():
        fixed.append({"icon": "repo:" + key, "name": name, "thread": thread, "n": max(len(rows), len(rows[0])),
                      "w": len(rows[0]), "h": len(rows), "rows": rows})
    allc = fixed + cands
    ratings = rate([c["rows"] for c in allc])
    for c, r in zip(allc, ratings):
        assert (r["w"], r["h"]) == (c["w"], c["h"])
        c["rating"], c["tier"] = r, r.get("tier")
    cands = [c for c in cands if c["tier"] is not None and not c["rating"]["search"]]
    for c in fixed:
        assert c["tier"] is not None, f"{c['name']} needs a guess"

    def fx(prefix):
        return [c for c in fixed if c["icon"].startswith(prefix)]

    small = fx("small:")
    repo = {c["icon"]: c for c in fx("repo:")}
    for key, want in (("smile", "tabby"), ("heart", "twill"), ("house", "twill"),
                      ("hugi", "brocade"), ("sierpinski", "tapestry")):
        assert repo["repo:" + key]["tier"] == want, (key, repo["repo:" + key]["tier"])
    assert all(c["tier"] == "tabby" for c in small)

    used = set()
    camp = {t[0]: [] for t in TIERS}
    camp["tabby"] = small + [repo["repo:smile"]] + pick(cands, used, "tabby", [10], 17, 10)
    camp["twill"] = [repo["repo:heart"], repo["repo:house"]] + pick(cands, used, "twill", [15], 28, 15)
    camp["satin"] = pick(cands, used, "satin", [10, 15, 20], 30, 20)
    camp["brocade"] = ([repo["repo:hugi"]] + pick(cands, used, "brocade", [30], 9, 30)
                       + pick(cands, used, "brocade", [10, 15, 20, 25], 20, 25))
    camp["tapestry"] = ([repo["repo:sierpinski"]] + pick(cands, used, "tapestry", [40], 19, 40)
                        + pick(cands, used, "tapestry", [50], 10, 50))
    for t, lst in camp.items():
        assert len(lst) == 30, (t, len(lst))
    # the daily pool: 15 Twill (15x15), 20 Satin (20x20) and 25 Brocade (25x25), no icon from the campaign
    daily = (pick(cands, used, "twill", [15], 15, 15) + pick(cands, used, "satin", [15, 20], 20, 20)
             + pick(cands, used, "brocade", [20, 25], 25, 25))

    puzzles = []
    for t, _n, _b, _o in TIERS:
        for c in sorted(camp[t], key=lambda c: (c["rating"]["effort"], c["name"])):
            puzzles.append(c)
    # the three first small pictures carry the coach notes: the cheapest three of Tabby
    ents = [entry(c) for c in puzzles]
    firsts = sorted((e for e in ents if e["w"] == 5), key=lambda e: (e["rating"]["effort"], e["id"]))[:3]
    for e, note in zip(firsts, NOTES):
        e["note"] = note
    dents = [entry(c, True) for c in sorted(daily, key=lambda c: (c["rating"]["effort"], c["name"]))]
    ids = [e["id"] for e in ents + dents]
    assert len(set(ids)) == len(ids), "duplicate ids"
    names = [e["name"] for e in ents + dents]
    assert len(set(names)) == len(names), "duplicate names: " + ", ".join(sorted(n for n in names if names.count(n) > 1))
    pack = {
        "version": 1,
        "credits": CREDITS,
        "tiers": [{"id": i, "name": n, "blurb": b, "opens": o} for i, n, b, o in TIERS],
        "puzzles": ents,
        "daily": dents,
    }
    return pack, puzzles, sorted(daily, key=lambda c: (c["rating"]["effort"], c["name"]))


def write_pack(pack):
    def line(o):
        return json.dumps(o, sort_keys=True, ensure_ascii=False, separators=(",", ":"))

    out = ["{", f'"credits":{line(pack["credits"])},', '"daily":[']
    out.append(",\n".join(line(e) for e in pack["daily"]))
    out.append("],")
    out.append('"puzzles":[')
    out.append(",\n".join(line(e) for e in pack["puzzles"]))
    out.append("],")
    out.append(f'"tiers":{line(pack["tiers"])},')
    out.append('"version":1')
    out.append("}")
    with open(PACK, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")


# ---------------------------------------------------------------- contact sheet

def sheet(items, path, cols, box=110):
    """items: dicts with rows, label, sub. One picture per tile."""
    font = ImageFont.load_default(11)
    small = ImageFont.load_default(10)
    th, tw = box + 34, box + 12
    nrows = (len(items) + cols - 1) // cols
    img = Image.new("RGB", (cols * tw + 6, nrows * th + 6), "#f4efe4")
    d = ImageDraw.Draw(img)
    for k, it in enumerate(items):
        x0, y0 = 6 + (k % cols) * tw, 6 + (k // cols) * th
        rows = it["rows"]
        h, w = len(rows), len(rows[0])
        cell = box / max(w, h)
        ox, oy = x0 + (box - w * cell) / 2, y0 + (box - h * cell) / 2
        d.rectangle([x0, y0, x0 + box, y0 + box], outline="#cfc6b2")
        for y in range(h):
            for x in range(w):
                if rows[y][x] == "#":
                    d.rectangle([ox + x * cell, oy + y * cell, ox + (x + 1) * cell - 0.01, oy + (y + 1) * cell - 0.01],
                                fill="#2b2a28")
        d.text((x0, y0 + box + 2), it["label"][:22], fill="#111", font=font)
        d.text((x0, y0 + box + 15), it["sub"], fill="#666", font=small)
    img.save(path)


def first_hour(ttf, codes):
    icons = load_icons()
    chosen = icons[::max(1, len(icons) // 60)][:60]
    font = ImageFont.truetype(ttf, 960)
    items = []
    for icon, name, thread in chosen:
        sq = glyph_ink(font, chr(codes[icon]))
        for n in (15, 20, 30):
            rows = raster(sq, n)
            items.append({"rows": rows, "label": name, "sub": f"{n}x{n} {int(fill_ratio(rows) * 100)}%"
                          + ("" if keep_render(rows) else " DROP"), "n": n})
    if hugi_can_rate():
        for it, r in zip(items, rate([i["rows"] for i in items])):
            it["sub"] += f" {r['tier']} p{r['probes']}"
    # one row of three per icon, five icons per sheet row
    sheet(items, os.path.join(CACHE, "sheet.png"), cols=15)
    print("wrote", os.path.join(CACHE, "sheet.png"), len(items), "renders")


def icon_pages(ttf, codes, n):
    font = ImageFont.truetype(ttf, 960)
    items = []
    for icon, name, thread in load_icons():
        rows = raster(glyph_ink(font, chr(codes[icon])), n)
        items.append({"rows": rows, "label": name, "sub": f"{icon[:20]} {int(fill_ratio(rows) * 100)}%"
                      + ("" if keep_render(rows) else " DROP")})
    for k in range(0, len(items), 96):
        path = os.path.join(CACHE, f"icons-{n}-{k // 96}.png")
        sheet(items[k:k + 96], path, cols=16, box=100)
        print("wrote", path)


def main():
    args = sys.argv[1:]
    ttf, codes = fetch_sources()
    missing = [i for i, _n, _t in load_icons() if i not in codes]
    if missing:
        sys.exit("STOP: not in the codepoints file: " + ", ".join(missing))
    if "--icons" in args:
        return icon_pages(ttf, codes, int(args[args.index("--icons") + 1]))
    if "--first-hour" in args:
        return first_hour(ttf, codes)
    if not hugi_can_rate():
        sys.exit("STOP: ./target/release/hugi has no working `rate -` yet (WP1). Nothing written.")
    pack, camp, daily = build_pack(ttf, codes)
    write_pack(pack)
    if "--sheet" in args:
        items = []
        for c in camp:
            items.append({"rows": c["rows"], "label": c["name"], "sub": f"{c['w']}x{c['h']} {c['tier']} e{c['rating']['effort']}"})
        sheet(items, os.path.join(CACHE, "sheet.png"), cols=14)
        items = [{"rows": c["rows"], "label": c["name"], "sub": f"D {c['w']}x{c['h']} {c['tier']} e{c['rating']['effort']}"} for c in daily]
        sheet(items, os.path.join(CACHE, "sheet-daily.png"), cols=14)
    counts = {t: sum(1 for e in pack["puzzles"] if e["tier"] == t) for t, *_ in TIERS}
    print("wrote", PACK, os.path.getsize(PACK), "bytes;", counts, "daily", len(pack["daily"]))


if __name__ == "__main__":
    main()

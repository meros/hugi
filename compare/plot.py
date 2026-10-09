"""Charts for the README from the committed comparison data.

    python3 compare/plot.py   (needs matplotlib) -> docs/img/cactus.svg, docs/img/hard.svg

Ours: the median of interleaved runs where `data/final-ours-2026-10-09-release.txt` has
it (the hard puzzles), else one run (`results-2026-10-09-final-ours.tsv`). Rivals:
one run each (`results-2026-10-08.tsv`, `sat-2026-10-08.tsv`, then
`sat-lean-2026-10-09.tsv` for kissat and CaDiCaL on the nine hard puzzles,
`results-2026-10-09-grid-copris.tsv` for Copris, `results-2026-10-09-grid.tsv`
for grid). Timeouts (60 s) are drawn at the limit and marked, never as a
time.
"""
import collections, re
import matplotlib
matplotlib.use("svg")
import matplotlib.pyplot as plt

LIMIT = 60.0
t = collections.defaultdict(dict)

def load(path, keep=None):
    for line in open(path):
        p = line.rstrip("\n").split("\t")
        if p[0] == "puzzle" or len(p) < 4:
            continue
        name, solver, secs, res = p[:4]
        if keep and solver not in keep:
            continue
        t[name][solver] = float(secs) if secs else None

load("compare/data/results-2026-10-08.tsv", {"naughty", "pbnsolve", "nonogrid"})
load("compare/data/sat-2026-10-08.tsv")
# kissat and CaDiCaL on Hugi's lean encoding (`hugi cnf` since 2026-10-09), which
# they solve faster than the older one: the better rival numbers replace the old
# ones for the nine hard survey puzzles.
load("compare/data/sat-lean-2026-10-09.tsv")
load("compare/data/results-2026-10-09-grid-copris.tsv", {"copris"})
load("compare/data/results-2026-10-09-grid.tsv")
load("compare/data/results-2026-10-09-final-ours.tsv", {"ours-8"})
for line in open("compare/data/final-ours-2026-10-09-release.txt"):
    m = re.match(r"(\S+)\s+(\d+) \[", line)
    if m:
        t[m.group(1)]["ours-8"] = int(m.group(2)) / 1000

solvers = [("ours-8", "Hugi (8 cores)"), ("kissat", "kissat 4.0.4 (lean CNF)"), ("cadical", "CaDiCaL 3.0.1 (lean CNF)"),
           ("copris", "Copris + kissat"), ("nonogrid", "nonogrid 0.7.3"), ("naughty", "Naughty v88"),
           ("pbnsolve", "pbnsolve 1.10"), ("grid", "grid 1.2 (Olšák)")]
puzzles = sorted(t)

# Cactus plot: for each solver, how many puzzles finish within x seconds.
fig, ax = plt.subplots(figsize=(7, 4.2))
for key, label in solvers:
    times = sorted(v for p in puzzles if (v := t[p].get(key)) is not None and v < LIMIT)
    ax.step([0] + times, range(len(times) + 1), where="post", label=f"{label}: {len(times)}/{len(puzzles)}",
            linewidth=2.4 if key == "ours-8" else 1.2)
ax.set_xscale("log")
ax.set_xlim(1e-3, LIMIT)
ax.set_xlabel("time limit (s, log scale)")
ax.set_ylabel("survey puzzles solved, uniqueness checked")
ax.set_title("webpbn survey set (28 puzzles), Core Ultra 7 258V")
ax.legend(fontsize=7, loc="lower right")
ax.grid(alpha=0.3)
fig.tight_layout()
fig.savefig("docs/img/cactus.svg")

# The hard puzzles, per solver, log scale; timeouts hatched at the limit.
hard = ["02712-lion", "06574-forever", "08098-9-dom", "09892-nature", "10088-marley", "12548-sierp", "18297-thing", "22336-gettys"]
fig, ax = plt.subplots(figsize=(8, 4.2))
wid = 0.8 / len(solvers)
for i, (key, label) in enumerate(solvers):
    for j, p in enumerate(hard):
        v = t[p].get(key, "missing")
        if v == "missing":
            continue
        x = j + (i - len(solvers) / 2 + 0.5) * wid
        if v is None or v >= LIMIT:
            ax.bar(x, LIMIT, wid, color=f"C{i}", alpha=0.25, hatch="///", edgecolor=f"C{i}")
        else:
            ax.bar(x, v, wid, color=f"C{i}")
ax.set_yscale("log")
ax.set_ylim(5e-3, LIMIT * 1.5)
ax.set_xticks(range(len(hard)), [p.split("-", 1)[1] for p in hard])
ax.set_ylabel("seconds (log scale); hatched: > 60 s")
ax.set_title("Hard survey puzzles")
# One legend entry per solver, also for those whose first puzzle timed out.
from matplotlib.patches import Patch
ax.legend(handles=[Patch(color=f"C{i}", label=label) for i, (_, label) in enumerate(solvers)], fontsize=7, ncol=2)
ax.grid(axis="y", alpha=0.3)
fig.tight_layout()
fig.savefig("docs/img/hard.svg")
print("wrote docs/img/cactus.svg docs/img/hard.svg")

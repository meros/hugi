"""Run an external SAT solver on a nonogram, with a uniqueness check.

    python3 compare/sat.py SOLVER PUZZLE [--limit SECONDS]

SOLVER is `kissat` or `cadical` on PATH. The puzzle is encoded with
`hugi cnf` (encoding time not counted, the same as the rival solvers'
input parsing is not separated either: it is reported apart). The solver
runs once; if it finds a solution, a clause forbidding that solution's cells
is added and it runs again. "unique" means the second run is UNSAT. The
time is the sum of both runs. Prints: seconds<TAB>result.
"""
import subprocess, sys, tempfile, time, os

solver, puzzle = sys.argv[1], sys.argv[2]
limit = float(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else 60.0
binary = os.environ.get("HUGI_BIN", "./target/release/hugi")

cnf = subprocess.run([binary, "cnf", puzzle], capture_output=True, text=True, check=True).stdout
header = cnf.split("\n", 1)[0].split()
nvars, nclauses = int(header[2]), int(header[3])

# Cells are variables 1..h*w; count them from the clue file.
rows = cols = 0
cur = None
first = open(puzzle).readline().split()
if len(first) == 2 and all(x.isdigit() for x in first):  # webpbn .nin: "width height"
    cols, rows = int(first[0]), int(first[1])
for l in ([] if rows else open(puzzle)):
    l = l.split("#")[0].strip()
    if l == "rows":
        cur = "r"; continue
    if l in ("cols", "columns"):
        cur = "c"; continue
    if l and cur == "r":
        rows += 1
    elif l and cur == "c":
        cols += 1
cells = rows * cols


def run(text, budget):
    with tempfile.NamedTemporaryFile("w", suffix=".cnf", delete=False) as f:
        f.write(text)
        path = f.name
    t = time.perf_counter()
    try:
        p = subprocess.run(["taskset", "-c", "1", solver, path], capture_output=True, text=True, timeout=budget)
    except subprocess.TimeoutExpired:
        os.unlink(path)
        return None, None, None
    dt = time.perf_counter() - t
    os.unlink(path)
    model = []
    status = None
    for line in p.stdout.splitlines():
        if line.startswith("s "):
            status = line[2:].strip()
        elif line.startswith("v "):
            model.extend(int(x) for x in line[2:].split())
    return dt, status, model


t1, s1, model = run(cnf, limit)
if t1 is None:
    print(f"\ttimeout"); sys.exit()
if s1 != "SATISFIABLE":
    print(f"{t1:.3f}\tnone"); sys.exit()
block = " ".join(str(-v) for v in model if v != 0 and abs(v) <= cells) + " 0\n"
body = cnf.split("\n", 1)[1]
cnf2 = f"p cnf {nvars} {nclauses + 1}\n" + body + block
t2, s2, _ = run(cnf2, max(0.1, limit - t1))
if t2 is None:
    print(f"\ttimeout"); sys.exit()
print(f"{t1 + t2:.3f}\t{'unique' if s2 == 'UNSATISFIABLE' else 'multiple'}")

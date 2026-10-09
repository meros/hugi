"""Time rival nonogram solvers and ours on the same puzzles, same machine.

    python3 compare/run.py RIVALS_DIR [--limit 60] > compare/data/results.tsv

RIVALS_DIR holds the built rival binaries (naughty31, naughty63, pbnsolve-bin,
nonogrid-bin, grid-bin, copris-puzzles-2.0.jar) and the puzzles as
xml/<name>.xml, non/<name>.non, g/<name>.g and cwd/<name>.cwd. Copris needs
`scala` (2.12) on PATH and KISSAT pointing at a kissat binary. Every
solver checks uniqueness. Single-threaded solvers are pinned to CPU 1 (a
performance core); our multi-threaded run gets CPUs 0-7. The time is wall
clock for the whole process, start-up included, the same for every solver.
"""
import argparse, glob, os, re, subprocess, time

ap = argparse.ArgumentParser()
ap.add_argument("rivals")
ap.add_argument("--limit", type=float, default=60)
ap.add_argument("--only", default="")
ap.add_argument("--solvers", default="", help="comma-separated subset of solver names")
a = ap.parse_args()
R = a.rivals
XML_LIB = os.environ.get("XML_LIB", "")

def dims(path):
    first = open(path).readline().split()
    if len(first) == 2 and all(x.isdigit() for x in first):  # webpbn .nin: "width height"
        return int(first[0]), int(first[1])
    rows = cols = 0; cur = None
    for l in open(path):
        l = l.split("#")[0].strip()
        if l == "rows": cur = "r"; continue
        if l in ("cols", "columns"): cur = "c"; continue
        if l and cur == "r": rows += 1
        elif l and cur == "c": cols += 1
    return cols, rows

def run(cmd, cpus, stdin=None, env=None):
    t = time.perf_counter()
    try:
        p = subprocess.run(["taskset", "-c", cpus] + cmd, stdin=stdin, capture_output=True,
                           text=True, timeout=a.limit, env=env)
        return time.perf_counter() - t, p.stdout + p.stderr
    except subprocess.TimeoutExpired:
        return None, ""

def verdict(out, unique_re, multi_re):
    if re.search(multi_re, out): return "multiple"
    if re.search(unique_re, out): return "unique"
    return "?"

puzzles = sorted(glob.glob("puzzles/webpbn/*.nin"))
if a.only:
    puzzles = [p for p in puzzles if any(o in p for o in a.only.split(","))]
print("puzzle\tsolver\tseconds\tresult", flush=True)
for path in puzzles:
    name = os.path.splitext(os.path.basename(path))[0]
    w, h = dims(path)
    solvers = [
        ("ours-8", ["./target/release/hugi", path], "0-7", None, None, r"unique solution", r"NOT unique"),
        ("ours-1", ["./target/release/hugi", path, "--threads", "1"], "1", None, None, r"unique solution", r"NOT unique"),
    ]
    if max(w, h) <= 63:
        nb = "naughty31" if max(w, h) <= 31 else "naughty63"
        solvers.append(("naughty", [f"{R}/{nb}", "-u"], "1", f"{R}/non/{name}.non", None, r"UNIQUE SOLUTION", r"FOUND MULTIPLE SOLUTIONS"))
    env = dict(os.environ, LD_LIBRARY_PATH=XML_LIB)
    solvers.append(("pbnsolve", [f"{R}/pbnsolve-bin", "-u", "-t", f"{R}/xml/{name}.xml"], "1", None, env, r"UNIQUE SOLUTION", r"FOUND MULTIPLE SOLUTIONS"))
    solvers.append(("nonogrid", [f"{R}/nonogrid-bin", "-m", "2", f"{R}/xml/{name}.xml"], "1", None, None, r"", r"found 2 solutions"))
    # Olšák's grid stops after two solutions with -total 2 (exit 1).
    solvers.append(("grid", [f"{R}/grid-bin", "-total", "2", "-xpm", "0", "-log", "1", "-out", "0", f"{R}/g/{name}.g"], "1", None, None,
                    r"number of solutions is 1", r"-total 2 reached"))
    # Copris (Scala) with kissat as its SAT backend, its fastest setup here.
    solvers.append(("copris", ["scala", "-J-Xmx4g", "-cp", f"{R}/copris-puzzles-2.0.jar", "nonogram.Solver", "-s1", os.environ.get("KISSAT", "kissat"),
                    f"{R}/cwd/{name}.cwd"], "1", None, None, r"Unique solution", r"Multiple solutions"))
    if a.solvers:
        solvers = [x for x in solvers if x[0] in a.solvers.split(",")]
    for sname, cmd, cpus, stdin_path, env, ure, mre in solvers:
        stdin = open(stdin_path) if stdin_path else None
        secs, out = run(cmd, cpus, stdin, env)
        res = "timeout" if secs is None else verdict(out, ure, mre)
        print(f"{name}\t{sname}\t{'' if secs is None else f'{secs:.3f}'}\t{res}", flush=True)

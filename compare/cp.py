"""Run a constraint or answer-set solver on a nonogram, with a uniqueness check.

    python3 compare/cp.py SOLVER PUZZLE [--limit SECONDS]

SOLVER is one of
  chuffed-pos, gecode-pos  the same two with a start-position model instead of `regular`
  chuffed  MiniZinc with Chuffed (lazy clause generation), one `regular` constraint per line,
           free search (-f: the solver's own branching with restarts and activity)
  gecode   MiniZinc with Gecode (propagation and search), the same model, free search
  cpsat    OR-tools CP-SAT with 8 workers, one automaton constraint per line
  cpsat1   the same with 1 worker
  clingo   clingo (answer-set programming), one thread, block-start encoding

The puzzle is read in Hugi's format, webpbn's .nin or Simpson's .non. The solver runs once; if it
finds a solution, a constraint that forbids that solution is added and it runs again. "unique"
means the second run has no solution. Prints: seconds<TAB>result<TAB>wall seconds, where seconds is
the solver's own time summed over both runs (model building, flattening and process start-up not
counted, the same as `sat.py` leaves out the encoding) and wall is the whole process.
Needs minizinc, ortools and clingo. Chuffed's own solver configuration (chuffed.msc) must be on
MZN_SOLVER_PATH; the one the NixOS package installs has relative paths that do not resolve, so
copy it and make "executable" and "mznlib" absolute.
"""
import os, re, subprocess, sys, tempfile, time


def read_clues(path):
    text = open(path).read()
    head = text.split(None, 2)[:2]
    nums = lambda s: [int(x) for x in re.split(r"[ ,]+", s.strip()) if x and int(x) > 0]
    if "rows" not in text and len(head) == 2 and all(x.isdigit() for x in head):  # webpbn .nin
        w, h = int(head[0]), int(head[1])
        body = text.splitlines()[1:1 + h + w]
        body += [""] * (h + w - len(body))
        return [nums(l) for l in body[:h]], [nums(l) for l in body[h:]]
    rows, cols, cur = [], [], None
    for raw in text.splitlines():
        l = raw.split("#")[0].strip()
        if not l:
            continue
        if l == "rows":
            cur = rows
        elif l in ("cols", "columns"):
            cur = cols
        elif l[0].isalpha():
            cur = None  # .non header and trailer lines
        elif cur is not None:
            cur.append(nums(l))
    return rows, cols


def dfa(clue):
    """States 1..Q, delta[q] = (on empty, on filled), 0 = no move; returns (delta, finals)."""
    if not clue:
        return [(1, 0)], [1]
    ids, nxt = {}, 1
    for j, l in enumerate(clue):
        for t in range(1, l + 1):
            nxt += 1
            ids[("b", j, t)] = nxt
    for j in range(len(clue) - 1):
        nxt += 1
        ids[("g", j)] = nxt
    nxt += 1
    end = nxt
    delta = {1: (1, ids[("b", 0, 1)])}
    k = len(clue)
    for j, l in enumerate(clue):
        for t in range(1, l + 1):
            q = ids[("b", j, t)]
            if t < l:
                delta[q] = (0, ids[("b", j, t + 1)])
            else:
                delta[q] = (ids[("g", j)] if j < k - 1 else end, 0)
        if j < k - 1:
            delta[ids[("g", j)]] = (ids[("g", j)], ids[("b", j + 1, 1)])
    delta[end] = (end, 0)
    return [delta[q] for q in range(1, nxt + 1)], [ids[("b", k - 1, clue[-1])], end]


def minizinc(solver, rows, cols, limit, kind):
    h, w = len(rows), len(cols)

    def model_pos(forbid):
        """Block start positions as integer variables; a cell is filled iff some block covers it."""
        out = [f"array[1..{h},1..{w}] of var bool: c;"]
        for name, lines, n, cell in (("r", rows, w, lambda i, j: f"c[{i},{j}]"), ("c", cols, h, lambda i, j: f"c[{j},{i}]")):
            for i, clue in enumerate(lines, 1):
                k = len(clue)
                if k == 0:
                    out += [f"constraint not {cell(i, j)};" for j in range(1, n + 1)]
                    continue
                lo, acc = [], 1
                for l in clue:
                    lo.append(acc)
                    acc += l + 1
                hi, acc = [0] * k, n + 1
                for j in range(k - 1, -1, -1):
                    hi[j] = acc - clue[j]
                    acc = hi[j] - 1
                out.append(f"array[1..{k}] of var int: s_{name}{i};")
                for j in range(k):
                    out.append(f"constraint s_{name}{i}[{j + 1}] in {lo[j]}..{hi[j]};")
                    if j + 1 < k:
                        out.append(f"constraint s_{name}{i}[{j + 2}] >= s_{name}{i}[{j + 1}] + {clue[j] + 1};")
                for j in range(1, n + 1):
                    cover = " \\/ ".join(f"(s_{name}{i}[{b + 1}] <= {j} /\\ s_{name}{i}[{b + 1}] >= {j - clue[b] + 1})"
                                         for b in range(k) if lo[b] <= j <= hi[b] + clue[b] - 1)
                    out.append(f"constraint {cell(i, j)} <-> ({cover or 'false'});")
        if forbid:
            sol = ",".join(map(str, forbid))
            out.append(f"constraint exists(i in 1..{h}, j in 1..{w})(bool2int(c[i,j]) != array2d(1..{h}, 1..{w}, [{sol}])[i,j]);")
        out.append(f"output [show([bool2int(c[i,j]) | i in 1..{h}, j in 1..{w}])];")
        return "\n".join(out)

    def model(forbid):
        if kind == "pos":
            return model_pos(forbid)
        out = [f'include "globals.mzn";', f"array[1..{h},1..{w}] of var 1..2: c;"]
        for name, lines, n, cell in (("r", rows, w, lambda i, j: f"c[{i},{j}]"), ("c", cols, h, lambda i, j: f"c[{j},{i}]")):
            for i, clue in enumerate(lines, 1):
                delta, finals = dfa(clue)
                d = ",".join(f"{a},{b}" for a, b in delta)
                xs = ",".join(cell(i, j) for j in range(1, n + 1))
                out.append(f"constraint regular([{xs}], {len(delta)}, 2, array2d(1..{len(delta)}, 1..2, [{d}]), 1, {{{','.join(map(str, finals))}}});")
        if forbid:
            sol = ",".join(str(v + 1) for v in forbid)
            out.append(f"constraint exists(i in 1..{h}, j in 1..{w})(c[i,j] != array2d(1..{h}, 1..{w}, [{sol}])[i,j]);")
        out.append(f"output [show([c[i,j] - 1 | i in 1..{h}, j in 1..{w}])];")
        return "\n".join(out)

    def run(forbid, budget):
        with tempfile.NamedTemporaryFile("w", suffix=".mzn", delete=False) as f:
            f.write(model(forbid))
        try:
            p = subprocess.run(["minizinc", "--solver", solver, "-f", "--statistics", "-t", str(int(budget * 1000)), f.name],
                               capture_output=True, text=True, timeout=budget + 30)
        except subprocess.TimeoutExpired:
            return None, None, None
        finally:
            os.unlink(f.name)
        t = sum(float(x) for x in re.findall(r"solveTime=([0-9.e+-]+)", p.stdout))
        m = re.search(r"^\[([0-9, ]+)\]", p.stdout, re.M)
        if m:
            return t, [int(x) for x in m.group(1).split(",")], True
        if "UNSATISFIABLE" in p.stdout:
            return t, None, False
        return None, None, None  # unknown: time limit or error

    t1, sol, ok = run(None, limit)
    if ok is None:
        return None, "timeout"
    if not ok:
        return t1, "none"
    t2, _, ok2 = run(sol, max(1.0, limit - t1))
    if ok2 is None:
        return None, "timeout"
    return t1 + t2, "multiple" if ok2 else "unique"


def cpsat(rows, cols, limit, workers):
    from ortools.sat.python import cp_model

    h, w = len(rows), len(cols)
    m = cp_model.CpModel()
    x = [[m.NewBoolVar(f"x{i}_{j}") for j in range(w)] for i in range(h)]
    for lines, cells in ((rows, lambda i: x[i]), (cols, lambda j: [x[i][j] for i in range(h)])):
        for k, clue in enumerate(lines):
            delta, finals = dfa(clue)
            triples = []
            for q, (e, f) in enumerate(delta, 1):
                if e:
                    triples.append((q, 0, e))
                if f:
                    triples.append((q, 1, f))
            m.AddAutomaton(cells(k), 1, finals, triples)
    s = cp_model.CpSolver()
    s.parameters.num_workers = workers
    s.parameters.max_time_in_seconds = limit
    st = s.Solve(m)
    t1 = s.WallTime()
    if st == cp_model.INFEASIBLE:
        return t1, "none"
    if st not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None, "timeout"
    sol = [[s.Value(x[i][j]) for j in range(w)] for i in range(h)]
    m.AddBoolOr([x[i][j].Not() if sol[i][j] else x[i][j] for i in range(h) for j in range(w)])
    s.parameters.max_time_in_seconds = max(1.0, limit - t1)
    st = s.Solve(m)
    t2 = s.WallTime()
    if st == cp_model.INFEASIBLE:
        return t1 + t2, "unique"
    if st in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return t1 + t2, "multiple"
    return None, "timeout"


def clingo(rows, cols, limit):
    h, w = len(rows), len(cols)
    lp = [f"#const h={h}. #const w={w}."]
    for name, lines, n in (("row", rows, w), ("col", cols, h)):
        for i, clue in enumerate(lines, 1):
            for j, l in enumerate(clue, 1):
                lo = sum(c + 1 for c in clue[:j - 1]) + 1
                hi = n - sum(c + 1 for c in clue[j:]) - l + 1
                lp.append(f"blk({name}({i}),{j},{l},{lo},{hi}).")
    lp += [
        "1 { s(L,J,P) : P=Lo..Hi } 1 :- blk(L,J,_,Lo,Hi).",
        ":- blk(L,J,Len,_,_), blk(L,J+1,_,_,_), s(L,J,P), s(L,J+1,Q), Q < P+Len+1.",
        "fill(L,I) :- s(L,J,P), blk(L,J,Len,_,_), I=P..P+Len-1.",
        "{ cell(R,C) } :- R=1..h, C=1..w.",
        ":- cell(R,C), not fill(row(R),C).",
        ":- fill(row(R),C), not cell(R,C).",
        ":- cell(R,C), not fill(col(C),R).",
        ":- fill(col(C),R), not cell(R,C).",
        "#show cell/2.",
    ]
    with tempfile.NamedTemporaryFile("w", suffix=".lp", delete=False) as f:
        f.write("\n".join(lp))
    try:
        p = subprocess.run(["clingo", "-n", "2", f"--time-limit={int(limit)}", "--stats=0", f.name], capture_output=True, text=True,
                           timeout=limit + 60)
    except subprocess.TimeoutExpired:
        return None, "timeout"
    finally:
        os.unlink(f.name)
    m = re.search(r"Time\s*:\s*([0-9.]+)s \(Solving: ([0-9.]+)s", p.stdout)
    models = re.search(r"Models\s*:\s*(\d+)(\+?)", p.stdout)
    if not m or not models:
        return None, "timeout"
    t = float(m.group(2))
    n = int(models.group(1))
    if n >= 2:
        return t, "multiple"
    # One model or none counts only when the search finished: a "+" after the model count, or a
    # status other than SATISFIABLE / UNSATISFIABLE, means the time limit stopped it.
    done = models.group(2) != "+" and re.search(r"^(SATISFIABLE|UNSATISFIABLE)$", p.stdout, re.M)
    if not done:
        return None, "timeout"
    return t, "unique" if n == 1 else "none"


if __name__ == "__main__":
    solver, puzzle = sys.argv[1], sys.argv[2]
    limit = float(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else 60.0
    rows, cols = read_clues(puzzle)
    wall = time.perf_counter()
    if solver.split("-")[0] in ("chuffed", "gecode"):
        t, res = minizinc(solver.split("-")[0], rows, cols, limit, "pos" if solver.endswith("-pos") else "regular")
    elif solver in ("cpsat", "cpsat1"):
        t, res = cpsat(rows, cols, limit, 8 if solver == "cpsat" else 1)
    elif solver == "clingo":
        t, res = clingo(rows, cols, limit)
    else:
        sys.exit(f"unknown solver {solver}")
    print(f"{'' if t is None else f'{t:.3f}'}\t{res}\t{time.perf_counter() - wall:.3f}")

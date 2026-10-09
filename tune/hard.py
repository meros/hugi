"""Compare configurations on hard puzzles by distribution, not best run.

    python3 tune/hard.py --runs 15 --limit 60 \
        --puzzles 09892-nature,18297-thing,12548-sierp \
        --config 'base:' --config 'pin0:NONO_PIN=0'

The parallel search is nondeterministic: which thread finds the second
solution, and when, varies from run to run (Nature ranged 33-258 ms best of
3 under one configuration). So each configuration runs each puzzle `--runs`
times, interleaved round-robin with the other configurations to spread
thermal and turbo drift evenly, and the report gives median and the 10th and
90th percentiles per puzzle, plus the geometric mean of the medians.
A timeout counts as twice the limit (PAR-2).
"""
import argparse, math, os, statistics, subprocess, time

ap = argparse.ArgumentParser()
ap.add_argument("--runs", type=int, default=15)
ap.add_argument("--limit", type=float, default=60)
ap.add_argument("--cpus", default="0-7")
ap.add_argument("--puzzles", required=True)
ap.add_argument("--config", action="append", required=True, help="name:VAR=val VAR=val")
ap.add_argument("--bin", default="./target/release/hugi")
a = ap.parse_args()

configs = []
for c in a.config:
    name, _, env = c.partition(":")
    configs.append((name, dict(kv.split("=", 1) for kv in env.split())))
puzzles = a.puzzles.split(",")
times = {(c, p): [] for c, _ in configs for p in puzzles}

for r in range(a.runs):
    for p in puzzles:
        for name, env in configs:
            path = f"puzzles/webpbn/{p}.nin" if os.path.exists(f"puzzles/webpbn/{p}.nin") else p
            t = time.perf_counter()
            try:
                # A BIN=path entry in a configuration runs that binary instead.
                binary = env.get("BIN", a.bin)
                subprocess.run(["taskset", "-c", a.cpus, binary, path], env=dict(os.environ, **{k: v for k, v in env.items() if k != "BIN"}),
                               capture_output=True, timeout=a.limit, check=True)
                dt = time.perf_counter() - t
            except subprocess.TimeoutExpired:
                dt = 2 * a.limit
            times[(name, p)].append(dt * 1000)

def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))]

print(f"{'puzzle':22s}" + "".join(f"{n:>26s}" for n, _ in configs))
for p in puzzles:
    row = f"{os.path.basename(p)[:22]:22s}"
    for n, _ in configs:
        xs = times[(n, p)]
        row += f"{statistics.median(xs):10.0f} [{pct(xs, .1):5.0f}-{pct(xs, .9):6.0f}]"
    print(row)
print(f"{'geomean of medians':22s}" + "".join(
    f"{math.exp(sum(math.log(statistics.median(times[(n, p)])) for p in puzzles) / len(puzzles)):26.1f}"
    for n, _ in configs))

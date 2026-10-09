"""A/B of the learning solver alone, one thread per run, on a conflict budget.

    python3 tune/cdcl_ab.py LIST BUDGET "CONFIG A" "CONFIG B" ...
    INSTR=1 python3 tune/cdcl_ab.py LIST GINSTR "CONFIG A" ...

With INSTR=1 the budget is in billions of retired instructions (counted
with perf on the performance cores), the fair measure when configurations
differ in the cost of a conflict; it is as independent of load as the
conflict count.

A config is a list of NAME=VALUE environment settings ("X=0" for the
default); BIN=path in a config picks another binary. Runs `hugi <puzzle>
--cdcl` for every puzzle and config, interleaved, four at a time on the
performance cores 0-3, with NONO_MAX_CONFLICTS=BUDGET. A single-thread run
is deterministic, so solved/unsolved and the conflict counts do not depend
on machine load. Single puzzles are chaotic (a change in which explanations
get built changes later ones), so compare totals over many puzzles. Time is
printed too, but is only meaningful on a quiet machine.
"""
import os, re, subprocess, sys, time, math
from concurrent.futures import ThreadPoolExecutor
import queue

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INSTR = os.environ.get("INSTR") == "1"
lst, budget, configs = sys.argv[1], (float(sys.argv[2]) if INSTR else int(sys.argv[2])), sys.argv[3:]
puzzles = [l.split()[0] for l in open(lst) if l.strip() and not l.startswith("#")]
cores = queue.Queue()
for c in (0, 1, 2, 3):
    cores.put(c)


def run(job):
    pz, ci = job
    env = dict(os.environ) if INSTR else dict(os.environ, NONO_MAX_CONFLICTS=str(budget))
    binary = os.path.join(ROOT, "target", "release", "hugi")
    for kv in configs[ci].split():
        k, v = kv.split("=", 1)
        if k == "BIN":
            binary = v
        else:
            env[k] = v
    core = cores.get()
    try:
        t = time.perf_counter()
        cmd = ["taskset", "-c", str(core), binary, pz, "--cdcl"]
        if INSTR:
            cmd = ["taskset", "-c", str(core), "perf", "stat", "-x,", "-e", "cpu_core/instructions/u",
                   "--", "timeout", "--signal=INT", "600", binary, pz, "--cdcl"]
            env["NONO_MAX_CONFLICTS"] = "250000"  # bounds the run time; solved means within the budget
        p = subprocess.run(cmd, env=env, capture_output=True, text=True)
        secs, out = time.perf_counter() - t, p.stdout
        if INSTR:
            m = re.search(r"^(\d+),", p.stderr, re.M)
            secs = int(m.group(1)) / 1e9 if m else float("nan")  # billions of instructions
            if secs > budget:
                return pz, ci, secs, None, None
    finally:
        cores.put(core)
    m = re.search(r"cdcl: (\d+) conflicts", out)
    confl = int(m.group(1)) if m else budget
    if "timed out" in out:
        return pz, ci, secs, None, None
    verdict = "multiple" if "NOT unique" in out else "unique" if "unique" in out else "none"
    return pz, ci, secs, confl, verdict


jobs = [(pz, ci) for pz in puzzles for ci in range(len(configs))]
res, verdicts = {}, {}
with ThreadPoolExecutor(4) as ex:
    for pz, ci, secs, confl, verdict in ex.map(run, jobs):
        res[pz, ci] = (secs, confl)
        if verdict and verdicts.setdefault(pz, verdict) != verdict:
            print(f"VERDICTS DIFFER on {pz}: {verdicts[pz]} vs {verdict} (config {ci})", flush=True)
        if all((pz, k) in res for k in range(len(configs))):
            cells = "  ".join(f"{c:>8} {t:6.2f}s" if c else f"{'--':>8} {'':>7}" for t, c in (res[pz, k] for k in range(len(configs))))
            print(f"{os.path.basename(pz):24} {cells}", flush=True)

print()
both = [pz for pz in puzzles if all(res[pz, k][1] for k in range(len(configs)))]
for ci, cfg in enumerate(configs):
    solved = sum(1 for pz in puzzles if res[pz, ci][1])
    if INSTR:
        par2i = sum(res[pz, ci][0] if res[pz, ci][1] else 2 * budget for pz in puzzles)
        gi = math.exp(sum(math.log(res[pz, ci][0]) for pz in both) / max(1, len(both)))
        print(f"{cfg[-60:]:60} solved {sum(1 for pz in puzzles if res[pz, ci][1])}/{len(puzzles)}  par2 {par2i:8.0f} Ginstr  geomean {gi:6.2f} Ginstr on {len(both)}")
        continue
    par2 = sum(res[pz, ci][1] or 2 * budget for pz in puzzles)
    gc = math.exp(sum(math.log(max(1, res[pz, ci][1])) for pz in both) / max(1, len(both)))
    secs = sum(res[pz, ci][0] for pz in puzzles)
    confl = sum(res[pz, ci][1] or budget for pz in puzzles)
    print(f"{cfg[-60:]:60} solved {solved}/{len(puzzles)}  par2 {par2 / 1e3:8.0f}k conflicts  geomean {gc:7.0f} on {len(both)}  ({secs:6.0f} s, {secs / confl * 1e6:5.0f} us/conflict)")

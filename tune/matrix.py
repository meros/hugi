"""A long tuning run: find the best balance of Hugi's learning-solver parameters and its portfolio.

    nix shell nixpkgs#perf nixpkgs#python3 --command \
        python3 tune/matrix.py run --dir matrix-runs/1 --hours 24
    python3 tune/matrix.py report --dir matrix-runs/1

The machine must be otherwise idle: the portfolio runs use all 8 cores and the script waits
while another job is using more than about one core. The run can be stopped and started again
with the same --dir; every measurement is appended to runs.jsonl and nothing is measured twice.

Stages (a share of the hours each):
  2  learning-solver parameters, one strategy at a time (28 %). Deterministic: the cost of a
     puzzle is the number of instructions one thread retires (perf), so the result does not
     depend on load or clocks. Random search, then coordinate descent from the best, on
     generated tuning puzzles, then a check on other puzzles that were never used for a choice.
  1  portfolio (50 %). Thread counts, which strategies run, retirement, fact sharing, probing
     options, cache size. Random configurations are screened on a few puzzles, the best go
     to a larger set with repeats, the best of those to puzzles never used before.
  3  final comparison (15 %): the current defaults against the stage 2 result and the best
     portfolio, on every puzzle with repeats, and on Knotty and Faase.

The score of a configuration is the geometric mean over puzzles of (time + 10 ms) / (the
reference's time + 10 ms), a timeout counting as twice its limit; below 1 is better than the
reference. Wall time of the whole process for portfolio runs, instructions for stage 2.
Output: REPORT.md, best.json (the recommended settings), runs.jsonl, log.txt.
"""
import argparse, zlib, hashlib, json, math, os, random, re, statistics, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
import queue

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# name, kind, width, height, density %, tuning puzzles, validation puzzles, time limit (s)
SETS = [
    ("r45", "gen", 45, 45, 50, 16, 16, 30),
    ("r50", "gen", 50, 50, 50, 16, 16, 30),
    ("r60", "gen", 60, 60, 50, 10, 10, 30),
    ("d40lo", "gen", 40, 40, 35, 8, 8, 30),
    ("d40hi", "gen", 40, 40, 65, 8, 8, 30),
    ("d50lo", "gen", 50, 50, 40, 8, 8, 30),
    ("d50hi", "gen", 50, 50, 60, 8, 8, 30),
    ("r30", "gen", 30, 30, 50, 20, 20, 10),
    ("pic", "pic", 0, 0, 0, 24, 24, 30),
]
SURVEY = ["02712-lion", "06574-forever", "08098-9-dom", "09892-nature", "10088-marley", "10810-center", "12548-sierp",
          "18297-thing", "22336-gettys"]
SURVEY_LIMIT = 60
WEIGHTS = {"survey": 3.0, "r45": 1.0, "r50": 2.0, "r60": 2.0, "d40lo": 1.0, "d40hi": 1.0, "d50lo": 1.0, "d50hi": 1.0,
           "r30": 1.0, "pic": 1.0}

# Stage 2: parameter -> values; the first value is the current default for the strategy where it differs.
SPACE_S1 = {
    "NONO_DECAY": [0.85, 0.8, 0.9, 0.95],
    "NONO_VIVIFY": [200, 0, 100, 400],
    "NONO_VIVIFY_EVERY": [2000, 1000, 4000],
    "NONO_RESTART_UNIT": [100, 25, 50, 200, 400],
    "NONO_SHRINK": [1, 0],
    "NONO_POISON": [3, 1, 2],
    "NONO_GLUCOSE": [0, 1],
    "NONO_TIERS": [0, 1],
    "NONO_REASON_BUMP": [0, 10],
    "NONO_REDUCE_FIRST": [2000, 1000, 4000],
    "NONO_REDUCE_INC": [300, 150, 600],
    "NONO_KEEP_LBD": [2, 3, 4],
}
SPACE_S0 = {
    "NONO_DECAY": [0.95, 0.9, 0.97],
    "NONO_RESTART_UNIT": [100, 50, 200, 400],
    "NONO_TARGET": [1, 0],
    "NONO_MODES": [0, 1],
    "NONO_REPHASE": [0, 1],
    "NONO_GLUCOSE": [0, 1],
    "NONO_POISON": [1, 2, 3],
    "NONO_SHRINK": [0, 1],
    "NONO_VIVIFY": [0, 100, 200, 400],
    "NONO_TIERS": [0, 1],
    "NONO_REDUCE_FIRST": [2000, 1000, 4000],
    "NONO_KEEP_LBD": [2, 3, 4],
}
STAGE2_BUDGET_G = {1: 60, 0: 100}  # giga-instructions per puzzle; more counts as unsolved


def now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


class Matrix:
    def __init__(self, a):
        self.dir = os.path.abspath(a.dir)
        os.makedirs(self.dir, exist_ok=True)
        self.start = time.time()
        meta = os.path.join(self.dir, "meta.json")
        if os.path.exists(meta):
            self.start = json.load(open(meta))["start"]
        else:
            json.dump({"start": self.start, "hours": a.hours}, open(meta, "w"))
        self.hours = a.hours
        self.smoke = a.smoke
        self.binary = os.path.join(self.dir, "hugi")
        if not os.path.exists(self.binary):
            subprocess.run(["cp", a.binary or os.path.join(ROOT, "target", "release", "hugi"), self.binary], check=True)
        self.rng = random.Random(20261010)
        self.runs_path = os.path.join(self.dir, "runs.jsonl")
        self.done = {}
        if os.path.exists(self.runs_path):
            for line in open(self.runs_path):
                r = json.loads(line)
                self.done[r["key"]] = r
        self.runs = open(self.runs_path, "a")
        self.logf = open(os.path.join(self.dir, "log.txt"), "a")
        self.puzzles = {}
        self.stage_end = {}

    # ── plumbing ───────────────────────────────────────────────────────────
    def log(self, msg):
        line = f"[{now()}] {msg}"
        print(line, flush=True)
        self.logf.write(line + "\n")
        self.logf.flush()

    def status(self, text):
        open(os.path.join(self.dir, "STATUS"), "w").write(f"{now()}  elapsed {(time.time() - self.start) / 3600:.2f} h of {self.hours}\n{text}\n")

    def remaining(self):
        return self.start + self.hours * 3600 - time.time()

    def record(self, key, **fields):
        r = {"key": key, "t": time.time(), **fields}
        self.done[key] = r
        self.runs.write(json.dumps(r) + "\n")
        self.runs.flush()
        return r

    def save(self, name, obj):
        json.dump(obj, open(os.path.join(self.dir, name), "w"), indent=1)

    def load(self, name, default=None):
        p = os.path.join(self.dir, name)
        return json.load(open(p)) if os.path.exists(p) else default

    # ── puzzles ────────────────────────────────────────────────────────────
    def make_puzzles(self):
        pdir = os.path.join(self.dir, "puzzles")
        os.makedirs(pdir, exist_ok=True)
        shrink = 3 if self.smoke else 1
        for name, kind, w, h, dens, ntune, nval, limit in SETS:
            for role, count, base in (("tune", ntune, 100000), ("val", nval, 200000)):
                for i in range(max(1, count // shrink) if self.smoke else count):
                    seed = base + 1000 * SETS.index((name, kind, w, h, dens, ntune, nval, limit)) + i
                    path = os.path.join(pdir, f"{name}-{role}-{i}.txt")
                    if not os.path.exists(path):
                        if kind == "gen":
                            out = subprocess.run([self.binary, "gen", str(w), str(h), str(dens), str(seed)], capture_output=True, text=True, check=True).stdout
                            open(path, "w").write(out)
                        else:
                            open(path, "w").write(self.picture(random.Random(seed)))
                    self.puzzles[f"{name}-{role}-{i}"] = {"name": f"{name}-{role}-{i}", "path": path, "set": name, "role": role, "limit": limit}
        for p in SURVEY[: 3 if self.smoke else 9]:
            path = os.path.join(ROOT, "puzzles", "webpbn", p + ".nin")
            if os.path.exists(path):
                self.puzzles[p] = {"name": p, "path": path, "set": "survey", "role": "both", "limit": SURVEY_LIMIT}
        self.log(f"puzzles: {len(self.puzzles)} ({sum(1 for p in self.puzzles.values() if p['set'] == 'survey')} survey)")

    @staticmethod
    def picture(rng):
        w, h = rng.randint(20, 70), rng.randint(20, 70)
        bumps = [(rng.uniform(0, w), rng.uniform(0, h), rng.uniform(0.07, 0.3) * max(w, h), rng.choice([-1, 1]) * rng.uniform(0.5, 1.5))
                 for _ in range(rng.randint(3, 9))]
        val = [[sum(a * math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s)) for cx, cy, s, a in bumps) for x in range(w)] for y in range(h)]
        flat = sorted(v for row in val for v in row)
        cut = flat[int(len(flat) * rng.uniform(0.4, 0.6))]
        g = [[v > cut for v in row] for row in val]

        def runs(cells):
            out, n = [], 0
            for c in list(cells) + [False]:
                if c:
                    n += 1
                elif n:
                    out.append(n)
                    n = 0
            return out or [0]

        rows = [runs(r) for r in g]
        cols = [runs(g[y][x] for y in range(h)) for x in range(w)]
        return "rows\n" + "\n".join(" ".join(map(str, r)) for r in rows) + "\ncols\n" + "\n".join(" ".join(map(str, c)) for c in cols) + "\n"

    def pset(self, role, sets=None):
        """Puzzles used for `role` ("tune" or "val"); the survey puzzles are in both."""
        return [p for p in self.puzzles.values() if (p["role"] in (role, "both")) and (sets is None or p["set"] in sets)]

    # ── foreign load ───────────────────────────────────────────────────────
    @staticmethod
    def cpu_times():
        f = open("/proc/stat").readline().split()[1:]
        v = list(map(int, f))
        idle = v[3] + v[4]
        return idle, sum(v)

    def foreign_busy(self):
        time.sleep(0.4)
        i0, t0 = self.cpu_times()
        time.sleep(0.6)
        i1, t1 = self.cpu_times()
        return 1.0 - (i1 - i0) / max(1, t1 - t0)

    def wait_quiet(self, what):
        """Wait while another job uses more than about one core. Returns True if the machine was quiet."""
        waited = 0
        while True:
            busy = self.foreign_busy()
            if busy < 0.14:
                return True
            if waited == 0:
                self.log(f"waiting for the machine ({busy * 100:.0f} % busy) before {what}")
            if waited > 1800:
                self.log("giving up waiting: measuring on a busy machine, rows are marked noisy")
                return False
            time.sleep(15)
            waited += 15

    # ── portfolio runs ─────────────────────────────────────────────────────
    def run_portfolio(self, cfg, puzzle):
        env = dict(os.environ)
        env.update({k: str(v) for k, v in cfg["env"].items()})
        cmd = ["taskset", "-c", "0-7", self.binary, puzzle["path"], "--threads", str(cfg["threads"])]
        t = time.perf_counter()
        p = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
        try:
            out, _ = p.communicate(timeout=puzzle["limit"] + 2)
            secs = time.perf_counter() - t
            if secs > puzzle["limit"]:
                return None, "timeout"
            verdict = "multiple" if "NOT unique" in out else "unique" if "unique" in out else "none"
            return secs, verdict
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, 9)
            p.communicate()
            return None, "timeout"

    def measure(self, tag, cfgs, puzzles, reps):
        """Interleaved: for each repetition and puzzle, every configuration in random order."""
        total = len(cfgs) * len(puzzles) * reps
        n = 0
        for rep in range(reps):
            order = list(puzzles)
            self.rng.shuffle(order)
            for puzzle in order:
                todo = [c for c in cfgs if f"{tag}|{c['id']}|{puzzle['name']}|{rep}" not in self.done]
                n += len(cfgs) - len(todo)
                if not todo:
                    continue
                if self.remaining() < 120 or time.time() > self.stage_deadline:
                    return False
                quiet = self.wait_quiet(f"{tag} {puzzle['name']}")
                self.rng.shuffle(todo)
                for c in todo:
                    secs, verdict = self.run_portfolio(c, puzzle)
                    self.record(f"{tag}|{c['id']}|{puzzle['name']}|{rep}", tag=tag, cfg=c["id"], puzzle=puzzle["name"], rep=rep, secs=secs,
                                verdict=verdict, noisy=not quiet)
                    n += 1
                if n % 200 < len(cfgs):
                    self.status(f"{tag}: {n}/{total} runs")
        return True

    def table(self, tag, cfgs, puzzles):
        """Median time per (config, puzzle); a timeout counts as twice the limit. Missing pairs are left out."""
        out = {}
        for c in cfgs:
            for p in puzzles:
                rows = [r for k, r in self.done.items() if k.startswith(f"{tag}|{c['id']}|{p['name']}|")]
                rows = [r for r in rows if not r.get("noisy")] or rows
                if rows:
                    ts = [r["secs"] if r["secs"] is not None else 2 * p["limit"] for r in rows]
                    out[(c["id"], p["name"])] = statistics.median(ts)
        return out

    def score(self, tab, cfg, ref, puzzles):
        """Weighted geometric mean over sets of the per-puzzle time ratios to the reference (below 1 is better)."""
        by_set = {}
        for p in puzzles:
            a, b = tab.get((cfg["id"], p["name"])), tab.get((ref["id"], p["name"]))
            if a is None or b is None:
                return None
            by_set.setdefault(p["set"], []).append(math.log((a + 0.01) / (b + 0.01)))
        if not by_set:
            return None
        total = sum(WEIGHTS.get(s, 1.0) for s in by_set)
        return math.exp(sum(WEIGHTS.get(s, 1.0) * statistics.mean(v) for s, v in by_set.items()) / total)

    @staticmethod
    def make_cfg(env, threads=8, label=""):
        env = {k: v for k, v in sorted(env.items())}
        cid = hashlib.sha1(json.dumps([env, threads]).encode()).hexdigest()[:10]
        return {"id": cid, "env": env, "threads": threads, "label": label}

    # ── stage 2 ────────────────────────────────────────────────────────────
    def instr_run(self, env, seed, puzzle, budget_g, core):
        e = dict(os.environ)
        e.update({k: str(v) for k, v in env.items()})
        e["NONO_SEED"] = str(seed)
        e["NONO_MAX_CONFLICTS"] = "800000"
        cmd = ["taskset", "-c", str(core), "perf", "stat", "-x,", "-e", "cpu_core/instructions/u", "--", self.binary, puzzle["path"], "--cdcl"]
        try:
            p = subprocess.run(cmd, env=e, capture_output=True, text=True, timeout=500)
        except subprocess.TimeoutExpired:
            return None
        m = re.search(r"^(\d+),", p.stderr, re.M)
        if not m or "timed out" in p.stdout:
            return None
        g = int(m.group(1)) / 1e9
        return g if g <= budget_g else None

    def eval_instr(self, strategy, env, puzzles, tag):
        """Total cost in G-instructions (an unsolved puzzle costs twice the budget) and the number solved."""
        budget = STAGE2_BUDGET_G[strategy if strategy in STAGE2_BUDGET_G else 1]
        cid = hashlib.sha1(json.dumps([strategy, sorted(env.items())]).encode()).hexdigest()[:10]
        cores = queue.Queue()
        for c in (0, 1, 2, 3):
            cores.put(c)

        def one(p):
            key = f"{tag}|s{strategy}|{cid}|{p['name']}"
            if key in self.done:
                return self.done[key]["g"]
            core = cores.get()
            try:
                g = self.instr_run(env, strategy, p, budget, core)
            finally:
                cores.put(core)
            self.record(key, tag=tag, strategy=strategy, cfg=cid, puzzle=p["name"], g=g)
            return g

        with ThreadPoolExecutor(4) as ex:
            gs = list(ex.map(one, puzzles))
        solved = sum(1 for g in gs if g is not None)
        return sum(g if g is not None else 2 * budget for g in gs), solved

    def stage2(self):
        share = 0.28
        self.stage_deadline = self.start + self.hours * 3600 * (share + 0.0)
        results = self.load("stage2.json", {})
        for strategy, space in ((1, SPACE_S1), (0, SPACE_S0)):
            if str(strategy) in results:
                continue
            tuning = [p for p in self.pset("tune") if p["set"] != "r30" and p["set"] != "pic"]
            tuning += [p for p in self.pset("tune") if p["set"] == "pic"][:6]
            if strategy == 0:
                tuning = [p for p in self.puzzles.values() if p["set"] == "survey"] + [p for p in tuning if p["set"] in ("r45", "r50")][:12]
            if self.smoke:
                tuning = tuning[:6]
            deadline = self.start + self.hours * 3600 * (share * (0.55 if strategy == 1 else 1.0))
            self.log(f"stage 2, strategy {strategy}: {len(tuning)} tuning puzzles, until {time.strftime('%H:%M', time.localtime(deadline))}")
            tested = {}

            def evaluate(params):
                env = {k: v for k, v in params.items()}
                key = json.dumps(sorted(env.items()))
                if key not in tested:
                    if self.remaining() < 300 or time.time() > deadline:
                        return None
                    tested[key] = self.eval_instr(strategy, env, tuning, "s2tune")
                    self.status(f"stage 2, strategy {strategy}: {len(tested)} candidates; best so far {min(v[0] for v in tested.values()):.0f} G")
                return tested[key]

            base = evaluate({}) or self.eval_instr(strategy, {}, tuning, "s2tune")
            self.log(f"strategy {strategy} default: {base[0]:.0f} G, solved {base[1]}/{len(tuning)}")
            # A random search: each parameter changes with probability 0.35.
            n_random = 6 if self.smoke else 70
            cands = []
            for _ in range(n_random):
                params = {k: self.rng.choice(vals[1:]) for k, vals in space.items() if self.rng.random() < 0.35}
                if params:
                    cands.append(params)
            for params in cands:
                if evaluate(params) is None:
                    break
            ranked = sorted(((v[0], k) for k, v in tested.items()))
            best_params = json.loads(ranked[0][1])
            best_params = dict(best_params)
            # Coordinate descent: one parameter at a time, two passes.
            for rnd in range(1 if self.smoke else 2):
                for name, vals in space.items():
                    cur = best_params.get(name, vals[0])
                    for v in vals:
                        if v == cur:
                            continue
                        trial = dict(best_params)
                        if v == vals[0]:
                            trial.pop(name, None)
                        else:
                            trial[name] = v
                        r = evaluate(trial)
                        if r is None:
                            break
                        cur_best = evaluate(best_params)
                        if cur_best is not None and r[0] < cur_best[0] * 0.995:
                            best_params = trial
                            cur = v
                            self.log(f"strategy {strategy}: {name}={v} improves to {r[0]:.0f} G")
            top = sorted(((v[0], k) for k, v in tested.items()))[:3]
            # Validation on puzzles never used for a choice.
            val = [p for p in self.pset("val") if p["set"] not in ("r30", "pic", "survey")][: (6 if not self.smoke else 4)]
            if strategy == 0:
                val = [p for p in self.pset("val") if p["set"] in ("r45", "r50")][:8]
            dres = self.eval_instr(strategy, {}, val, "s2val")
            cand = []
            for score, key in top:
                params = dict(json.loads(key))
                cand.append((self.eval_instr(strategy, params, val, "s2val"), params, score))
            cand.sort(key=lambda x: x[0][0])
            win = cand[0]
            adopt = win[0][0] < 0.97 * dres[0]
            self.log(f"strategy {strategy}: validation default {dres[0]:.0f} G ({dres[1]}/{len(val)}), best {win[0][0]:.0f} G ({win[0][1]}/{len(val)}) with {win[1]} -> {'adopt' if adopt else 'keep default'}")
            results[str(strategy)] = {"default_tune": base, "default_val": dres, "best_params": win[1], "best_val": win[0], "best_tune": win[2], "adopt": adopt,
                                      "tuning_puzzles": len(tuning), "validation_puzzles": len(val), "candidates": len(tested)}
            self.save("stage2.json", results)

    def learning_env(self):
        """The environment of the adopted stage 2 parameters, per strategy (NAME_S0, NAME_S1)."""
        env = {}
        for strategy, r in (self.load("stage2.json", {})).items():
            if r.get("adopt"):
                for k, v in r["best_params"].items():
                    env[f"{k}_S{strategy}"] = v
        return env

    # ── stage 1 ────────────────────────────────────────────────────────────
    SEED_LISTS = ["1,0,3,5,7,9", "1,3,5,7,9,11", "0,1,3,5,7,9", "1,0,3,5", "1,3,0,5,7,9", "1,2,0,3,5,7"]

    def sample_portfolio(self, base_env):
        r = self.rng
        threads = r.choice([4, 5, 6, 7, 8, 8, 8])
        k = r.randint(1, min(6, threads - 1))
        env = dict(base_env)
        env["NONO_CDCL_THREADS"] = k
        env["NONO_SEEDS"] = r.choice(self.SEED_LISTS)
        env["NONO_KEEP_THREADS"] = r.choice([1, 2, 2, 3, k])
        env["NONO_RETIRE_MS"] = r.choice([0, 500, 1500, 3000, 3000, 6000, 15000])
        env["NONO_SHARE"] = r.choice([0, 1, 1])
        env["NONO_SOLO_US"] = r.choice([500, 2000, 2000, 8000])
        env["NONO_CACHE_BITS"] = r.choice([12, 14, 14, 16])
        env["NONO_SCORE"] = r.choice([1, 1, 0, 2, 3])
        env["NONO_PIN"] = r.choice([0, 0, 1])
        return self.make_cfg(env, threads)

    def stage1(self):
        base_env = self.learning_env()
        default = self.make_cfg(base_env, 8, "default + stage 2")
        res = self.load("stage1.json", {})
        if "winner" in res:
            return
        share_start, share_end = 0.28, 0.78
        self.stage_deadline = self.start + self.hours * 3600 * share_end
        budget = self.hours * 3600 * (share_end - share_start)
        screen_sets = {"survey", "r50", "r60", "d40lo", "d40hi", "d50lo", "d50hi", "pic"}
        screening = [p for p in self.pset("tune", screen_sets) if p["set"] in ("survey",) or zlib.crc32(p["name"].encode()) % 3 == 0 or p["set"] == "r60"]
        screening = sorted(screening, key=lambda p: p["name"])
        if self.smoke:
            screening = screening[:6]
        self.log(f"stage 1: screening on {len(screening)} puzzles")
        cfgs = res.get("cfgs") or [default] + [self.sample_portfolio(base_env) for _ in range(4 if self.smoke else 400)]
        res["cfgs"] = cfgs
        self.save("stage1.json", res)
        # Screening: as many configurations as the time allows, 1 rep, default first.
        screen_deadline = self.start + self.hours * 3600 * (share_start + (share_end - share_start) * 0.35)
        self.stage_deadline = screen_deadline
        done_cfgs = [default]
        self.measure("s1screen", [default], screening, 1)
        for i in range(0, len(cfgs), 4):
            batch = [c for c in cfgs[i:i + 4] if c["id"] != default["id"]]
            if not batch:
                continue
            if time.time() > screen_deadline or self.remaining() < 600:
                break
            if not self.measure("s1screen", batch + [default], screening, 1):
                break
            done_cfgs += batch
        tab = self.table("s1screen", done_cfgs, screening)
        scored = [(self.score(tab, c, default, screening), c) for c in done_cfgs if c["id"] != default["id"]]
        scored = sorted([(s, c) for s, c in scored if s is not None], key=lambda x: x[0])
        self.log(f"stage 1 screening: {len(done_cfgs)} configurations, best ratios {[round(s, 3) for s, _ in scored[:5]]}")
        keep = [c for _, c in scored[: (3 if self.smoke else 48)]]
        res["screened"] = [(s, c["id"]) for s, c in scored]
        # Round 1: the tuning puzzles, 2 reps.
        self.stage_deadline = self.start + self.hours * 3600 * (share_start + (share_end - share_start) * 0.8)
        tuning = [p for p in self.pset("tune")]
        if self.smoke:
            tuning = tuning[:8]
        self.log(f"stage 1 round 1: {len(keep)} configurations on {len(tuning)} puzzles x 2")
        cand1 = [default] + keep
        for i in range(0, len(cand1), 8):
            if not self.measure("s1tune", cand1[i:i + 8] if cand1[i:i + 8][0]["id"] == default["id"] else [default] + cand1[i:i + 8], tuning, 1 if self.smoke else 2):
                break
        tab = self.table("s1tune", cand1, tuning)
        scored = [(self.score(tab, c, default, tuning), c) for c in keep]
        scored = sorted([(s, c) for s, c in scored if s is not None], key=lambda x: x[0])
        self.log(f"stage 1 round 1: best ratios {[round(s, 3) for s, _ in scored[:5]]}")
        finalists = [c for _, c in scored[:8]]
        res["finalists"] = [(s, c["id"]) for s, c in scored[:8]]
        # Round 2: validation puzzles, 3 reps.
        self.stage_deadline = self.start + self.hours * 3600 * share_end
        val = [p for p in self.pset("val")]
        if self.smoke:
            val = val[:8]
        cand2 = [default] + finalists
        self.measure("s1val", cand2, val, 2 if self.smoke else 3)
        tab = self.table("s1val", cand2, val)
        scored = [(self.score(tab, c, default, val), c) for c in finalists]
        scored = sorted([(s, c) for s, c in scored if s is not None], key=lambda x: x[0])
        self.log(f"stage 1 validation: best ratios {[round(s, 3) for s, _ in scored[:5]]}")
        if scored and scored[0][0] < 0.98:
            res["winner"] = scored[0][1]
            res["winner_score"] = scored[0][0]
        else:
            res["winner"] = default
            res["winner_score"] = 1.0
        res["finalists_val"] = [(s, c["id"]) for s, c in scored]
        self.save("stage1.json", res)

    # ── stage 3 ────────────────────────────────────────────────────────────
    def stage3(self):
        res1 = self.load("stage1.json", {})
        plain = self.make_cfg({}, 8, "current defaults")
        e2 = self.make_cfg(self.learning_env(), 8, "default + stage 2")
        best = res1.get("winner") or e2
        cfgs = []
        for c in (plain, e2, best):
            if c["id"] not in [x["id"] for x in cfgs]:
                cfgs.append(c)
        self.save("final_cfgs.json", cfgs)
        self.stage_deadline = self.start + self.hours * 3600 * 0.97
        puzzles = list(self.puzzles.values())
        if self.smoke:
            puzzles = puzzles[:10]
        self.log(f"stage 3: {len(cfgs)} configurations on {len(puzzles)} puzzles x {2 if self.smoke else 5}")
        self.measure("final", cfgs, puzzles, 2 if self.smoke else 5)
        unsolved = []
        for name in ("29-knotty", "33-faase"):
            path = os.path.join(ROOT, "puzzles", "unsolved", name + ".non")
            if os.path.exists(path) and not self.smoke:
                unsolved.append({"name": name, "path": path, "set": "unsolved", "role": "both", "limit": 400})
        self.stage_deadline = self.start + self.hours * 3600 * 0.99
        if unsolved:
            self.measure("final-unsolved", cfgs, unsolved, 2)

    # ── report ─────────────────────────────────────────────────────────────
    def report(self):
        lines = ["# Tuning matrix", "", f"Started {time.strftime('%Y-%m-%d %H:%M', time.localtime(self.start))}, {self.hours} hours planned.", ""]
        s2 = self.load("stage2.json", {})
        lines += ["## Stage 2: learning-solver parameters", ""]
        for st, r in s2.items():
            lines += [f"**Strategy {st}**: {r['candidates']} candidates on {r['tuning_puzzles']} tuning puzzles. "
                      f"Validation on {r['validation_puzzles']} new puzzles: default {r['default_val'][0]:.0f} G ({r['default_val'][1]} solved), "
                      f"best {r['best_val'][0]:.0f} G ({r['best_val'][1]} solved) with `{r['best_params']}` -> **{'adopted' if r['adopt'] else 'default kept'}**.", ""]
        s1 = self.load("stage1.json", {})
        cfgs = {c["id"]: c for c in s1.get("cfgs", [])}
        lines += ["## Stage 1: portfolio", ""]
        if s1:
            lines += [f"{len(s1.get('screened', []))} configurations screened; finalists on the validation puzzles (score below 1 is faster than the default):", ""]
            for s, cid in s1.get("finalists_val", []):
                c = cfgs.get(cid, {})
                lines.append(f"- {s:.3f}: threads {c.get('threads')}, `{c.get('env')}`")
            w = s1.get("winner")
            if w:
                lines += ["", f"Winner: score {s1.get('winner_score', 1):.3f}, threads {w['threads']}, `{w['env']}`", ""]
        fin = self.load("final_cfgs.json", [])
        if fin:
            lines += ["## Stage 3: final comparison", ""]
            puzzles = list(self.puzzles.values()) if self.puzzles else []
            if not puzzles:
                self.make_puzzles()
                puzzles = list(self.puzzles.values())
            tab = self.table("final", fin, puzzles)
            ref = fin[0]
            lines += ["| configuration | score vs current defaults | " + " | ".join(f"{s}" for s in sorted({p['set'] for p in puzzles})) + " |",
                      "|---|---|" + "---|" * len({p['set'] for p in puzzles})]
            for c in fin:
                row = [f"{c['label'] or c['id']}", f"{self.score(tab, c, ref, puzzles) or float('nan'):.3f}"]
                for s in sorted({p['set'] for p in puzzles}):
                    ps = [p for p in puzzles if p["set"] == s]
                    sc = self.score(tab, c, ref, ps)
                    tos = sum(1 for p in ps if tab.get((c["id"], p["name"]), 0) >= 2 * p["limit"] - 1e-9)
                    row.append(f"{sc:.3f}" + (f" ({tos} unsolved)" if tos else "") if sc else "-")
                lines.append("| " + " | ".join(row) + " |")
            lines += [""]
            for c in fin:
                lines.append(f"- {c['label'] or c['id']}: threads {c['threads']}, `{c['env']}`")
            un = [(c, [self.done.get(f"final-unsolved|{c['id']}|{n}|{r}") for n in ("29-knotty", "33-faase") for r in (0, 1)]) for c in fin]
            if any(any(x for x in row) for _, row in un):
                lines += ["", "Knotty and Faase (seconds, two runs each):", ""]
                for c, row in un:
                    lines.append(f"- {c['label'] or c['id']}: " + ", ".join("-" if x is None else ("timeout" if x["secs"] is None else f"{x['secs']:.1f}") for x in row))
        seen = {}
        for r in self.done.values():
            if "verdict" in r and r["verdict"] in ("unique", "multiple"):
                seen.setdefault(r["puzzle"], set()).add(r["verdict"])
        bad = sorted(p for p, v in seen.items() if len(v) > 1)
        lines += ["", "## Checks", "", f"Puzzles where two runs disagreed on unique or multiple (a bug if not empty): {bad or 'none'}.",
                  f"Runs measured while another job used the machine: {sum(1 for r in self.done.values() if r.get('noisy'))}."]
        open(os.path.join(self.dir, "REPORT.md"), "w").write("\n".join(lines) + "\n")
        best = {"learning_env": self.learning_env(), "portfolio": (s1.get("winner") or {}), "stage2": s2}
        self.save("best.json", best)
        self.log("report written")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["run", "report"])
    ap.add_argument("--dir", required=True)
    ap.add_argument("--hours", type=float, default=24)
    ap.add_argument("--binary")
    ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args()
    m = Matrix(a)
    m.make_puzzles()
    if a.cmd == "report":
        m.report()
        return
    m.log(f"start: {a.hours} h, binary {m.binary}, {'smoke' if a.smoke else 'full'} run")
    for name, fn in (("stage 2", m.stage2), ("stage 1", m.stage1), ("stage 3", m.stage3)):
        if m.remaining() < 300:
            m.log(f"no time left for {name}")
            break
        m.status(name)
        fn()
        m.report()
    open(os.path.join(m.dir, "DONE"), "w").write(now() + "\n")
    m.status("done")
    m.log("done")


if __name__ == "__main__":
    main()

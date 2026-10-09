"""A small local UI for Hugi: fetch a webpbn puzzle by number, solve it, show the solution and
how it was solved. Python standard library only.

    python3 ui/hugi_ui.py [--port 8765] [--bin PATH] [--no-browser]

Puzzles are downloaded from webpbn.com once and cached in ~/.cache/hugi/ (they are copyright
their designers; this is for personal use). Knotty and Faase, the two survey puzzles no solver
finished, come from scripts/fetch-unsolved.sh.
"""
import argparse, json, os, re, subprocess, sys, threading, time, urllib.parse, urllib.request, webbrowser, html
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(os.path.expanduser("~"), ".cache", "hugi", "webpbn")

# The quick links: the hard puzzles of Wolter's survey, and the two it could not solve.
HARD = [
    ("heart", "Heart (example)"), ("random-40", "Random 40×40 (example)"),
    ("22336", "Gettys"), ("18297", "Thing"), ("12548", "Sierp"), ("9892", "Nature"), ("6574", "Forever"),
    ("8098", "9-Dom"), ("2712", "Lion"), ("10088", "Marley"), ("10810", "Center"), ("6739", "Karate"),
    ("knotty", "Knotty (unsolved in the survey)"), ("faase", "Faase (unsolved in the survey)"),
]
UNSOLVED = {"knotty": "29-knotty.non", "faase": "33-faase.non"}
# Our own example puzzles in puzzles/, by file name without the extension.
OWN = {"heart": "A heart (15×15, solved by line logic alone)", "random-40": "A random 40×40 with several solutions"}


def export(pid, fmt):
    data = urllib.parse.urlencode({"id": pid, "fmt": fmt, "go": "1"}).encode()
    req = urllib.request.Request("https://webpbn.com/export.cgi", data=data, headers={"User-Agent": "hugi-ui"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode("utf-8", "replace")


def parse_nin(text):
    lines = text.splitlines()
    w, h = map(int, lines[0].split())
    body = [[int(x) for x in l.split() if int(x) > 0] for l in lines[1:1 + h + w]]
    return body[:h], body[h:]


def parse_non(text):
    rows, cols, cur, meta = [], [], None, {}
    for l in text.splitlines():
        l = l.strip()
        m = re.match(r'(title|by|copyright)\s+"(.*)"', l)
        if m:
            meta[m.group(1)] = html.unescape(m.group(2))
        if l == "rows":
            cur = rows; continue
        if l == "columns":
            cur = cols; continue
        if not l or l[0].isalpha():
            cur = None if l else cur; continue
        if cur is not None:
            cur.append([int(x) for x in l.split(",") if int(x) > 0])
    return rows, cols, meta


def parse_own(text):
    """Hugi's own format: a rows line, one clue per row, a cols line, one clue per column."""
    rows, cols, cur = [], [], None
    for l in text.splitlines():
        l = l.strip()
        if not l or l.startswith("#"):
            continue
        if l == "rows":
            cur = rows
        elif l in ("cols", "columns"):
            cur = cols
        elif cur is not None:
            cur.append([int(x) for x in l.split() if int(x) > 0])
    return rows, cols


def puzzle(pid):
    """(path to the puzzle file, info dict) or raise ValueError."""
    if pid in OWN:
        path = os.path.join(ROOT, "puzzles", pid + ".txt")
        rows, cols = parse_own(open(path).read())
        return path, {"id": pid, "title": OWN[pid], "author": "this repository", "year": "", "rows": rows, "cols": cols}
    if pid in UNSOLVED:
        path = os.path.join(ROOT, "puzzles", "unsolved", UNSOLVED[pid])
        if not os.path.exists(path):
            raise ValueError("run scripts/fetch-unsolved.sh first")
        rows, cols, meta = parse_non(open(path).read())
        year = re.search(r"(\d{4})", meta.get("copyright", ""))
        return path, {"id": pid, "title": meta.get("title", pid), "author": meta.get("by", "?"),
                      "year": year.group(1) if year else "", "rows": rows, "cols": cols}
    if not pid.isdigit():
        raise ValueError("a webpbn puzzle number, or heart / random-40 / knotty / faase")
    os.makedirs(CACHE, exist_ok=True)
    path, meta_path = os.path.join(CACHE, f"{pid}.nin"), os.path.join(CACHE, f"{pid}.json")
    if not os.path.exists(path):
        nin = export(pid, "nin")
        if not re.match(r"\d+ \d+", nin):
            raise ValueError(nin.strip()[:200] or "webpbn returned nothing")
        xml = export(pid, "xml")
        get = lambda tag: html.unescape(m.group(1)).strip() if (m := re.search(rf"<{tag}>([^<]*)", xml)) else "?"
        year = re.search(r"Copyright (\d{4})", xml)
        open(meta_path, "w").write(json.dumps({"title": get("title"), "author": get("author"), "year": year.group(1) if year else ""}))
        open(path, "w").write(nin)
    rows, cols = parse_nin(open(path).read())
    meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
    return path, {"id": pid, "rows": rows, "cols": cols, **meta}


def solve(path, threads, binary):
    t = time.perf_counter()
    try:
        p = subprocess.run([binary, path, "--json", "--threads", str(threads)], capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        return {"error": "no answer within 600 s"}
    if p.returncode != 0 or not p.stdout.strip():
        return {"error": (p.stderr or "solver failed").strip()[:300]}
    out = json.loads(p.stdout)
    out["wall_seconds"] = time.perf_counter() - t
    return out


class Handler(BaseHTTPRequestHandler):
    binary = None

    def send(self, code, body, ctype="application/json"):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(url.query))
        try:
            if url.path == "/":
                self.send(200, open(os.path.join(ROOT, "ui", "index.html"), "rb").read(), "text/html; charset=utf-8")
            elif url.path == "/api/hard":
                self.send(200, json.dumps([{"id": i, "name": n} for i, n in HARD]))
            elif url.path == "/api/puzzle":
                _, info = puzzle(q.get("id", "").strip().lower())
                self.send(200, json.dumps(info))
            elif url.path == "/api/solve":
                path, _ = puzzle(q.get("id", "").strip().lower())
                self.send(200, json.dumps(solve(path, int(q.get("threads", "0")), self.binary)))
            else:
                self.send(404, json.dumps({"error": "not found"}))
        except ValueError as e:
            self.send(400, json.dumps({"error": str(e)}))
        except Exception as e:  # network errors and the like
            self.send(500, json.dumps({"error": f"{type(e).__name__}: {e}"}))

    def log_message(self, *args):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--bin", help="the hugi binary (default: the newer of target-pgo/ and target/ release builds)")
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    # The newer of the PGO and the plain release build.
    builds = [p for p in (os.path.join(ROOT, "target-pgo", "release", "hugi"),
                          os.path.join(ROOT, "target", "release", "hugi")) if os.path.exists(p)]
    binary = a.bin or max(builds, key=os.path.getmtime, default=None)
    if not binary:
        sys.exit("build hugi first: cargo build --release")
    Handler.binary = binary
    server = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    url = f"http://127.0.0.1:{a.port}/"
    print(f"Hugi UI on {url} (solver: {binary}); Ctrl-C stops it")
    if not a.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

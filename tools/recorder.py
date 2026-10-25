#!/usr/bin/env python3
"""Gravador da apuração: lê o TSE e publica history.json no branch `data` do repo.

Cada ponto é um retrato completo (Brasil + 28 UFs), para que o site recalcule a
projeção histórica com o mesmo modelo do navegador. Publica via API do GitHub (gh).
Uso: python3 -u tools/recorder.py   (para com Ctrl+C)
"""
import base64, json, subprocess, sys, time, urllib.request

BASE = "https://resultados.tse.jus.br/oficial/ele2026/6258/dados"
UFS = "ac al ap am ba ce df es go ma mt ms mg pa pb pr pe pi rj rn rs ro rr sc sp se to zz".split()
REPO, BRANCH, PATH = "Sowsoc/apuracao-boletim", "data", "history.json"
POLL, PUSH_EVERY = 15, 60


def num(s):
    try:
        return float(str(s).replace(",", "."))
    except (TypeError, ValueError):
        return 0.0


def get(uf):
    url = f"{BASE}/{uf}/{uf}-c0001-e006258-u.json"
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "User-Agent": "apuracao-boletim-recorder"})
    with urllib.request.urlopen(req, timeout=15) as r:
        d = json.load(r)
    F = L = 0
    for a in d["carg"][0]["agr"]:
        for p in a["par"]:
            for c in p["cand"]:
                if c["n"] == "22": F = int(num(c["vap"]))
                if c["n"] == "13": L = int(num(c["vap"]))
    return {"ht": d.get("ht"), "pst": num(d["s"]["pstn"]), "te": int(num(d["e"]["te"])),
            "est": int(num(d["e"]["est"])), "F": F, "L": L}


def gh(*args, inp=None):
    return subprocess.run(["gh", *args], input=inp, capture_output=True, text=True, check=True).stdout


def remote():
    try:
        out = json.loads(gh("api", f"repos/{REPO}/contents/{PATH}?ref={BRANCH}"))
        return json.loads(base64.b64decode(out["content"]).decode()), out["sha"]
    except subprocess.CalledProcessError:
        return {"v": 1, "pts": []}, None


def ensure_branch():
    try:
        gh("api", f"repos/{REPO}/branches/{BRANCH}")
    except subprocess.CalledProcessError:
        sha = json.loads(gh("api", f"repos/{REPO}/git/ref/heads/main"))["object"]["sha"]
        gh("api", "-X", "POST", f"repos/{REPO}/git/refs", "-f", f"ref=refs/heads/{BRANCH}", "-f", f"sha={sha}")


def push(hist, sha):
    body = {"message": f"history: {len(hist['pts'])} pontos", "branch": BRANCH,
            "content": base64.b64encode(json.dumps(hist, separators=(",", ":")).encode()).decode()}
    if sha:
        body["sha"] = sha
    out = json.loads(gh("api", "-X", "PUT", f"repos/{REPO}/contents/{PATH}", "--input", "-", inp=json.dumps(body)))
    return out["content"]["sha"]


def main():
    ensure_branch()
    hist, sha = remote()
    last_ht = hist["pts"][-1]["br"]["ht"] if hist["pts"] else None
    dirty, last_push = False, 0.0
    print(f"retomando com {len(hist['pts'])} pontos", flush=True)
    while True:
        try:
            br = get("br")
            if br["ht"] != last_ht and br["F"] + br["L"] > 0:
                ufs = {}
                for uf in UFS:
                    try:
                        u = get(uf)
                        ufs[uf] = [u["pst"], u["te"], u["est"], u["F"], u["L"]]
                    except Exception as e:  # UF falhou: reaproveita o último retrato dela
                        if hist["pts"] and uf in hist["pts"][-1]["uf"]:
                            ufs[uf] = hist["pts"][-1]["uf"][uf]
                        print("falha", uf, e, flush=True)
                hist["pts"].append({"t": int(time.time()), "br": br, "uf": ufs})
                last_ht, dirty = br["ht"], True
                print(time.strftime("%H:%M:%S"), br["ht"], f"{br['pst']:.2f}%", flush=True)
            if dirty and time.time() - last_push >= PUSH_EVERY:
                try:
                    sha = push(hist, sha)
                except subprocess.CalledProcessError as e:
                    print("push falhou, relendo sha:", e.stderr[:200], flush=True)
                    sha = remote()[1]
                    sha = push(hist, sha)
                dirty, last_push = False, time.time()
                print("publicado", len(hist["pts"]), "pontos", flush=True)
        except Exception as e:
            print("erro", repr(e), flush=True)
        time.sleep(POLL)


if __name__ == "__main__":
    sys.exit(main())

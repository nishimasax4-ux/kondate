"""アプリ本体(public/index.html)を作る。
使い方:  python3 src/build.py
  料理や食材を増やしたときは、先に  python3 src/build_recipes.py  を実行して recipes.json を作り直す。
"""
import json, re, pathlib, datetime

SRC = pathlib.Path(__file__).parent
OUT = SRC.parent / "public" / "index.html"

foods = json.load(open(SRC / "foods.json", encoding="utf-8"))
recipes = json.load(open(SRC / "recipes.json", encoding="utf-8"))
prices = json.load(open(SRC / "prices_placeholder.json", encoding="utf-8"))
keep = ["id", "name", "cat", "refuse", "kcal", "protein", "fat", "carb_final", "fiber", "salt_g"]
slim = [{k: f.get(k) for k in keep} for f in foods]
dump = lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":"))
data = f"window.__FOODS={dump(slim)};\nwindow.__RECIPES={dump(recipes)};\nwindow.__PRICES={dump(prices)};"
planner = (SRC / "planner.js").read_text(encoding="utf-8").replace("export function", "function").replace("export const", "const")
body = (SRC / "app2.template.html").read_text(encoding="utf-8").replace("//@@DATA@@", data).replace("//@@PLANNER@@", planner)

VER = (SRC / "version.txt").read_text(encoding="utf-8").strip()
BUILD = datetime.date.today().strftime("%Y.%m.%d")
body = body.replace("@@VERSION@@", VER).replace("@@BUILD@@", BUILD)
swp = SRC.parent / "public" / "sw.js"
swp.write_text(re.sub(r'const VERSION = "[^"]*";', 'const VERSION = "v' + VER + '";', swp.read_text(encoding="utf-8")), encoding="utf-8")

title = re.search(r"<title>.*?</title>", body, re.S).group(0)
link = re.search(r'<link rel="stylesheet"[^>]*>', body).group(0)
style = re.search(r"<style>.*?</style>", body, re.S).group(0)
for part in (title, link, style):
    body = body.replace(part, "", 1)

html = f"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#2d7d6f">
<meta name="robots" content="noindex, nofollow">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="献立ノート">
<link rel="manifest" href="/manifest.webmanifest">
<script src="/config.js"></script>
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<link rel="icon" href="/icons/icon-192.png" type="image/png">
{title}
{link}
<style>body{{margin:0;font-size:14px}}img{{max-width:100%}}[hidden]{{display:none!important}}</style>
{style}
</head>
<body>
{body.strip()}
<script>if ("serviceWorker" in navigator) {{ window.addEventListener("load", function () {{ navigator.serviceWorker.register("/sw.js").catch(function () {{}}); }}); }}</script>
</body>
</html>
"""
OUT.write_text(html, encoding="utf-8")
print("書き出し:", OUT, f"{OUT.stat().st_size // 1024} KB")

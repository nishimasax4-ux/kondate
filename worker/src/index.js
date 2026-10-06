// 献立アプリ用の価格取得Worker。
// e-Stat（政府統計の総合窓口）の小売物価統計を月1回取得し、食品番号ごとの
// 100gあたり価格表（JSON）をKVに保存して、アプリに配信する。
//
//   GET  /prices.json            価格表を返す（アプリが読む）
//   GET  /admin/meta?token=...   統計表の品目・地域の一覧を返す（対応表の調整用）
//   POST /admin/refresh?token=.. 今すぐ更新する
//   Cron                         毎月自動で更新する
import { MAPPING, DERIVED } from "./mapping.js";
import { asArray, buildPrices, mergeAreas, compactPrices, marketTable, etagOf } from "./logic.js";

const API = "https://api.e-stat.go.jp/rest/3.0/app/json";
const CREDIT = "このサービスは、政府統計総合窓口(e-Stat)のAPI機能を使用していますが、サービスの内容は国によって保証されたものではありません。";

async function estat(path, params, env) {
  if (!env.ESTAT_APP_ID) throw new Error("ESTAT_APP_ID が設定されていません（wrangler secret put ESTAT_APP_ID）");
  const url = new URL(`${API}/${path}`);
  url.searchParams.set("appId", env.ESTAT_APP_ID);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(20000) });   // 応答がないまま止まらないように打ち切る
  if (!res.ok) throw new Error(`e-Stat ${path} HTTP ${res.status}`);
  return res.json();
}

// 統計表の分類（品目・地域・時間）を読み、使いやすい形にする。
// 品目が入っている軸（cat01〜cat15 のどれか）は統計表ごとに違うので、名前に「品目」を含む軸を探して使う。
async function loadMeta(env) {
  const json = await estat("getMetaInfo", { statsDataId: env.STATS_DATA_ID }, env);
  const root = json.GET_META_INFO;
  if (!root || root.RESULT.STATUS !== 0) throw new Error("getMetaInfo失敗: " + JSON.stringify(root?.RESULT));
  const objs = asArray(root.METADATA_INF.CLASS_INF.CLASS_OBJ);
  const toItems = (arr) => arr.map((c) => ({ code: c["@code"], name: c["@name"], unit: c["@unit"] || "" }));
  const dims = objs.map((o) => ({ id: o["@id"], name: o["@name"], classes: toItems(asArray(o.CLASS)) }));
  const byId = Object.fromEntries(dims.map((d) => [d.id, d]));
  const itemDim = dims.find((d) => /品目/.test(d.name) && d.id.startsWith("cat"))
    || dims.filter((d) => d.id.startsWith("cat")).sort((a, b) => b.classes.length - a.classes.length)[0];
  if (!itemDim) throw new Error("品目の軸が見つかりません");
  // 品目以外の cat 軸は、1つしか選択肢がなければそれを固定して使う。複数あるときは調整が必要。
  const fixed = {};
  const others = [];
  for (const d of dims.filter((x) => x.id.startsWith("cat") && x.id !== itemDim.id)) {
    if (d.classes.length === 1) fixed[d.id] = d.classes[0].code; else others.push(d.id);
  }
  return {
    itemDim: { id: itemDim.id, name: itemDim.name },
    fixed, others,
    items: itemDim.classes,
    areas: (byId.area || { classes: [] }).classes,
    times: (byId.time || { classes: [] }).classes,
    dims: dims.map((d) => ({ id: d.id, name: d.name, count: d.classes.length, sample: d.classes.slice(0, 5) }))
  };
}

// 1つの地域について、使う品目の価格を取って、食品ごとの価格表にする
async function pricesFor(meta, areaName, times, env, months) {
  const area = meta.areas.find((a) => a.name.includes(areaName));
  if (!area) throw new Error(`地域「${areaName}」が統計表にありません`);
  const values = [];
  // 使う品目だけを取る（872品目すべてを取ると、リクエストが増えて遅い）
  const known = new Set(meta.items.map((i) => i.code));
  const codes = [...new Set(MAPPING.flatMap((e) => e.codes))].filter((c) => known.has(c));
  const itemKey = "cd" + meta.itemDim.id[0].toUpperCase() + meta.itemDim.id.slice(1);   // cat02 → cdCat02
  // 品目が多いので、URLが長くなりすぎないよう分割して取得する
  for (let i = 0; i < codes.length; i += 60) {
    const params = { statsDataId: env.STATS_DATA_ID, cdArea: area.code, cdTime: times.join(","), metaGetFlg: "N", [itemKey]: codes.slice(i, i + 60).join(",") };
    for (const [id, code] of Object.entries(meta.fixed)) params["cd" + id[0].toUpperCase() + id.slice(1)] = code;
    const json = await estat("getStatsData", params, env);
    const root = json.GET_STATS_DATA;
    if (!root || root.RESULT.STATUS !== 0) throw new Error("getStatsData失敗: " + JSON.stringify(root?.RESULT));
    for (const v of asArray(root.STATISTICAL_DATA?.DATA_INF?.VALUE)) {
      values.push({ cat01: v["@" + meta.itemDim.id], time: v["@time"], value: v["$"] });
    }
  }
  const label = area.name.replace(/【.*$/, "");   // 「豊橋市【2010年1月～…】」→「豊橋市」
  return { label, ...buildPrices(meta.items, values, MAPPING, DERIVED, months) };
}

// opts.area: 地域名を一時的に変えて試す（「豊橋,名古屋」のように、カンマで並べると優先順）。
// opts.dry: 保存せずに結果だけ返す（地域どうしの比較用）
async function refresh(env, opts = {}) {
  const meta = await loadMeta(env);
  if (meta.others.length) throw new Error("品目以外の軸に複数の選択肢があります: " + meta.others.join(",") + "（/admin/meta で確認してください）");
  const names = String(opts.area || env.AREA_NAME).split(/[,、]/).map((s) => s.trim()).filter(Boolean);
  // 新しい月から12か月分を候補にして、品目ごとに最新の値を採用する
  // （みかん・いちごなど、時期外れで調査のない品目は、最後に載っていた月の価格になる）
  const times = meta.times.map((t) => t.code).sort().reverse().slice(0, 12);
  const results = [];
  const months = [...times].reverse();                      // 古い月から新しい月へ（相場タブの推移用）
  for (const n of names) results.push(await pricesFor(meta, n, times, env, months));
  const prices = mergeAreas(results.map((r) => ({ label: r.label, prices: r.prices })));
  // 全地域で取れなかった品目（診断用）
  const unresolved = results[results.length - 1].unresolved.filter((u) => results.every((r) => r.unresolved.some((x) => x.item === u.item)));
  const unmatched = results[0].unmatched;
  const filled = Object.values(prices).filter((p) => p.fromArea).length;
  const stale = Object.values(prices).filter((p) => p.asOf).length;
  const areaLabel = results.length === 1 ? results[0].label : `${results[0].label}(ない品目は${results.slice(1).map((r) => r.label).join("・")})`;
  // アプリに配る本体。調整用の診断（未対応の品目など）は別に保存し、公開側には出さない。
  const out = {
    updatedAt: new Date().toISOString(),
    source: "総務省統計局 小売物価統計調査（動向編）主要品目の都市別小売価格",
    area: areaLabel,
    statsDataId: env.STATS_DATA_ID,
    credit: CREDIT,
    count: Object.keys(prices).length,
    prices
  };
  if (opts.dry) {
    // 保存せず、主な食材の値段(100gあたり円)と、取れなかった品目を返す
    const key = { 精米: "01083", 食パン: "01026", 卵: "12004", 牛乳: "13003", 豆腐: "04032", 鶏もも: "11221", 豚バラ: "11129", キャベツ: "06061", たまねぎ: "06153", じゃがいも: "02017", トマト: "06182", バナナ: "07107" };
    const sample = Object.fromEntries(Object.entries(key).map(([k, id]) => [k, prices[id] ? `${prices[id].yen100g}${prices[id].fromArea ? "(" + prices[id].fromArea + ")" : ""}` : null]));
    return { dry: true, area: areaLabel, count: out.count, filledFromOtherArea: filled, staleMonths: stale, unmatched, unresolved, sample, times };
  }
  // アプリに配るのは2つ。起動のたびに読む軽い価格表と、相場タブを開いたときだけ読む詳しい表。
  const light = JSON.stringify(compactPrices(out));
  const market = JSON.stringify(marketTable(out, months));
  await env.PRICES.put("prices", light, { metadata: { etag: etagOf(light) } });
  await env.PRICES.put("market", market, { metadata: { etag: etagOf(market) } });
  await env.PRICES.put("diag", JSON.stringify({ updatedAt: out.updatedAt, unmatched, unresolved }));
  return { count: out.count, filledFromOtherArea: filled, staleMonths: stale, unmatched: unmatched.length, unresolved: unresolved.length, area: areaLabel, times, bytes: { "prices.json": light.length, "market.json": market.length } };
}

function cors(env) {
  return {
    "access-control-allow-origin": env.ALLOW_ORIGIN || "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "if-none-match",
    "access-control-expose-headers": "etag",
    "access-control-max-age": "86400",
    "content-type": "application/json; charset=utf-8"
  };
}

// 合言葉は ?token= でも、ヘッダー x-admin-token でも受ける。
// URLに書くと履歴やアクセス記録に残るので、できればヘッダーを使う。
function authorized(request, url, env) {
  const t = request.headers.get("x-admin-token") || url.searchParams.get("token") || "";
  const want = env.ADMIN_TOKEN || "";
  if (!want || want.length < 16 || t.length !== want.length) return false;
  let diff = 0;                                     // 長さが同じときは全部を比べる（応答時間から推測されないように）
  for (let i = 0; i < want.length; i++) diff |= t.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

// 価格表を返す。中身が変わっていなければ 304 だけを返し、本体は送らない（通信量をおさえる）。
// 一度配ったものは Cloudflare のキャッシュに置き、同じ内容の配信でKVを読み直さない。
async function serve(request, env, ctx, key) {
  // workers.dev のアドレスではこのキャッシュは働かない（独自ドメインにすると効く）
  let cache = null, hit = null;
  try { cache = caches.default; hit = await cache.match(request.url); } catch (e) { cache = null; }
  let body, etag;
  if (hit) { body = await hit.text(); etag = hit.headers.get("etag"); }
  else {
    const got = await env.PRICES.getWithMetadata(key);
    body = got.value;
    if (!body) return new Response(JSON.stringify({ error: "価格表がまだありません。管理画面から更新してください。" }), { status: 404, headers: cors(env) });
    etag = (got.metadata && got.metadata.etag) || etagOf(body);
  }
  const headers = { ...cors(env), etag, "cache-control": "public, max-age=86400, stale-while-revalidate=2592000", vary: "accept-encoding" };
  if (!hit && cache) { try { ctx.waitUntil(cache.put(request.url, new Response(body, { headers }))); } catch (e) {} }
  // ブラウザが前回と同じ印を送ってきたら、本体は送らない
  const sent = request.headers.get("if-none-match");
  if (sent && sent.split(",").some((t) => t.trim() === etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { headers });
}

const ADMIN_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(env) });

    if (url.pathname === "/prices.json" || url.pathname === "/market.json") {
      return serve(request, env, ctx, url.pathname === "/prices.json" ? "prices" : "market");
    }

    if (url.pathname === "/admin/meta") {
      if (!authorized(request, url, env)) return new Response("unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
      try {
        const meta = await loadMeta(env);
        const diag = await env.PRICES.get("diag", "json");
        // 品目は数百件あるので、1行ずつの短い形にする。?q=キャベツ のように指定すると、その語を含む品目だけを返す。
        const q = url.searchParams.get("q");
        const items = meta.items.filter((i) => !q || i.name.includes(q)).map((i) => `${i.code}|${i.name}|${i.unit}`);
        const areas = meta.areas.map((a) => `${a.code}|${a.name}`).filter((s) => !q || s.includes(q) || /名古屋/.test(s));
        return new Response(JSON.stringify({ itemDim: meta.itemDim, fixed: meta.fixed, others: meta.others, dims: meta.dims, itemCount: meta.items.length, items, areas, latestTimes: meta.times.map((x) => x.code).sort().reverse().slice(0, 3), diag }, null, 1), { headers: ADMIN_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 502, headers: ADMIN_HEADERS });
      }
    }

    if (url.pathname === "/admin/refresh" && (request.method === "POST" || request.method === "GET")) {   // ブラウザで開くだけでも更新できるよう GET も受ける
      if (!authorized(request, url, env)) return new Response("unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
      try {
        const opts = { area: url.searchParams.get("area") || undefined, dry: url.searchParams.get("dry") === "1" };
        return new Response(JSON.stringify(await refresh(env, opts)), { headers: ADMIN_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 502, headers: ADMIN_HEADERS });
      }
    }

    return new Response("kondate-prices", { status: 200 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refresh(env).catch((e) => console.error("価格更新に失敗:", e)));
  }
};

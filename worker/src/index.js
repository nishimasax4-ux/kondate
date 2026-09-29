// 献立アプリ用の価格取得Worker。
// e-Stat（政府統計の総合窓口）の小売物価統計を月1回取得し、食品番号ごとの
// 100gあたり価格表（JSON）をKVに保存して、アプリに配信する。
//
//   GET  /prices.json            価格表を返す（アプリが読む）
//   GET  /admin/meta?token=...   統計表の品目・地域の一覧を返す（対応表の調整用）
//   POST /admin/refresh?token=.. 今すぐ更新する
//   Cron                         毎月自動で更新する
import { MAPPING, DERIVED } from "./mapping.js";
import { asArray, buildPrices } from "./logic.js";

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

// opts.area: 地域名を一時的に変えて試す。opts.dry: 保存せずに結果だけ返す（地域どうしの比較用）
async function refresh(env, opts = {}) {
  const meta = await loadMeta(env);
  const areaName = opts.area || env.AREA_NAME;
  const area = meta.areas.find((a) => a.name.includes(areaName));
  if (!area) throw new Error(`地域「${areaName}」が統計表にありません`);

  if (meta.others.length) throw new Error("品目以外の軸に複数の選択肢があります: " + meta.others.join(",") + "（/admin/meta で確認してください）");
  // 新しい月から3か月分を候補にして、品目ごとに最新の値を採用する
  const times = meta.times.map((t) => t.code).sort().reverse().slice(0, 3);
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

  const { prices, unmatched, unresolved } = buildPrices(meta.items, values, MAPPING, DERIVED);
  // アプリに配る本体。調整用の診断（未対応の品目など）は別に保存し、公開側には出さない。
  const out = {
    updatedAt: new Date().toISOString(),
    source: "総務省統計局 小売物価統計調査（動向編）主要品目の都市別小売価格",
    area: area.name,
    statsDataId: env.STATS_DATA_ID,
    credit: CREDIT,
    count: Object.keys(prices).length,
    prices
  };
  if (opts.dry) {
    // 保存せず、主な食材の値段(100gあたり円)と、取れなかった品目を返す
    const key = { 精米: "01083", 食パン: "01026", 卵: "12004", 牛乳: "13003", 豆腐: "04032", 鶏もも: "11221", 豚バラ: "11129", キャベツ: "06061", たまねぎ: "06153", じゃがいも: "02017", トマト: "06182", バナナ: "07107" };
    const sample = Object.fromEntries(Object.entries(key).map(([k, id]) => [k, prices[id]?.yen100g ?? null]));
    return { dry: true, area: area.name, count: out.count, unmatched, unresolved, sample, times };
  }
  await env.PRICES.put("prices", JSON.stringify(out));
  await env.PRICES.put("diag", JSON.stringify({ updatedAt: out.updatedAt, unmatched, unresolved }));
  return { count: Object.keys(prices).length, unmatched: unmatched.length, unresolved: unresolved.length, area: area.name, times };
}

function cors(env) {
  return {
    "access-control-allow-origin": env.ALLOW_ORIGIN || "*",
    "access-control-allow-methods": "GET, OPTIONS",
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

const ADMIN_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(env) });

    if (url.pathname === "/prices.json") {
      const body = await env.PRICES.get("prices");
      if (!body) return new Response(JSON.stringify({ error: "価格表がまだありません。管理画面から更新してください。" }), { status: 404, headers: cors(env) });
      return new Response(body, { headers: { ...cors(env), "cache-control": "public, max-age=3600" } });
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

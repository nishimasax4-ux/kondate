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
  const url = new URL(`${API}/${path}`);
  url.searchParams.set("appId", env.ESTAT_APP_ID);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`e-Stat ${path} HTTP ${res.status}`);
  return res.json();
}

// 統計表の分類（品目・地域・時間）を読み、使いやすい形にする
async function loadMeta(env) {
  const json = await estat("getMetaInfo", { statsDataId: env.STATS_DATA_ID }, env);
  const root = json.GET_META_INFO;
  if (!root || root.RESULT.STATUS !== 0) throw new Error("getMetaInfo失敗: " + JSON.stringify(root?.RESULT));
  const objs = asArray(root.METADATA_INF.CLASS_INF.CLASS_OBJ);
  const byId = Object.fromEntries(objs.map((o) => [o["@id"], asArray(o.CLASS)]));
  const toItems = (arr) => arr.map((c) => ({ code: c["@code"], name: c["@name"], unit: c["@unit"] || "" }));
  return { items: toItems(byId.cat01 || []), areas: toItems(byId.area || []), times: toItems(byId.time || []) };
}

async function refresh(env) {
  const meta = await loadMeta(env);
  const area = meta.areas.find((a) => a.name.includes(env.AREA_NAME));
  if (!area) throw new Error(`地域「${env.AREA_NAME}」が統計表にありません`);

  // 新しい月から3か月分を候補にして、品目ごとに最新の値を採用する
  const times = meta.times.map((t) => t.code).sort().reverse().slice(0, 3);
  const values = [];
  const codes = [...new Set(meta.items.map((i) => i.code))];
  // 品目が多いので、URLが長くなりすぎないよう分割して取得する
  for (let i = 0; i < codes.length; i += 60) {
    const json = await estat("getStatsData", {
      statsDataId: env.STATS_DATA_ID,
      cdArea: area.code,
      cdTime: times.join(","),
      cdCat01: codes.slice(i, i + 60).join(","),
      metaGetFlg: "N"
    }, env);
    const root = json.GET_STATS_DATA;
    if (!root || root.RESULT.STATUS !== 0) throw new Error("getStatsData失敗: " + JSON.stringify(root?.RESULT));
    for (const v of asArray(root.STATISTICAL_DATA?.DATA_INF?.VALUE)) {
      values.push({ cat01: v["@cat01"], time: v["@time"], value: v["$"] });
    }
  }

  const { prices, unmatched, unresolved } = buildPrices(meta.items, values, MAPPING, DERIVED);
  const out = {
    updatedAt: new Date().toISOString(),
    source: "総務省統計局 小売物価統計調査（動向編）主要品目の都市別小売価格",
    area: area.name,
    statsDataId: env.STATS_DATA_ID,
    credit: CREDIT,
    prices,
    unmatched,
    unresolved
  };
  await env.PRICES.put("prices", JSON.stringify(out));
  return { count: Object.keys(prices).length, unmatched: unmatched.length, unresolved: unresolved.length, area: area.name, times };
}

function cors(env) {
  return {
    "access-control-allow-origin": env.ALLOW_ORIGIN || "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "content-type": "application/json; charset=utf-8"
  };
}

function authorized(url, env) {
  const t = url.searchParams.get("token");
  return env.ADMIN_TOKEN && t && t === env.ADMIN_TOKEN;
}

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
      if (!authorized(url, env)) return new Response("unauthorized", { status: 401 });
      try {
        const meta = await loadMeta(env);
        return new Response(JSON.stringify(meta, null, 1), { headers: cors(env) });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 502, headers: cors(env) });
      }
    }

    if (url.pathname === "/admin/refresh" && (request.method === "POST" || request.method === "GET")) {   // ブラウザで開くだけでも更新できるよう GET も受ける
      if (!authorized(url, env)) return new Response("unauthorized", { status: 401 });
      try {
        return new Response(JSON.stringify(await refresh(env)), { headers: cors(env) });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 502, headers: cors(env) });
      }
    }

    return new Response("kondate-prices", { status: 200 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refresh(env).catch((e) => console.error("価格更新に失敗:", e)));
  }
};

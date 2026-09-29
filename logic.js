// 価格計算の純粋な処理。ネットワークに依存しないので単体でテストできる。

export function asArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

// 全角数字・記号を半角に寄せる
export function normalize(s) {
  return String(s ?? "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．]/g, ".")
    .replace(/[ｇＧ]/g, "g")
    .replace(/[ｋＫ]/g, "k")
    .replace(/[㎏]/g, "kg")
    .replace(/[㎖]/g, "ml")
    .replace(/[ｍＭ]/g, "m")
    .replace(/[ｌＬ]/g, "L")
    .replace(/\s+/g, "");
}

// 「500g」「1kg」「1L」「10個」などから、グラム換算の量を取り出す。
// 液体は 1ml = 1g で近似する。個数や枚数は unitGrams が必要なので null を返す。
export function parseQuantityGrams(text, unitGrams) {
  const t = normalize(text);
  let m = t.match(/(\d+(?:\.\d+)?)(kg)/i);
  if (m) return parseFloat(m[1]) * 1000;
  m = t.match(/(\d+(?:\.\d+)?)(g)(?![a-z])/i);
  if (m) return parseFloat(m[1]);
  m = t.match(/(\d+(?:\.\d+)?)(L)(?![a-z])/);
  if (m) return parseFloat(m[1]) * 1000;
  m = t.match(/(\d+(?:\.\d+)?)(ml|mL)/);
  if (m) return parseFloat(m[1]);
  if (unitGrams) {
    m = t.match(/(\d+(?:\.\d+)?)(個|枚|本|パック|袋)/);
    if (m) return parseFloat(m[1]) * unitGrams;
    return unitGrams;
  }
  return null;
}

// VALUE の文字列を数値にする。「-」「…」など欠測は null。
export function parseValue(v) {
  if (v === undefined || v === null) return null;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// 時間軸コード "2026000808" → "2026年8月"（下2桁が月）
export function monthLabel(t) {
  const s = String(t);
  return s.slice(0, 4) + "年" + (+s.slice(-2)) + "月";
}

// 品目コード・価格データ・対応表から、食品番号ごとの100gあたり価格表を作る。
//   items:  [{code, name}]            統計表にある品目
//   values: [{cat01, time, value}]    cat01 は品目コード。新しい月が優先される
//   mapping: 対応表（mapping.js）。codes の順に探し、最初に価格があるものを使う
//   返り値: { prices, unmatched, unresolved }
export function buildPrices(items, values, mapping, derived) {
  const latest = new Map(); // 品目コード -> {time, value}
  for (const v of values) {
    const val = parseValue(v.value);
    if (val === null) continue;
    const cur = latest.get(v.cat01);
    if (!cur || String(v.time) > String(cur.time)) latest.set(v.cat01, { time: v.time, value: val });
  }
  const known = new Map(items.map((i) => [i.code, i.name]));
  // 全品目のなかで最も新しい月。これより古い月の価格は「時期外れで、さかのぼって取った値」として印を付ける
  let newest = "";
  for (const g of latest.values()) if (String(g.time) > newest) newest = String(g.time);
  const prices = {};
  const unmatched = [];
  const unresolved = [];
  for (const entry of mapping) {
    const exist = entry.codes.filter((c) => known.has(c));
    if (!exist.length) { unmatched.push(entry.foods.join(",") + " " + entry.codes.join("/")); continue; }
    const code = exist.find((c) => latest.has(c));
    if (!code) { unresolved.push({ item: known.get(exist[0]), reason: "価格データなし" }); continue; }
    const got = latest.get(code);
    const yen100g = Math.round((got.value / entry.grams) * 100 * (entry.ratio ?? 1) * 10) / 10;
    // 単位の取りちがいなどで極端な値になったときは、使わずに知らせる
    if (!(yen100g >= 0.5 && yen100g <= 3000)) { unresolved.push({ item: known.get(code), reason: `100gあたり${yen100g}円は不自然。gramsを確認` }); continue; }
    for (const f of entry.foods) {
      prices[f] = { yen100g, item: known.get(code), code, price: got.value, grams: entry.grams, time: got.time, ...(String(got.time) < newest ? { asOf: monthLabel(got.time) } : {}), ...(entry.note ? { note: entry.note } : {}) };
    }
  }
  for (const d of derived) {
    const src = prices[d.from];
    if (src && !prices[d.food]) prices[d.food] = { yen100g: Math.round(src.yen100g * d.ratio * 10) / 10, derivedFrom: d.from, note: d.note, time: src.time, ...(src.asOf ? { asOf: src.asOf } : {}) };
  }
  return { prices, unmatched, unresolved };
}

// 地域を優先順に並べ、先の地域で価格がない食材だけ、次の地域の価格で補う。
//   list: [{ label: "豊橋市", prices: {...} }, { label: "名古屋市", prices: {...} }]  ← 優先順
// 補ったものには fromArea（どの地域の価格か）を付ける。先頭の地域の価格には付けない。
// ただし、先の地域の価格が古い月のもので、次の地域に新しい月の価格があれば、新しい方を使う。
export function mergeAreas(list) {
  const prices = {};
  list.forEach((a, i) => {
    for (const [id, p] of Object.entries(a.prices)) {
      const cur = prices[id];
      if (!cur) prices[id] = i === 0 ? p : { ...p, fromArea: a.label };
      else if (String(p.time || "") > String(cur.time || "")) prices[id] = { ...p, fromArea: a.label };
    }
  });
  return prices;
}

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

// 品目一覧（{code, name, unit}）から、対応表の条件に合う品目を探す。
export function findItem(items, entry) {
  for (const alt of entry.alts) {
    const hit = items.find((it) => {
      const n = normalize(it.name);
      return alt.every((k) => n.includes(normalize(k))) &&
        !(entry.exclude || []).some((k) => n.includes(normalize(k)));
    });
    if (hit) return hit;
  }
  return null;
}

// VALUE の文字列を数値にする。「-」「…」など欠測は null。
export function parseValue(v) {
  if (v === undefined || v === null) return null;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// 品目一覧・価格データ・対応表から、食品番号ごとの100gあたり価格表を作る。
//   items:  [{code, name, unit}]
//   values: [{cat01, time, value}]  ← 新しい月が優先される
//   返り値: { prices, unmatched, unresolved }
export function buildPrices(items, values, mapping, derived) {
  const latest = new Map(); // cat01 -> {time, value}
  for (const v of values) {
    const val = parseValue(v.value);
    if (val === null) continue;
    const cur = latest.get(v.cat01);
    if (!cur || String(v.time) > String(cur.time)) latest.set(v.cat01, { time: v.time, value: val });
  }
  const prices = {};
  const unmatched = [];
  const unresolved = [];
  for (const entry of mapping) {
    const item = findItem(items, entry);
    if (!item) { unmatched.push(entry.foods.join(",") + " " + JSON.stringify(entry.alts)); continue; }
    const got = latest.get(item.code);
    if (!got) { unresolved.push({ item: item.name, reason: "価格データなし" }); continue; }
    // 価格は「単位」欄の量に対する値段なので、単位に重さが書いてあればそれを最優先で使う。
    // （品目名に「5kg」などの袋の大きさが混ざっていると、そちらを拾って単価が狂うため）
    const fromUnit = item.unit ? parseQuantityGrams(item.unit, null) : null;
    const grams = fromUnit !== null ? fromUnit : parseQuantityGrams(item.name + " " + (item.unit || ""), entry.unitGrams);
    if (!grams) { unresolved.push({ item: item.name, unit: item.unit || "", reason: "重さに換算できない単位。unitGramsを指定" }); continue; }
    const yen100g = Math.round((got.value / grams) * 100 * 10) / 10;
    for (const f of entry.foods) {
      prices[f] = { yen100g, item: item.name, unit: item.unit || "", price: got.value, grams, time: got.time };
    }
  }
  for (const d of derived) {
    const src = prices[d.from];
    if (src) prices[d.food] = { yen100g: Math.round(src.yen100g * d.ratio * 10) / 10, derivedFrom: d.from, note: d.note, time: src.time };
  }
  return { prices, unmatched, unresolved };
}

// 価格換算ロジックの確認用テスト（ネットワーク不要）。実行: node test/logic.test.mjs
import assert from "node:assert/strict";
import { buildPrices, parseValue, mergeAreas } from "../src/logic.js";
import { MAPPING, DERIVED } from "../src/mapping.js";

assert.equal(parseValue("1,234"), 1234);
assert.equal(parseValue("-"), null);

// 統計表の実際の品目コード（銘柄軸）に近い形で確認する
const items = [
  { code: "01002", name: "1002 うるち米(単一原料米,「コシヒカリ」以外)" },
  { code: "01341", name: "1341 鶏卵" },
  { code: "01303", name: "1303 牛乳(紙パック入り)" },
  { code: "01401", name: "1401 キャベツ" },
  { code: "01221", name: "1221 鶏肉" }
];
const values = [
  { cat01: "01002", time: "2026000707", value: "2500" },
  { cat01: "01002", time: "2026000808", value: "2750" },   // 新しい月が優先される
  { cat01: "01341", time: "2026000808", value: "330" },
  { cat01: "01303", time: "2026000808", value: "-" },      // 欠測は出さない
  { cat01: "01401", time: "2026000808", value: "260" },
  { cat01: "01221", time: "2026000808", value: "99" }
];
const r = buildPrices(items, values, MAPPING, DERIVED);
assert.equal(r.prices["01083"].yen100g, 55);               // 5kg袋 2750円 → 100gあたり55円
assert.equal(r.prices["12004"].yen100g, 55);               // 10個入り330円 = 600g → 55円/100g
assert.equal(r.prices["06061"].yen100g, 26);               // 1kg 260円 → 26円/100g
assert.equal(r.prices["11221"].yen100g, 99);               // 100g 99円
assert.ok(!r.prices["13003"]);                             // 牛乳は欠測
assert.equal(r.prices["01088"].yen100g, Math.round(55 * (156 / 342) * 10) / 10);   // ご飯は精米の価格から概算
assert.ok(r.unmatched.length > 0);                         // この試験の品目にないものは、未対応として残る

// 不自然な値は使わない
const bad = buildPrices([{ code: "01401", name: "キャベツ" }], [{ cat01: "01401", time: "2026000808", value: "999999" }], MAPPING, DERIVED);
assert.ok(!bad.prices["06061"]);
assert.ok(bad.unresolved.some((u) => /不自然/.test(u.reason)));

// 対応表の形の確認: 食品番号の重複がない、codes と grams がある
const seen = new Set();
for (const e of MAPPING) {
  assert.ok(e.codes.length && e.grams > 0, JSON.stringify(e));
  for (const f of e.foods) { assert.ok(!seen.has(f), "重複: " + f); seen.add(f); }
}
// 地域の優先順: 先の地域の価格を使い、ない食材だけ次の地域で補う
const m = mergeAreas([
  { label: "豊橋市", prices: { "12004": { yen100g: 50 } } },
  { label: "名古屋市", prices: { "12004": { yen100g: 60 }, "06061": { yen100g: 26 } } }
]);
assert.equal(m["12004"].yen100g, 50);
assert.ok(!m["12004"].fromArea);
assert.equal(m["06061"].yen100g, 26);
assert.equal(m["06061"].fromArea, "名古屋市");
// 時期外れ: 古い月しかない品目はさかのぼった月を印にする。新しい月のある品目には付けない
const old = buildPrices(items, [
  { cat01: "01401", time: "2026000808", value: "260" },
  { cat01: "01341", time: "2025001111", value: "330" }
], MAPPING, DERIVED);
assert.equal(old.prices["12004"].asOf, "2025年11月");
assert.ok(!old.prices["06061"].asOf);
// 先の地域の価格が古いときは、新しい月のある次の地域を使う
const m2 = mergeAreas([
  { label: "豊橋市", prices: { "12004": { yen100g: 50, time: "2025001111" } } },
  { label: "名古屋市", prices: { "12004": { yen100g: 60, time: "2026000808" } } }
]);
assert.equal(m2["12004"].yen100g, 60);
console.log("OK", Object.keys(r.prices).length, "件の価格を作成 / 対応表", MAPPING.length, "行");

// ---- 通信量をおさえるための軽い価格表と、相場タブ用の表
import { compactPrices, marketTable, etagOf } from "../src/logic.js";
const months = ["2026000606", "2026000707", "2026000808"];
const hv = [
  { cat01: "01002", time: "2026000606", value: "2600" },
  { cat01: "01002", time: "2026000707", value: "2500" },
  { cat01: "01002", time: "2026000808", value: "2750" },
  { cat01: "01341", time: "2026000808", value: "330" }
];
const h = buildPrices(items, hv, MAPPING, DERIVED, months);
assert.deepEqual(h.prices["01083"].hist, [52, 50, 55]);          // 古い月から新しい月の順
assert.equal(h.prices["12004"].hist.length, 3);
assert.equal(h.prices["12004"].hist[0], null);                    // 調査のない月は null
assert.ok(h.prices["01088"].hist, "ご飯のような換算した食材にも推移がある");

const out = { updatedAt: "2026-09-29T22:15:49.039Z", source: "出典", area: "豊橋市", credit: "クレジット", count: 2,
  prices: { "01083": { yen100g: 55, item: "1002 うるち米", grams: 5000, hist: [52, 50, 55] }, "12004": { yen100g: 55, item: "1341 鶏卵", grams: 600, fromArea: "名古屋市", asOf: "2026年6月", hist: [null, null, 55] } } };
const light = compactPrices(out);
assert.equal(light.v, 2);
assert.equal(light.p["01083"], 55);
assert.equal(light.fa[light.f["12004"]], "名古屋市");
assert.ok(!light.f["01083"]);
assert.equal(light.o["12004"], "2026年6月");
assert.ok(!JSON.stringify(light).includes("hist"), "軽い表に推移は入れない");
const mk = marketTable(out, months);
assert.equal(mk.items["01083"].n, "うるち米");                     // 先頭の品目番号は落とす
assert.deepEqual(mk.items["01083"].h, [52, 50, 55]);
assert.deepEqual(mk.m, ["2026年6月", "2026年7月", "2026年8月"]);
// 軽い表は、詳しい表よりはっきり小さい
assert.ok(JSON.stringify(light).length * 2 < JSON.stringify(mk).length + 400);
// 同じ内容なら同じ印、違えば違う印
assert.equal(etagOf("abc"), etagOf("abc"));
assert.notEqual(etagOf("abc"), etagOf("abd"));
assert.notEqual(etagOf("abc"), etagOf("abcd"));
console.log("軽量化: OK");

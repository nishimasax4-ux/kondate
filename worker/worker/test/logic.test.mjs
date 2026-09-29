// 価格換算ロジックの確認用テスト（ネットワーク不要）。実行: node test/logic.test.mjs
import assert from "node:assert/strict";
import { parseQuantityGrams, findItem, buildPrices, parseValue } from "../src/logic.js";
import { MAPPING, DERIVED } from "../src/mapping.js";

// 単位の読み取り
assert.equal(parseQuantityGrams("うるち米 1kg"), 1000);
assert.equal(parseQuantityGrams("キャベツ 1ｋｇ"), 1000);
assert.equal(parseQuantityGrams("食パン 1斤 (350g)"), 350);
assert.equal(parseQuantityGrams("牛乳 1L"), 1000);
assert.equal(parseQuantityGrams("牛乳 ５００ｍｌ"), 500);
assert.equal(parseQuantityGrams("鶏卵 10個入り", 50), 500);   // 1個50gなら10個で500g
assert.equal(parseQuantityGrams("鶏卵 パック", undefined), null);
assert.equal(parseValue("1,234"), 1234);
assert.equal(parseValue("-"), null);

// 品目探し: 「以外」つきを優先し、なければ「うるち米」だけで探す
const items = [
  { code: "A", name: "うるち米(コシヒカリ)", unit: "1kg" },
  { code: "B", name: "うるち米(コシヒカリ以外)", unit: "1kg" },
  { code: "C", name: "豚肉(国産)", unit: "100g" },
  { code: "D", name: "鶏卵", unit: "10個入り" }
];
assert.equal(findItem(items, { alts: [["うるち米", "以外"], ["うるち米"]] }).code, "B");

// 価格表の組み立て: 新しい月が優先される・欠測は飛ばされる
const values = [
  { cat01: "B", time: "2025000909", value: "500" },
  { cat01: "B", time: "2025001010", value: "540" },
  { cat01: "C", time: "2025001010", value: "180" },
  { cat01: "D", time: "2025001010", value: "-" }
];
const r = buildPrices(items, values, MAPPING, DERIVED);
assert.equal(r.prices["01083"].yen100g, 54);          // 540円/1kg → 54円/100g
assert.equal(r.prices["01088"].yen100g, Math.round(54 * (156 / 342) * 10) / 10); // ご飯は概算
assert.equal(r.prices["11126"].yen100g, 180);          // 180円/100g
assert.ok(!r.prices["12004"]);                          // 卵は欠測なので出さない
assert.ok(r.unmatched.length > 0);                      // 未対応の食材は一覧に残る

// 品目名に袋の大きさ、単位欄に価格の基準が書かれている場合は、単位欄を優先する
const items2 = [{ code: "E", name: "うるち米(コシヒカリ以外)5kg袋入り", unit: "1kg" }];
const r2 = buildPrices(items2, [{ cat01: "E", time: "2025001010", value: "540" }], MAPPING, DERIVED);
assert.equal(r2.prices["01083"].yen100g, 54);          // 5kgではなく1kgで割る
console.log("OK", Object.keys(r.prices).length, "件の価格を作成");

import fs from "node:fs";
import assert from "node:assert/strict";
import { generatePlan, costOf } from "../src/planner.js";
const foods = JSON.parse(fs.readFileSync("src/foods.json", "utf8"));
const recipes = JSON.parse(fs.readFileSync("src/recipes.json", "utf8"));
const prices = JSON.parse(fs.readFileSync("src/prices_placeholder.json", "utf8"));
const members = [{ kcal: 2650 }, { kcal: 2000 }, { kcal: 1750 }];
const base = { members, prices, foods, recipes };

// 1) 通常: 7日分・各人の目標kcalに±10%以内
let r = generatePlan({ ...base, budgetWeek: 30000, seed: 3 });
assert.equal(r.days.length, 7);
for (const d of r.days) {
  assert.equal(d.meals.length, 3);
  d.persons.forEach((p, i) => {
    const gap = Math.abs(p.nutrition.kcal - p.targetKcal) / p.targetKcal;
    assert.ok(gap <= 0.1, `日のkcalが目標から10%超ずれ: ${p.nutrition.kcal} / ${p.targetKcal}`);
  });
}
console.log("通常:", "食費(仮)", r.cost, "円 / 買い物", r.shopping.length, "品目 / 警告", r.warnings);

// 2) 主菜が3日以内に連続しない
const mains = r.days.flatMap((d) => d.meals.flatMap((m) => m.dishes.filter((x) => x.role === "主菜").map((x) => x.id)));
for (let i = 3; i < mains.length; i++) assert.ok(!mains.slice(i - 3, i).includes(mains[i]) || mains.length < 4, "主菜の連続");

// 3) アレルゲン除外: 卵・乳を除くと、その料理も乳の間食も出ない
r = generatePlan({ ...base, budgetWeek: 30000, excludeAllergens: ["卵", "乳"], seed: 3 });
const ids = new Set(r.days.flatMap((d) => d.meals.flatMap((m) => m.dishes.map((x) => x.id))));
for (const id of ids) assert.ok(!recipes.find((x) => x.id === id).allergens.some((a) => ["卵", "乳"].includes(a)));
for (const d of r.days) for (const p of d.persons) for (const s of p.snacks) assert.ok(!["13003", "13025", "13040"].includes(s.food));
console.log("卵・乳除外: OK 使った料理", ids.size, "品");

// 4) 苦手な食材(納豆=04046)・料理を除外
r = generatePlan({ ...base, budgetWeek: 30000, dislikeFoods: ["04046"], dislikeDishes: ["m07"], seed: 3 });
const ids2 = new Set(r.days.flatMap((d) => d.meals.flatMap((m) => m.dishes.map((x) => x.id))));
assert.ok(!ids2.has("s04") && !ids2.has("m07"));

// 5) 予算が低すぎる場合は、超過を警告する
r = generatePlan({ ...base, budgetWeek: 3000, seed: 3 });
assert.ok(r.overBudget && r.warnings.some((w) => w.includes("予算")));
console.log("低予算:", r.cost, "円 →", r.warnings[0]);

// 6) 価格が下がる方向に組み直されるか: 予算を絞ると食費が下がる
const hi = generatePlan({ ...base, budgetWeek: 0, seed: 3 }).cost;
const lo = generatePlan({ ...base, budgetWeek: Math.round(hi * 0.85), seed: 3 }).cost;
console.log("予算なし", hi, "円 → 予算を絞った結果", lo, "円");
assert.ok(lo <= hi, "予算を絞っても食費が下がらない");
console.log("ALL OK");

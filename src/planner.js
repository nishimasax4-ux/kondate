// 1週間の献立を組むロジック（ブラウザでもNodeでも動く純粋な関数）。
// 入力: 世帯の各人の目標kcal・週の食費・価格表・食材/レシピデータ・除外条件
// 出力: 7日分の献立、一人ひとりの分量、買い物リスト、食費の概算、注意点
//
// 考え方
//  1. 除外条件（アレルゲン・苦手）でレシピを絞る
//  2. 同じ料理が続かないように、価格と組み合わせを見ながら1日3食を選ぶ
//  3. 一人ひとりの目標kcalに合わせて分量を増減し、足りない分は間食（乳製品・果物）で補う
//  4. 食費が予算を超えたら、価格の重みを上げて安い組み合わせで組み直す

export const RICE = "01088";          // ご飯（精白米）
export const RICE_G = 150;            // ご飯1膳の基準量(g)
const LUNCH_SHARE = 0.3;              // 昼食が1日のエネルギーに占める割合（給食・外食の分を引くのに使う）
const MEAL_SHARE = [0.25, 0.3, 0.45];  // 朝・昼・夕が1日のエネルギーに占める割合（食べない食事の分を目標から引く）
const SNACKS = [                       // 間食候補: [食品番号, 1回の基準量g, 乳を含む]
  ["13003", 200, true], ["13025", 100, true], ["07107", 100, false], ["07148", 150, false], ["07027", 150, false]
];

function rng(seed) {                   // 再現できる乱数
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function foodMap(foods) { return Object.fromEntries(foods.map((f) => [f.id, f])); }

// 1人前の購入費(円)。廃棄率を考えて、可食部より多く買う前提で計算する。
export function costOf(ingredients, fm, prices, scale = 1) {
  let yen = 0, missing = [];
  for (const { food, g } of ingredients) {
    const f = fm[food]; const p = prices[food];
    if (!f || !p) { missing.push(food); continue; }
    const buy = (g * scale) / (1 - (f.refuse || 0) / 100);
    yen += (buy / 100) * p.yen100g;
  }
  return { yen, missing };
}

function nutritionOf(ingredients, fm, scale = 1) {
  const t = { kcal: 0, protein: 0, fat: 0, carb: 0, salt_g: 0, fiber: 0 };
  for (const { food, g } of ingredients) {
    const f = fm[food]; if (!f) continue;
    const k = (g * scale) / 100;
    t.kcal += (f.kcal || 0) * k; t.protein += (f.protein || 0) * k; t.fat += (f.fat || 0) * k;
    t.carb += (f.carb_final || 0) * k; t.salt_g += (f.salt_g || 0) * k; t.fiber += (f.fiber || 0) * k;
  }
  return t;
}

export function filterRecipes(recipes, { excludeAllergens = [], dislikeFoods = [], dislikeDishes = [] }) {
  return recipes.filter((r) =>
    !r.allergens.some((a) => excludeAllergens.includes(a)) &&
    !r.ingredients.some((i) => dislikeFoods.includes(i.food)) &&
    !dislikeDishes.includes(r.id));
}

// 1回分の献立を作る。used: これまでに使った料理の回数、recent: 直近に使った主菜
const WEEK_CAP = { "12004": 8 };   // 1週間に同じ食材の料理が続きすぎないように上限を決める（卵は8料理まで）
function pick(pool, used, recent, lambda, costMap, rand, maxUse, adj, foodUse) {
  const cand = pool.filter((r) => (used[r.id] || 0) < maxUse);
  const list = cand.length ? cand : pool;
  if (!list.length) return null;
  let best = null, bestScore = Infinity;
  for (const r of list) {
    const repeat = recent.includes(r.id) ? 50 : 0;
    const over = r.ingredients.some((i) => WEEK_CAP[i.food] && (foodUse[i.food] || 0) >= WEEK_CAP[i.food]) ? 25 : 0;
    const score = repeat + over + (used[r.id] || 0) * 8 + lambda * costMap[r.id] + (adj[r.id] || 0) + rand() * 6;
    if (score < bestScore) { best = r; bestScore = score; }
  }
  return best;
}

function planWeek(pools, lambda, costMap, seed, adj) {
  const rand = rng(seed); const used = {}; const recentMain = []; const foodUse = {};
  const days = [];
  const take = (pool, maxUse = 2) => {
    const r = pick(pool, used, recentMain, lambda, costMap, rand, maxUse, adj, foodUse);
    if (r) { used[r.id] = (used[r.id] || 0) + 1; for (const i of r.ingredients) if (WEEK_CAP[i.food]) foodUse[i.food] = (foodUse[i.food] || 0) + 1; }
    return r;
  };
  for (let d = 0; d < 7; d++) {
    const meals = [];
    // 朝: ご飯 + 朝向きの主菜 + 副菜 + 汁物
    const b = [take(pools.bMain), take(pools.bSide), take(pools.bSoup)].filter(Boolean);
    for (const x of b) if (x.role === "主菜") { recentMain.push(x.id); if (recentMain.length > 3) recentMain.shift(); }
    meals.push({ slot: "朝食", dishes: b });
    // 昼・夜: 主菜 + 副菜 + 汁物、または一品もの + 副菜
    for (const slot of ["昼食", "夕食"]) {
      const oneDish = pools.dish.length && rand() < 0.3;
      let dishes;
      if (oneDish) dishes = [take(pools.dish, 1), take(pools.side)].filter(Boolean);
      else dishes = [take(pools.main), take(pools.side), take(pools.soup)].filter(Boolean);
      for (const x of dishes) if (x.role === "主菜" || x.role === "一品") { recentMain.push(x.id); if (recentMain.length > 3) recentMain.shift(); }
      meals.push({ slot, dishes });
    }
    days.push(meals);
  }
  return days;
}

// 自分で決めた献立を反映する。fixed: { 日番号: { 食事番号(0朝,1昼,2夕): { ids:[料理番号] } または { off:true } } }
function applyFixed(days, fixed, recipes) {
  if (!fixed) return days;
  const rm = Object.fromEntries(recipes.map((r) => [r.id, r]));
  days.forEach((meals, d) => {
    const f = fixed[d]; if (!f) return;
    meals.forEach((m, j) => {
      const x = f[j]; if (!x) return;
      const dishes = x.off ? [] : (x.ids || []).map((id) => rm[id]).filter(Boolean);
      m.dishes = dishes; m.off = dishes.length === 0; m.manual = true;
    });
  });
  return days;
}

export function generatePlan({ pantry = {}, tastePenalty = {}, dayExtras, fixed, members, budgetWeek, prices, foods, recipes, excludeAllergens = [], dislikeFoods = [], dislikeDishes = [], seed = 1 }) {
  const fm = foodMap(foods);
  const warnings = [];
  const usable = filterRecipes(recipes, { excludeAllergens, dislikeFoods, dislikeDishes }).filter((r) => !r.special);   // 行事の料理は自動では選ばない
  const role = (r, b) => usable.filter((x) => x.role === r && (b === undefined || x.breakfast === b));
  const pools = {
    bMain: role("主菜", true), bSide: role("副菜", true), bSoup: role("汁物", true),
    main: role("主菜", false).concat(role("主菜", true)), side: role("副菜"), soup: role("汁物"), dish: role("一品")
  };
  for (const [k, v] of Object.entries(pools)) if (!v.length && k !== "dish") warnings.push(`「${k}」に使える料理がありません。除外条件をゆるめてください。`);
  if (!pools.bMain.length) pools.bMain = pools.main;
  if (!pools.bSide.length) pools.bSide = pools.side;
  if (!pools.bSoup.length) pools.bSoup = pools.soup;

  const priceMissing = new Set();
  const costMap = {};
  for (const r of usable) {
    const c = costOf(r.ingredients, fm, prices); costMap[r.id] = c.yen; c.missing.forEach((m) => priceMissing.add(m));
  }
  const riceUnit = costOf([{ food: RICE, g: RICE_G }], fm, prices).yen;

  // 家にある食材を使う料理は選ばれやすく、家族が残した料理は選ばれにくくする
  const adjMap = {};
  for (const r of usable) {
    let bonus = 0;
    for (const i of r.ingredients) { const f = fm[i.food]; if (f && f.cat !== "調味料" && f.cat !== "油脂" && i.food !== RICE) bonus += Math.min(3, (pantry[i.food] || 0) / 200); }
    adjMap[r.id] = (tastePenalty[r.id] || 0) - Math.min(9, bonus);
  }

  // 予算内に収まるまで、価格の重みを上げながら組み直す。
  // 各段階で乱数の種を変えて5通り作り、いちばん安い組み合わせを採る。
  let lambda = 0.02, result = null;
  for (let attempt = 0; attempt < 7; attempt++) {
    const tries = budgetWeek ? 5 : 1;
    for (let k = 0; k < tries; k++) {
      const cand = addExtras(finalize(applyFixed(planWeek(pools, lambda, costMap, seed + k * 101, adjMap), fixed, recipes), members, fm, prices, costMap, riceUnit, excludeAllergens, pantry), dayExtras);
      if (!result || (budgetWeek && cand.cost < result.cost)) result = cand;
    }
    if (!budgetWeek || result.cost <= budgetWeek) break;
    lambda *= 3;
  }
  const over = budgetWeek && result.cost > budgetWeek;
  if (over) warnings.push(`食費の目安が予算を約${Math.round(result.cost - budgetWeek).toLocaleString("ja-JP")}円超えています。予算を上げるか、好みの条件をゆるめてください。`);
  if (priceMissing.size) warnings.push(`価格が未設定の食材が${priceMissing.size}種あり、食費に含まれていません。`);
  return { ...result, warnings, budgetWeek, overBudget: !!over, lambda };
}

// 誕生日などのごちそう予算を、その日の食費に足す（食材や栄養には含めない）
function addExtras(res, dayExtras) {
  if (!dayExtras) return res;
  res.days.forEach((d, i) => { const x = Math.round(dayExtras[i] || 0); d.extra = x; d.cost += x; res.cost += x; });
  return res;
}

// 各人の分量を決め、間食で補い、栄養・費用・買い物リストを集計する
function finalize(plan, members, fm, prices, costMap, riceUnit, excludeAllergens, pantry = {}) {
  const noDairy = excludeAllergens.includes("乳");
  const snacks = SNACKS.filter((s) => !(noDairy && s[2]));
  let totalCost = 0;
  const shop = {}; // 食品番号 -> 必要なg
  const paid = {}; // 食品番号 -> 買う必要があるg（家にある分を引いた残り）
  const remain = { ...pantry };
  const days = plan.map((meals, di) => {
    const noLunch = (mb) => mb.lunch && mb.lunch[di] === "none";      // その日の昼は家で作らない(給食・外食など)
    const skipped = (mb, j) => meals[j].off || (j === 1 && noLunch(mb));
    const persons = members.map((mb, mi) => {
      const baseIng = [];
      meals.forEach((m, j) => {
        if (skipped(mb, j)) return;
        if (!m.dishes.some((x) => x.role === "一品")) baseIng.push({ food: RICE, g: RICE_G });   // 丼・麺などの一品にはご飯を足さない
        for (const d of m.dishes) baseIng.push(...d.ingredients);
      });
      const base = nutritionOf(baseIng, fm);
      let target = mb.kcal;                                                   // 食べない・外で食べる食事の分は目標から引く
      meals.forEach((m, j) => { if (skipped(mb, j)) target -= mb.kcal * (m.off ? MEAL_SHARE[j] : LUNCH_SHARE); });
      if (!baseIng.length) return { scale: 1, snacks: [], nutrition: round(nutritionOf([], fm)), targetKcal: 0, lunch: (mb.lunch && mb.lunch[di]) || "home", ingredients: [] };
      const scale = Math.max(0.6, Math.min(1.6, target / base.kcal));
      const main = nutritionOf(baseIng, fm, scale);
      let extra = target - main.kcal, snackItems = [];
      // 足りない分を間食で補う（日ごとに候補を回す）
      for (let i = 0; extra >= 60 && i < snacks.length && snackItems.length < 3; i++) {
        const [id, g] = snacks[(di + mi + i) % snacks.length];
        const kcal = (fm[id].kcal * g) / 100;
        const times = Math.min(2, extra / kcal);
        snackItems.push({ food: id, g: Math.round(g * times) });
        extra -= kcal * times;
      }
      const all = baseIng.map((x) => ({ food: x.food, g: x.g * scale })).concat(snackItems);
      const nut = nutritionOf(all, fm);
      return { scale: Math.round(scale * 100) / 100, snacks: snackItems, nutrition: round(nut), targetKcal: Math.round(target), lunch: (mb.lunch && mb.lunch[di]) || "home", ingredients: all };
    });
    let dayCost = 0;
    for (const p of persons) for (const i of p.ingredients) {
      const f = fm[i.food]; const buy = i.g / (1 - (f.refuse || 0) / 100);
      shop[i.food] = (shop[i.food] || 0) + buy;
      const use = Math.min(remain[i.food] || 0, buy); if (use) remain[i.food] -= use;   // 家にある分から先に使う
      const toBuy = buy - use; paid[i.food] = (paid[i.food] || 0) + toBuy;
      if (prices[i.food]) { const y = (toBuy / 100) * prices[i.food].yen100g; totalCost += y; dayCost += y; }
    }
    return { cost: Math.round(dayCost), meals: meals.map((m, j) => ({ slot: m.slot, rice: !m.off && !m.dishes.some((x) => x.role === "一品"), skip: !!m.off || (j === 1 && persons.every((x) => x.lunch === "none")), manual: !!m.manual, off: !!m.off, lunchModes: j === 1 ? persons.map((x) => x.lunch) : undefined, dishes: m.dishes.map((d) => ({ id: d.id, name: d.name, role: d.role })) })), persons: persons.map(({ ingredients, ...rest }) => rest) };
  });
  const shopping = Object.entries(shop).map(([id, g]) => ({
    food: id, name: fm[id].name, cat: fm[id].cat, grams: Math.round(paid[id]), need: Math.round(g), have: Math.round(g - paid[id]),
    yen: prices[id] ? Math.round((paid[id] / 100) * prices[id].yen100g) : null
  })).sort((a, b) => a.cat.localeCompare(b.cat, "ja") || b.need - a.need);
  return { days, shopping, cost: Math.round(totalCost) };
}

function round(n) { return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, Math.round(v * 10) / 10])); }

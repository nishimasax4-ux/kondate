import fs from "node:fs";
import { generatePlan } from "../src/planner.js";
const foods = JSON.parse(fs.readFileSync("src/foods.json","utf8")), recipes = JSON.parse(fs.readFileSync("src/recipes.json","utf8")), prices = JSON.parse(fs.readFileSync("src/prices_placeholder.json","utf8"));
const sets = { fam:[{kcal:2650},{kcal:2000},{kcal:1750}], big:[{kcal:2750},{kcal:2350}], old:[{kcal:2300},{kcal:1800}], kid:[{kcal:1300}] };
for (const [n,members] of Object.entries(sets)) { let worst=0,cnt=0,tot=0,cost=[];
  for (let seed=1;seed<=30;seed++) { const r=generatePlan({members,prices,foods,recipes,budgetWeek:20000,seed}); cost.push(r.cost);
    r.days.forEach(d=>d.persons.forEach(p=>{const g=(p.nutrition.kcal-p.targetKcal)/p.targetKcal; tot++; if(Math.abs(g)>0.1)cnt++; worst=Math.max(worst,Math.abs(g));})); }
  console.log(n,"最大ずれ",(worst*100).toFixed(1)+"%","10%超",cnt+"/"+tot,"食費",Math.min(...cost),"-",Math.max(...cost)); }

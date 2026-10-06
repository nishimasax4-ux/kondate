// 配信まわりの確認（価格表の返し方・304・CORS）。Workers を立ち上げずに、ふりをさせて試す。
import assert from "node:assert/strict";
import worker from "../src/index.js";

const BODY = JSON.stringify({ v: 2, u: "2026-09-29T00:00:00.000Z", p: { "12004": 53.2 } });
const env = {
  ALLOW_ORIGIN: "https://kondate-9e5.pages.dev",
  PRICES: {
    store: { prices: BODY, market: JSON.stringify({ v: 1, items: {} }) },
    async getWithMetadata(k) { return { value: this.store[k] ?? null, metadata: null }; },
    async get(k) { return this.store[k] ?? null; }
  }
};
const ctx = { waitUntil() {} };
const get = (path, headers = {}) => worker.fetch(new Request("https://w.example" + path, { headers }), env, ctx);

let r = await get("/prices.json");
assert.equal(r.status, 200);
assert.equal(await r.text(), BODY);
assert.equal(r.headers.get("access-control-allow-origin"), env.ALLOW_ORIGIN);
assert.ok(/max-age=86400/.test(r.headers.get("cache-control")));
const etag = r.headers.get("etag");
assert.ok(etag && etag.startsWith('"'), "印(ETag)が付く");

// 同じ印を送れば、本体は返さない
r = await get("/prices.json", { "if-none-match": etag });
assert.equal(r.status, 304);
assert.equal(await r.text(), "");
assert.equal(r.headers.get("etag"), etag);
// 複数並べて送ってきても拾える / 違う印なら本体を返す
assert.equal((await get("/prices.json", { "if-none-match": 'W/"x", ' + etag })).status, 304);
assert.equal((await get("/prices.json", { "if-none-match": '"zzz"' })).status, 200);

// 相場タブ用も同じ仕組みで返る
r = await get("/market.json");
assert.equal(r.status, 200);
assert.equal(JSON.parse(await r.text()).v, 1);

// まだ作っていないときは 404（アプリは仮の値で動く）
const empty = { ...env, PRICES: { async getWithMetadata() { return { value: null, metadata: null }; }, async get() { return null; } } };
assert.equal((await worker.fetch(new Request("https://w.example/prices.json"), empty, ctx)).status, 404);

// 合言葉なしで管理画面は開けない
assert.equal((await get("/admin/refresh")).status, 401);
assert.equal((await get("/admin/meta")).status, 401);
console.log("配信: OK");

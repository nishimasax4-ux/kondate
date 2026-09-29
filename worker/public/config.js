// 公開後に自分で書き換える設定ファイル。
// 価格取得Worker(worker/)を公開したら、その /prices.json のURLを入れると、食材の値段が公式統計になります。
// 例: pricesUrl: "https://kondate-prices.あなたの名前.workers.dev/prices.json"
window.KONDATE_CONFIG = {
  pricesUrl: ""
};

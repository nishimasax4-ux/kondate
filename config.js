// 設定ファイル。価格取得Worker(worker/)の /prices.json のアドレスです。
// ここに入れると、食材の値段が公式統計(小売物価統計調査)の価格になります。空にすると、仮の値段に戻ります。
window.KONDATE_CONFIG = {
  pricesUrl: "https://kondate-prices.nishimasax4.workers.dev/prices.json"
};

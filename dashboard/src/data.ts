/** Mock data matching the dashboard screenshot */

export const header = {
  btcPrice: 67695.54,
  pnl: 125094,
  todayPnl: 15955,
  winRate: 68.5,
  trades: 4120,
  openPos: 44336,
  nextWindow: "2:34",
  market: "12:40AM-12:45AM ET",
};

export const cumulativePnl = {
  value: 125094,
  todayChange: 15955,
  percentChange: 125.1,
  series: Array.from({ length: 60 }, (_, i) => ({
    t: i,
    v: Math.round(20000 + (i / 60) * 105000 + (i % 7) * 200),
  })),
};

export const btcSeries = Array.from({ length: 80 }, (_, i) => ({
  t: i,
  v: 66500 + (i / 80) * 2000 + Math.sin(i / 5) * 300,
}));

export const equitySeries = Array.from({ length: 40 }, (_, i) => ({
  t: i,
  v: 80000 + (i / 40) * 45000 + (i % 4) * 500,
}));

export const positions = [
  { dir: "up" as const, market: "12:40AM-12:45AM", entry: "92¢", size: 3691, status: "resolved" as const, pnl: 44 },
  { dir: "down" as const, market: "12:40AM-12:45AM", entry: "18¢", size: 3199, status: "resolved" as const, pnl: 314 },
  { dir: "up" as const, market: "12:40AM-12:45AM", entry: "97¢", size: 2067, status: "stopped" as const, pnl: -160 },
  { dir: "down" as const, market: "12:40AM-12:45AM", entry: "23¢", size: 4928, status: "resolved" as const, pnl: 455 },
  { dir: "up" as const, market: "12:35AM-12:40AM", entry: "92¢", size: 2364, status: "resolved" as const, pnl: 28 },
  { dir: "up" as const, market: "12:35AM-12:40AM", entry: "94¢", size: 3796, status: "resolved" as const, pnl: 34 },
  { dir: "down" as const, market: "12:35AM-12:40AM", entry: "9¢", size: 2408, status: "stopped" as const, pnl: -13 },
];

export const metrics = {
  avgPerTrade: 30.84,
  sharpe: 2.41,
  maxDd: -4213,
  openPos: 44336,
  kellyF: 2.84,
  ddLimit: -5.0,
};

export const orderFeed = [
  { time: "16:12:15", market: "12:40AM-12:45AM", side: "DOWN" as const, entry: "15¢", size: 1596 },
  { time: "16:12:14", market: "12:40AM-12:45AM", side: "UP" as const, entry: "89¢", size: 3423 },
  { time: "16:12:14", market: "12:40AM-12:45AM", side: "UP" as const, entry: "92¢", size: 3691 },
  { time: "16:12:10", market: "12:35AM-12:40AM", side: "DOWN" as const, entry: "12¢", size: 2100 },
  { time: "16:12:08", market: "12:35AM-12:40AM", side: "UP" as const, entry: "91¢", size: 2800 },
];

export const cexFeeds = [
  { name: "binance", price: 67696 },
  { name: "coinbase", price: 67694 },
  { name: "okx", price: 67698 },
  { name: "bybit", price: 67694 },
  { name: "kraken", price: 67696 },
  { name: "bitfinex", price: 67695 },
];

export const pipeline = {
  pmOdds: { up: "95¢", down: "6¢", implied: "95.7%", vol: "3 016" },
  edge: { cex: "97.4%", pm: "89.8%", edge: "+7.6%", sigma: "2.8" },
  kelly: { f: "2.84%", halfK: "1.42%", corr: "0.87", size: "$3 551" },
  exec: { side: "DOWN" as "UP" | "DOWN", at: "15¢", ev: "+$86" },
};

export const signalFlowExchanges = ["BIN", "DKX", "BYB", "HEX", "KUCX", "BYBP", "KUCP", "OKX", "CBX", "BFX"];
export const signalFlowGrid = Array.from({ length: 100 }, () => Math.random() > 0.4);

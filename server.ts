/**
 * BTC 5分钟涨跌盘口监控 — 独立服务端
 * 启动: npx tsx server.ts
 */

import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, unlinkSync } from "fs";
import { ethers } from "ethers";
import dotenv from "dotenv";
import { ClobClient, Side, OrderType, Chain, SignatureTypeV2 as SignatureType, AssetType, getContractConfig } from "@polymarket/clob-client-v2";
import { getAllStrategies, getStrategy, getAllDescriptions } from "./strategies/registry.js";
import type { StrategyNumber, StrategyDirection, StrategyLifecycleState, StrategyKey } from "./strategies/types.js";
import { ALL_STRATEGY_KEYS } from "./strategies/types.js";
import { getFairProb } from "./strategies/fair-prob.js";
import { getRealFillFromTx } from "./chain-watcher.js";
import { PmPnlManager } from "./polymarket-pnl.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, ".env") });

// 防止 RPC 超时等未捕获的 Promise rejection 杀死进程
process.on('unhandledRejection', (reason) => {
  console.error('[未处理异常]', reason instanceof Error ? reason.message : reason);
});

type AppMode = "full" | "headless";
type ClientDataMode = "full" | "low";

interface StrategyConfig {
  enabled: Record<StrategyKey, boolean>;
  amount: Record<StrategyKey, number>;
  slippage: number;
  autoClaimEnabled: boolean;
  maxRoundEntries: number;
  marketHoursOnly: boolean;  // 动量策略只在美股开盘时段入场
}

interface StrategyConfigUpdate {
  enabled?: Partial<Record<StrategyKey, unknown>>;
  amount?: Partial<Record<StrategyKey, unknown>>;
  slippage?: unknown;
  autoClaimEnabled?: unknown;
  maxRoundEntries?: unknown;
  marketHoursOnly?: unknown;
}

interface StrategyRuntimeState {
  state: StrategyLifecycleState;
  activeStrategy: StrategyNumber | null;
  direction: StrategyDirection | null;
  buyAmount: number;
  posBeforeBuy: number;
  posBeforeSell: number;
  waitVerifyAfterSell: boolean;
  cleanupAfterVerify: boolean;
  actionTs: number;
  prevUpPct: number | null;
  buyLockUntil: number;
  positionsReady: boolean;
  roundEntryCount: number;
}

interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
}

interface TradeHistoryItem {
  id: string;
  ts: number;
  windowStart: number;
  side: "buy" | "sell";
  direction: StrategyDirection;
  amount: number;
  price?: number | null;
  worstPrice?: number | null;
  status: string;
  source: string;
  pnl?: number | null;
  txHash?: string;
  orderId?: string;
  exitReason?: string;
  roundEntry?: string;
}

interface PendingTradeMeta {
  key: string;
  orderId?: string;
  ts: number;
  windowStart: number;
  side: "buy" | "sell";
  direction: StrategyDirection;
  amount: number;
  worstPrice: number;
  source: string;
  exitReason?: string;
  roundEntry?: string;
  /** GTC 买单成交且用户开启「快捷卖出」：再挂 GTC 卖单，卖一价 = 买单成交价 + 此值；份额用链上真实成交并略缩 */
  gtcFollowBuyDelta?: number;
}

interface ClientSession {
  dataMode: ClientDataMode;
  lastStateSentAt: number;
  stateTimer: NodeJS.Timeout | null;
  stateDirty: boolean;
  stateIncludeHistory: boolean;
}

interface StatePayloadOptions {
  includeHistory?: boolean;
  simple?: boolean;
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function parseNumberEnv(name: string, fallback: number, minimum?: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  if (minimum != null && value < minimum) return fallback;
  return value;
}

function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return null;
}

function parseNumberLike(value: unknown, minimum: number): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < minimum) return null;
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

const PORT = 3456;
const MARKET_WS_URL    = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const CHAINLINK_WS_URL = "wss://ws-live-data.polymarket.com";
const USER_WS_URL      = "wss://ws-subscriptions-clob.polymarket.com/ws/user";
const BINANCE_WS_URL   = "wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade/btcusdt@kline_1m/btcusdt@kline_5m";
const GAMMA_URL        = "https://gamma-api.polymarket.com";
const CLOB_URL         = "https://clob.polymarket.com";
const HISTORY_RETENTION_MS = 130000;
const MAX_CHAINLINK_HISTORY_POINTS = 2000;
const MAX_BINANCE_HISTORY_POINTS = 4000;
const MAX_KLINE_1M = 200;  // 保留200根1分钟K线
const MAX_KLINE_5M = 50;   // 保留50根5分钟K线
const MAX_CONFIRMED_TRADE_IDS = 2000;
const CLAIM_CYCLE_DELAY_MS = 15000;        // 查询间隔 15s（高频，保证前端金额实时）
const CLAIM_COOLDOWN_MS = 5 * 60 * 1000;   // Claim 冷却：无论成功失败，5 分钟后才能再次 claim
const UNVERIFIED_SELL_BUFFER = 0.05;
const POST_TRADE_CALIBRATION_MS = 18000;  // 下单后校准等待时长，买入锁也用此值
const STRAT_BUY_LOCK_MS = POST_TRADE_CALIBRATION_MS;
const STRATEGY_TICK_MS = 250;
const WAIT_FILL_TIMEOUT_MS = 10000;
const FILL_RECONCILE_TIMEOUT_MS = POST_TRADE_CALIBRATION_MS + 2000;  // 校准完成后再等2秒确认
const BINANCE_ALIGN_WINDOW_MS = 60000;
const BINANCE_ALIGN_MIN_SPAN_MS = 10000;
const BINANCE_ALIGN_BUCKET_MS = 500;
const BINANCE_ALIGN_REFRESH_MS = 30000;
const BINANCE_OFFSET_EPSILON = 0.01;
const FULL_DATA_STATE_INTERVAL_MS = 200;
const LOW_DATA_STATE_INTERVAL_MS = 2000;
const MAX_WS_BUFFERED_BYTES = 512 * 1024;
const TRADE_HISTORY_FILE = resolve(__dirname, ".trade-history.json");
const STRATEGY_CONFIG_FILE = resolve(__dirname, ".strategy-config.json");
const BACKTEST_DATA_DIR = resolve(__dirname, "backtest-data");
const TRADE_HISTORY_MAX = 200;
const PENDING_TRADE_META_MAX_AGE_MS = 15 * 60 * 1000;

const PRIVATE_KEY   = process.env.POLYMARKET_PRIVATE_KEY || "";
const PROXY_ADDRESS = process.env.POLYMARKET_PROXY_ADDRESS || "";

/** Builder 归因 bytes32（Polymarket 设置 → Builder）。未设置则不附带。 */
function resolveClobBuilderConfig(): { builderCode: string } | undefined {
  const raw = (process.env.POLYMARKET_BUILDER_CODE ?? process.env.POLY_BUILDER_CODE ?? "").trim();
  if (!raw) return undefined;
  return { builderCode: raw };
}

const CLOB_BUILDER_CONFIG = resolveClobBuilderConfig();
if (CLOB_BUILDER_CONFIG) {
  console.log("[Auth] 已配置 Polymarket builder 归因（订单将带 builderCode）");
}

const APP_MODE: AppMode = process.env.APP_MODE === "headless" ? "headless" : "full";
const IS_FULL_MODE = APP_MODE === "full";

function createEnvStrategyConfig(): StrategyConfig {
  const enabled = {} as Record<StrategyKey, boolean>;
  const amount = {} as Record<StrategyKey, number>;
  for (const key of ALL_STRATEGY_KEYS) {
    const upper = key.toUpperCase();
    enabled[key] = parseBooleanEnv(`STRATEGY_${upper}_ENABLED`, false);
    amount[key] = parseNumberEnv(`STRATEGY_${upper}_AMOUNT`, 1, 0.01);
  }
  return {
    enabled,
    amount,
    slippage: parseNumberEnv("ORDER_DEFAULT_SLIPPAGE", 0.05, 0),
    autoClaimEnabled: parseBooleanEnv("AUTO_CLAIM_ENABLED", false),
    maxRoundEntries: parseNumberEnv("MAX_ROUND_ENTRIES", 1, 1),
    marketHoursOnly: parseBooleanEnv("MARKET_HOURS_ONLY", false),
  };
}

function cloneStrategyConfig(config: StrategyConfig): StrategyConfig {
  return {
    enabled: { ...config.enabled },
    amount: { ...config.amount },
    slippage: config.slippage,
    autoClaimEnabled: config.autoClaimEnabled,
    maxRoundEntries: config.maxRoundEntries,
    marketHoursOnly: config.marketHoursOnly,
  };
}

function loadPersistedStrategyConfig(config: StrategyConfig): void {
  if (!existsSync(STRATEGY_CONFIG_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(STRATEGY_CONFIG_FILE, "utf-8"));
    if (typeof raw.maxRoundEntries === "number" && raw.maxRoundEntries >= 1) {
      config.maxRoundEntries = Math.floor(raw.maxRoundEntries);
    }
    if (typeof raw.marketHoursOnly === "boolean") {
      config.marketHoursOnly = raw.marketHoursOnly;
    }
    if (typeof raw.autoClaimEnabled === "boolean") {
      config.autoClaimEnabled = raw.autoClaimEnabled;
    }
  } catch {
    // ignore
  }
}

function savePersistedStrategyConfig(config: StrategyConfig): void {
  try {
    writeFileSync(STRATEGY_CONFIG_FILE, JSON.stringify({
      maxRoundEntries: config.maxRoundEntries,
      marketHoursOnly: config.marketHoursOnly,
      autoClaimEnabled: config.autoClaimEnabled,
    }, null, 2));
  } catch (err) {
    console.warn(`[StrategyConfig] 持久化保存失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function applyStrategyConfigUpdate(current: StrategyConfig, rawUpdate: unknown): { config?: StrategyConfig; error?: string } {
  if (!isRecord(rawUpdate)) return { error: "配置格式错误" };
  const next = cloneStrategyConfig(current);

  if ("enabled" in rawUpdate) {
    if (!isRecord(rawUpdate.enabled)) return { error: "enabled 配置格式错误" };
    for (const key of ALL_STRATEGY_KEYS) {
      if (!(key in rawUpdate.enabled)) continue;
      const parsed = parseBooleanLike(rawUpdate.enabled[key]);
      if (parsed == null) return { error: `${key} 开关必须是布尔值` };
      next.enabled[key] = parsed;
    }
  }

  if ("amount" in rawUpdate) {
    if (!isRecord(rawUpdate.amount)) return { error: "amount 配置格式错误" };
    for (const key of ALL_STRATEGY_KEYS) {
      if (!(key in rawUpdate.amount)) continue;
      const parsed = parseNumberLike(rawUpdate.amount[key], 0.01);
      if (parsed == null) return { error: `${key} 金额必须大于等于 0.01` };
      next.amount[key] = parsed;
    }
  }

  if ("slippage" in rawUpdate) {
    const parsed = parseNumberLike(rawUpdate.slippage, 0);
    if (parsed == null) return { error: "slippage 必须大于等于 0" };
    next.slippage = parsed;
  }

  if ("autoClaimEnabled" in rawUpdate) {
    const parsed = parseBooleanLike(rawUpdate.autoClaimEnabled);
    if (parsed == null) return { error: "autoClaimEnabled 必须是布尔值" };
    next.autoClaimEnabled = parsed;
  }

  if ("maxRoundEntries" in rawUpdate) {
    const parsed = parseNumberLike(rawUpdate.maxRoundEntries, 1);
    if (parsed == null || !Number.isInteger(parsed)) return { error: "maxRoundEntries 必须是大于等于1的整数" };
    next.maxRoundEntries = parsed;
  }

  if ("marketHoursOnly" in rawUpdate) {
    const parsed = parseBooleanLike(rawUpdate.marketHoursOnly);
    if (parsed == null) return { error: "marketHoursOnly 必须是布尔值" };
    next.marketHoursOnly = parsed;
  }

  return { config: next };
}

let strategyConfig = createEnvStrategyConfig();
loadPersistedStrategyConfig(strategyConfig);
let tradeHistory: TradeHistoryItem[] = loadTradeHistory();
const pendingTradeMeta = new Map<string, PendingTradeMeta>();

function loadTradeHistory(): TradeHistoryItem[] {
  if (!existsSync(TRADE_HISTORY_FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(TRADE_HISTORY_FILE, "utf-8")) as unknown;
    if (!Array.isArray(raw)) return [];
    const filtered = raw
      .filter((item): item is TradeHistoryItem => isRecord(item)
        && typeof item.id === "string"
        && typeof item.ts === "number"
        && typeof item.windowStart === "number"
        && (item.side === "buy" || item.side === "sell")
        && (item.direction === "up" || item.direction === "down")
        && typeof item.amount === "number"
        && typeof item.status === "string"
        && typeof item.source === "string"
        && (typeof item.price === "number" || typeof item.worstPrice === "number"))
      .slice(0, TRADE_HISTORY_MAX);
    return applyTradeHistoryMetrics(filtered);
  } catch (err) {
    console.warn(`[TradeHistory] 读取失败: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function persistTradeHistory(): void {
  writeFileSync(TRADE_HISTORY_FILE, `${JSON.stringify(tradeHistory, null, 2)}\n`, "utf-8");
}

function getTradeHistoryPrice(item: TradeHistoryItem): number | null {
  const candidate = typeof item.price === "number"
    ? item.price
    : typeof item.worstPrice === "number"
      ? item.worstPrice
      : NaN;
  return Number.isFinite(candidate) ? candidate : null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function applyTradeHistoryMetrics(items: TradeHistoryItem[]): TradeHistoryItem[] {
  const lots: Record<StrategyDirection, Array<{ amount: number; price: number }>> = {
    up: [],
    down: [],
  };
  const ordered = [...items].sort((a, b) => a.ts - b.ts);
  for (const item of ordered) {
    const price = getTradeHistoryPrice(item);
    item.price = price;
    item.pnl = null;
    if (price == null || !Number.isFinite(item.amount) || item.amount <= 0) continue;
    if (item.side === "buy") {
      lots[item.direction].push({ amount: item.amount, price });
      continue;
    }
    let remaining = item.amount;
    let realizedPnl = 0;
    let matchedAmount = 0;
    const directionLots = lots[item.direction];
    while (remaining > 1e-8 && directionLots.length > 0) {
      const lot = directionLots[0];
      const matched = Math.min(remaining, lot.amount);
      realizedPnl += (price - lot.price) * matched;
      lot.amount -= matched;
      remaining -= matched;
      matchedAmount += matched;
      if (lot.amount <= 1e-8) directionLots.shift();
    }
    if (matchedAmount > 0) {
      item.pnl = roundMoney(realizedPnl);
    }
  }
  return items.sort((a, b) => b.ts - a.ts);
}

// ── Polymarket 真实盈亏管理器 ─────────────────────────────────
const pmPnlManager = new PmPnlManager(PROXY_ADDRESS);

function recordTradeHistory(item: Omit<TradeHistoryItem, "id">): void {
  const record: TradeHistoryItem = {
    id: `${item.ts}-${item.side}-${item.direction}-${item.source}-${Math.random().toString(36).slice(2, 8)}`,
    ...item,
  };
  tradeHistory.unshift(record);
  if (tradeHistory.length > TRADE_HISTORY_MAX) {
    tradeHistory = tradeHistory.slice(0, TRADE_HISTORY_MAX);
  }
  tradeHistory = applyTradeHistoryMetrics(tradeHistory);
  try {
    persistTradeHistory();
  } catch (err) {
    console.warn(`[TradeHistory] 保存失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  // 记录 txHash → source 映射，供 Polymarket PnL 标注策略来源
  if (record.txHash && record.source) {
    pmPnlManager.recordStrategySource(record.txHash, record.source);
  }
  // 触发增量同步（不阻塞）
  if (record.txHash) {
    console.log(`[PmPnl] 下单触发增量同步 (tx: ${record.txHash.slice(0, 10)}...)`);
    pmPnlManager.syncIncremental().then(() => {
      console.log(`[PmPnl] 下单增量完成 → broadcast`);
      broadcastPmPnl();
    }).catch((err) => {
      console.warn(`[PmPnl] 下单增量失败: ${err instanceof Error ? err.message : String(err)}`);
    });
  } else {
    console.log(`[PmPnl] 跳过增量同步（无 txHash）`);
  }
  broadcastTradeHistory();
}

function broadcastPmPnl(): void {
  // 全量：前端按 range 过滤，不截断
  const events = pmPnlManager.getEvents();
  const total = pmPnlManager.getTotalPnl();
  broadcast("pmPnl", { events, total, initialized: pmPnlManager.isInitialized() });
}

function sendPmPnlToClient(ws: WebSocket): void {
  const events = pmPnlManager.getEvents();
  const total = pmPnlManager.getTotalPnl();
  send(ws, "pmPnl", { events, total, initialized: pmPnlManager.isInitialized() });
}

function cleanupPendingTradeMeta(now = Date.now()): void {
  for (const [key, meta] of pendingTradeMeta) {
    if (now - meta.ts > PENDING_TRADE_META_MAX_AGE_MS) {
      pendingTradeMeta.delete(key);
    }
  }
}

function rememberPendingTradeMeta(meta: Omit<PendingTradeMeta, "key">): void {
  cleanupPendingTradeMeta(meta.ts);
  const key = meta.orderId || `pending-${meta.ts}-${Math.random().toString(36).slice(2, 8)}`;
  pendingTradeMeta.set(key, { key, ...meta });
}

function normalizeTradeSide(value: unknown): "buy" | "sell" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "buy") return "buy";
  if (normalized === "sell") return "sell";
  return null;
}

function getDirectionByAssetId(assetId: string): StrategyDirection | null {
  if (assetId === state.upTokenId) return "up";
  if (assetId === state.downTokenId) return "down";
  return null;
}

/**
 * GTC 跟卖：必须用 pending 里的 direction 对应的真实 outcome tokenId。
 * Maker 买单成交时 UserWS 常先推 side=SELL（对手 taker 卖出）；另一条 leg 的 MINED 可能是互补 token，价格满足 p + (1-p) = 1，份额与 outcome 不一定同数值，互补腿时用 pending 下单股数更稳。
 */
function resolveGtcFollowOutcomeFill(input: {
  direction: StrategyDirection;
  evtAssetId: string;
  evtPrice: number;
  evtSize: number;
  pendingWorstPrice: number;
  pendingAmount: number;
}): { tokenId: string; fillPrice: number; wsFillSize: number } | null {
  const { direction, evtAssetId, evtPrice, evtSize, pendingWorstPrice, pendingAmount } = input;
  const up = state.upTokenId;
  const down = state.downTokenId;
  const outcomeId = direction === "up" ? up : down;
  if (!outcomeId) return null;

  const oppositeId = direction === "up" ? down : up;
  let fillPrice = evtPrice;
  let wsFillSize = evtSize;

  if (evtAssetId === outcomeId) {
    // WS 已落在买的 outcome 上
  } else if (oppositeId && evtAssetId === oppositeId && Number.isFinite(evtPrice) && evtPrice > 0 && evtPrice < 1) {
    fillPrice = 1 - evtPrice;
    wsFillSize = pendingAmount;
  } else {
    fillPrice = pendingWorstPrice;
    wsFillSize = pendingAmount;
  }

  if (!Number.isFinite(fillPrice) || fillPrice <= 0) fillPrice = pendingWorstPrice;
  if (!Number.isFinite(wsFillSize) || wsFillSize <= 0) wsFillSize = pendingAmount;

  if (!Number.isFinite(fillPrice) || fillPrice <= 0 || !Number.isFinite(wsFillSize) || wsFillSize <= 0) return null;

  return { tokenId: outcomeId, fillPrice, wsFillSize };
}

function parseTradeEventTimestamp(evt: Record<string, unknown>): number {
  const raw = typeof evt.match_time === "string"
    ? evt.match_time
    : typeof evt.last_update === "string"
      ? evt.last_update
      : "";
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function _extractCandidateOrderIds(evt: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const taker = evt.taker_order_id ?? evt.takerOrderId;
  if (typeof taker === "string" && taker) ids.push(taker);
  const makers = evt.maker_orders ?? evt.makerOrders;
  if (Array.isArray(makers)) {
    for (const mo of makers) {
      if (!isRecord(mo)) continue;
      const oid = mo.order_id ?? mo.orderId;
      if (typeof oid === "string" && oid) ids.push(oid);
    }
  }
  return ids;
}

/**
 * 从 WS TRADE 事件中提取**我们自己**的成交份额。
 * 参考 demo 项目 _extract_fill_for_order：
 * - 我们是 taker 时，event-level size 就是自己的；
 * - 我们是 maker 时，event-level size 可能是 aggregate，需要从 maker_orders 中累加 matched_amount。
 */
function extractOwnFillFromEvt(
  evt: Record<string, unknown>,
  candidateIds: string[],
): { price: number; size: number; matchedOrderId: string } | null {
  if (!candidateIds.length) return null;

  const eventPrice = typeof evt.price === "number" ? evt.price : parseFloat(String(evt.price ?? ""));
  const eventSize = typeof evt.size === "number" ? evt.size : parseFloat(String(evt.size ?? ""));

  for (const target of candidateIds) {
    const takerId =
      (typeof evt.taker_order_id === "string" ? evt.taker_order_id : "") ||
      (typeof evt.takerOrderId === "string" ? evt.takerOrderId : "");
    if (takerId && takerId.toLowerCase() === target.toLowerCase()) {
      if (Number.isFinite(eventPrice) && eventPrice > 0 && Number.isFinite(eventSize) && eventSize > 0) {
        return { price: eventPrice, size: eventSize, matchedOrderId: target };
      }
      return null;
    }

    const makers = evt.maker_orders ?? evt.makerOrders;
    if (Array.isArray(makers)) {
      let totalSize = 0;
      let totalNotional = 0;
      for (const mo of makers) {
        if (!isRecord(mo)) continue;
        const oid =
          (typeof mo.order_id === "string" ? mo.order_id : "") ||
          (typeof mo.orderId === "string" ? mo.orderId : "");
        if (oid.toLowerCase() !== target.toLowerCase()) continue;
        const sz =
          typeof mo.matched_amount === "number"
            ? mo.matched_amount
            : typeof mo.matchedAmount === "number"
              ? mo.matchedAmount
              : parseFloat(String(mo.matched_amount ?? mo.matchedAmount ?? ""));
        const pr = typeof mo.price === "number" ? mo.price : parseFloat(String(mo.price ?? ""));
        if (!Number.isFinite(sz) || sz <= 0 || !Number.isFinite(pr) || pr <= 0) continue;
        totalSize += sz;
        totalNotional += sz * pr;
      }
      if (totalSize > 0) {
        return { price: totalNotional / totalSize, size: totalSize, matchedOrderId: target };
      }
    }
  }

  // fallback: 无法精确定位时退化为 event-level（单 maker 场景通常没问题）
  if (Number.isFinite(eventPrice) && eventPrice > 0 && Number.isFinite(eventSize) && eventSize > 0) {
    return { price: eventPrice, size: eventSize, matchedOrderId: candidateIds[0] };
  }
  return null;
}

function consumePendingTradeMeta(evt: Record<string, unknown>): PendingTradeMeta | null {
  cleanupPendingTradeMeta();
  const candidateIds = _extractCandidateOrderIds(evt);
  for (const id of candidateIds) {
    const meta = pendingTradeMeta.get(id);
    if (!meta) continue;
    pendingTradeMeta.delete(id);
    return meta;
  }

  const side = normalizeTradeSide(evt.side);
  const assetId = typeof evt.asset_id === "string" ? evt.asset_id : "";
  const size = typeof evt.size === "number" ? evt.size : Number(evt.size);
  if (!side || !assetId || !Number.isFinite(size)) return null;

  // 退化匹配：先严格匹配 same asset + same side
  let bestKey: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [key, meta] of pendingTradeMeta) {
    const directionTokenId = meta.direction === "up" ? state.upTokenId : state.downTokenId;
    if (directionTokenId !== assetId || meta.side !== side) continue;
    const score = Math.abs(meta.amount - size) * 1000 + Math.abs(Date.now() - meta.ts) / 1000;
    if (score < bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }

  // 第二轮宽松匹配：Maker 买单成交时 WS 常推 side=SELL（对手 taker 卖出），
  // 此时 strict 匹配会漏掉我们的 buy meta。对 same asset 的 buy pending 做 fallback。
  if (!bestKey && side === "sell") {
    for (const [key, meta] of pendingTradeMeta) {
      const directionTokenId = meta.direction === "up" ? state.upTokenId : state.downTokenId;
      if (directionTokenId !== assetId || meta.side !== "buy") continue;
      const score = Math.abs(meta.amount - size) * 1000 + Math.abs(Date.now() - meta.ts) / 1000;
      if (score < bestScore) {
        bestScore = score;
        bestKey = key;
      }
    }
  }

  if (!bestKey) return null;
  const meta = pendingTradeMeta.get(bestKey) || null;
  if (meta) pendingTradeMeta.delete(bestKey);
  return meta;
}

// ── Polymarket 认证 ───────────────────────────────────────────
const CREDS_FILE = resolve(__dirname, ".polymarket-creds.json");

interface PolymarketCreds {
  key: string; secret: string; passphrase: string; address: string;
}

function adaptSigner(wallet: ethers.Wallet) {
  return {
    _signTypedData: (
      domain: Record<string, unknown>,
      types: Record<string, unknown[]>,
      value: Record<string, unknown>
    ) => wallet.signTypedData(
      domain as ethers.TypedDataDomain,
      types as Record<string, ethers.TypedDataField[]>,
      value
    ),
    getAddress: () => Promise.resolve(wallet.address),
  };
}

function loadCreds(): PolymarketCreds | null {
  if (!existsSync(CREDS_FILE)) return null;
  try {
    const creds: PolymarketCreds = JSON.parse(readFileSync(CREDS_FILE, "utf-8"));
    if (creds.key && creds.secret && creds.passphrase) return creds;
  } catch { /* 忽略 */ }
  return null;
}

async function createClobClient(): Promise<ClobClient | null> {
  const sigType = PROXY_ADDRESS ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;
  const funderAddress = PROXY_ADDRESS || undefined;
  const baseOpts = {
    host: CLOB_URL,
    chain: Chain.POLYGON,
    signatureType: sigType,
    funderAddress,
    ...(CLOB_BUILDER_CONFIG ? { builderConfig: CLOB_BUILDER_CONFIG } : {}),
  };
  const saved   = loadCreds();

  if (saved) {
    const creds = { key: saved.key, secret: saved.secret, passphrase: saved.passphrase };
    if (PRIVATE_KEY) {
      const signer = adaptSigner(new ethers.Wallet(PRIVATE_KEY)) as any;
      return new ClobClient({ ...baseOpts, signer, creds });
    }
    return new ClobClient({ ...baseOpts, creds });
  }

  if (!PRIVATE_KEY) {
    console.warn("[Auth] 未配置 POLYMARKET_PRIVATE_KEY，下单功能不可用");
    return null;
  }

  console.log("[Auth] 首次使用，通过私钥生成 Polymarket API 凭证...");
  const wallet = new ethers.Wallet(PRIVATE_KEY);
  const signer = adaptSigner(wallet) as any;
  const client = new ClobClient({ ...baseOpts, signer });
  const creds  = await client.createOrDeriveApiKey();
  writeFileSync(CREDS_FILE, JSON.stringify({ key: creds.key, secret: creds.secret, passphrase: creds.passphrase, address: wallet.address }, null, 2));
  console.log("[Auth] 凭证已保存到 .polymarket-creds.json");
  return new ClobClient({ ...baseOpts, signer, creds });
}

// ── HTTP 服务 ─────────────────────────────────────────────────
const app = express();
app.use(express.json());
if (IS_FULL_MODE) {
  app.use(express.static(__dirname));
  app.get("/", (_req, res) => {
    res.sendFile(resolve(__dirname, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res.json({
      name: "btc5m-web",
      mode: APP_MODE,
      stateUrl: "/api/state",
    });
  });
}

const server = createServer(app);
const wss = IS_FULL_MODE ? new WebSocketServer({ server }) : null;
const clientSessions = new Map<WebSocket, ClientSession>();

// ── CLOB Client（下单用） ──────────────────────────────────────
let clobClient: ClobClient | null = null;

async function ensureClobClient(): Promise<boolean> {
  if (clobClient) return true;
  try { clobClient = await createClobClient(); return clobClient != null; }
  catch (err) { console.error("[CLOB] 初始化失败:", err); return false; }
}

// ── 盘口状态 ──────────────────────────────────────────────────
const state = {
  windowStart: 0,
  windowEnd: 0,
  upTokenId: "",
  downTokenId: "",
  conditionId: "",
  bids: new Map<string, string>(),
  asks: new Map<string, string>(),
  bestBid: "-",
  bestAsk: "-",
  /** 跌 outcome token 的 BBO（与 bestBid/bestAsk 的 up token 分离） */
  downBestBid: "-",
  downBestAsk: "-",
  lastPrice: "-",
  lastSide: "",
  updatedAt: 0,
  priceToBeat: null as number | null,
  currentPrice: null as number | null,
  binanceOffset: null as number | null,
  priceHistory: [] as Array<{ t: number; price: number }>,
  binanceHistory: [] as Array<{ t: number; price: number }>,
  kline1m: [] as Array<Kline>,
  kline5m: [] as Array<Kline>,
};

const strategyRuntime: StrategyRuntimeState = {
  state: "IDLE",
  activeStrategy: null,
  direction: null,
  buyAmount: 0,
  posBeforeBuy: 0,
  posBeforeSell: 0,
  waitVerifyAfterSell: false,
  cleanupAfterVerify: false,
  actionTs: 0,
  prevUpPct: null,
  buyLockUntil: 0,
  positionsReady: !PROXY_ADDRESS,
  roundEntryCount: 0,
};

// ── 持仓状态 ──────────────────────────────────────────────────
const wsStatus = { market: false, chainlink: false, user: false, binance: false };
function broadcastWsStatus() { broadcast("wsStatus", wsStatus as unknown as Record<string, unknown>); }
const positions = {
  usdc: null as number | null,
  usdcAllowanceStatus: "未授权" as "已授权" | "未完全授权" | "未授权",
  usdcAllowanceMin: null as number | null,
  usdcAllowanceDetails: [] as Array<{ spender: string; amount: number | null }>,
  localSize: {} as Record<string, number>,
  apiSize: {} as Record<string, number>,
  apiVerified: {} as Record<string, boolean>,
  confirmedIds: new Set<string>(),
  confirmedIdOrder: [] as string[],
  lastTradeAt: null as number | null,
  lastApiSyncAt: null as number | null,
};

// ── 广播 ──────────────────────────────────────────────────────
function send(ws: WebSocket, type: string, data: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, ...data }));
}

function sendTradeHistoryToClient(ws: WebSocket): void {
  send(ws, "tradeHistory", { tradeHistory });
}

function broadcastTradeHistory(): void {
  broadcast("tradeHistory", { tradeHistory });
}

function createClientSession(dataMode: ClientDataMode): ClientSession {
  return {
    dataMode,
    lastStateSentAt: 0,
    stateTimer: null,
    stateDirty: false,
    stateIncludeHistory: false,
  };
}

function normalizeClientDataMode(value: unknown): ClientDataMode {
  return value === "low" ? "low" : "full";
}

function resolveClientDataModeFromUrl(urlValue: string | undefined): ClientDataMode {
  if (!urlValue) return "full";
  try {
    const url = new URL(urlValue, `http://localhost:${PORT}`);
    return normalizeClientDataMode(url.searchParams.get("dataMode"));
  } catch {
    return "full";
  }
}

function getClientSession(ws: WebSocket): ClientSession {
  let session = clientSessions.get(ws);
  if (!session) {
    session = createClientSession("full");
    clientSessions.set(ws, session);
  }
  return session;
}

function clearStateTimer(session: ClientSession): void {
  if (session.stateTimer) {
    clearTimeout(session.stateTimer);
    session.stateTimer = null;
  }
}

function getStateIntervalMs(session: ClientSession): number {
  return session.dataMode === "low" ? LOW_DATA_STATE_INTERVAL_MS : FULL_DATA_STATE_INTERVAL_MS;
}

function shouldSendRealtimeEvent(type: string, ws: WebSocket, session: ClientSession): boolean {
  if (session.dataMode === "low" && (type === "chainlinkPrice" || type === "binancePrice")) {
    return false;
  }
  if ((type === "chainlinkPrice" || type === "binancePrice") && ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
    return false;
  }
  return true;
}

function broadcast(type: string, data: Record<string, unknown>): void {
  if (!wss) return;
  const msg = JSON.stringify({ type, ...data });
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const session = getClientSession(client);
    if (!shouldSendRealtimeEvent(type, client, session)) continue;
    client.send(msg);
  }
}

function trimHistory<T extends { t: number }>(points: T[], cutoff: number, maxPoints: number): void {
  while (points.length > 0 && points[0].t < cutoff) points.shift();
  if (points.length > maxPoints) points.splice(0, points.length - maxPoints);
}

function rememberBounded(set: Set<string>, order: string[], key: string, maxSize: number): boolean {
  if (set.has(key)) return false;
  set.add(key);
  order.push(key);
  while (order.length > maxSize) {
    const oldest = order.shift();
    if (oldest !== undefined) set.delete(oldest);
  }
  return true;
}

function prunePositionCaches(activeTokenIds: string[]): void {
  const keep = new Set(activeTokenIds.filter(Boolean));
  for (const store of [positions.localSize, positions.apiSize, positions.apiVerified]) {
    for (const key of Object.keys(store)) {
      if (!keep.has(key)) delete store[key];
    }
  }
}

function getDirectionTokenId(direction: StrategyDirection | null): string {
  if (direction === "up") return state.upTokenId;
  if (direction === "down") return state.downTokenId;
  return "";
}

function getDirectionLocalSize(direction: StrategyDirection | null): number {
  const tokenId = getDirectionTokenId(direction);
  return tokenId ? (positions.localSize[tokenId] ?? 0) : 0;
}

function getDirectionApiSize(direction: StrategyDirection | null): number {
  const tokenId = getDirectionTokenId(direction);
  return tokenId ? (positions.apiSize[tokenId] ?? 0) : 0;
}

function isDirectionVerified(direction: StrategyDirection | null): boolean {
  const tokenId = getDirectionTokenId(direction);
  return tokenId ? (positions.apiVerified[tokenId] ?? false) : false;
}

function hasOpenPosition(): boolean {
  return getDirectionLocalSize("up") > 0.01 || getDirectionLocalSize("down") > 0.01;
}

function hasEnoughUsdcForBuy(amount: number): boolean {
  if (positions.usdc == null || !Number.isFinite(amount)) return true;
  return positions.usdc + 1e-6 >= amount;
}

function hasPendingStrategyBuyLock(now = Date.now()): boolean {
  return now < strategyRuntime.buyLockUntil;
}

function getSellableShares(direction: StrategyDirection | null): number {
  const localSize = getDirectionLocalSize(direction);
  if (localSize <= 0) return 0;
  if (isDirectionVerified(direction)) return localSize;
  return Math.max(0, localSize - UNVERIFIED_SELL_BUFFER);
}

function getLatestBinancePrice(): number | null {
  const point = state.binanceHistory[state.binanceHistory.length - 1];
  return point?.price ?? null;
}

function getProbabilitySnapshot(): { upPct: number; dnPct: number } | null {
  if (!isProbabilityReady()) return null;
  const bid = Number(state.bestBid);
  const ask = Number(state.bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  const mid = (bid + ask) / 2;
  return {
    upPct: Math.round(mid * 100),
    dnPct: Math.round((1 - mid) * 100),
  };
}

function getStrategyDiff(): number | null {
  const latestBinancePrice = getLatestBinancePrice();
  if (latestBinancePrice == null || state.priceToBeat == null || state.binanceOffset == null) return null;
  return latestBinancePrice - (state.priceToBeat - state.binanceOffset);
}

function calcMedian(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function calcTrimmedMean(values: number[], trimRatio = 0.15): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const trim = sorted.length >= 8 ? Math.floor(sorted.length * trimRatio) : 0;
  const trimmed = trim > 0 ? sorted.slice(trim, sorted.length - trim) : sorted;
  if (!trimmed.length) return null;
  return trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length;
}

function calculateBinanceOffset(allowLatestFallback = false): number | null {
  if (!state.binanceHistory.length || !state.priceHistory.length) {
    if (!allowLatestFallback) return null;
    const latestBinancePrice = getLatestBinancePrice();
    if (latestBinancePrice == null || state.currentPrice == null) return null;
    return state.currentPrice - latestBinancePrice;
  }

  const now = Date.now();
  const binanceRecent = state.binanceHistory.filter((point) => point.t >= now - BINANCE_ALIGN_WINDOW_MS);
  const chainlinkRecent = state.priceHistory.filter((point) => point.t >= now - BINANCE_ALIGN_WINDOW_MS);
  if (!binanceRecent.length || !chainlinkRecent.length) {
    if (!allowLatestFallback) return null;
    const latestBinancePrice = getLatestBinancePrice();
    if (latestBinancePrice == null || state.currentPrice == null) return null;
    return state.currentPrice - latestBinancePrice;
  }

  const binanceSpan = binanceRecent.length >= 2
    ? binanceRecent[binanceRecent.length - 1].t - binanceRecent[0].t
    : 0;
  const chainlinkSpan = chainlinkRecent.length >= 2
    ? chainlinkRecent[chainlinkRecent.length - 1].t - chainlinkRecent[0].t
    : 0;

  if (Math.min(binanceSpan, chainlinkSpan) < BINANCE_ALIGN_MIN_SPAN_MS) {
    if (!allowLatestFallback) return null;
    return chainlinkRecent[chainlinkRecent.length - 1].price - binanceRecent[binanceRecent.length - 1].price;
  }

  const overlapStart = Math.max(binanceRecent[0].t, chainlinkRecent[0].t);
  const overlapEnd = Math.min(binanceRecent[binanceRecent.length - 1].t, chainlinkRecent[chainlinkRecent.length - 1].t);
  const diffs: number[] = [];

  if (overlapEnd - overlapStart >= BINANCE_ALIGN_BUCKET_MS * 2) {
    let binanceIdx = 0;
    let chainlinkIdx = 0;
    for (let bucketStart = overlapStart; bucketStart <= overlapEnd; bucketStart += BINANCE_ALIGN_BUCKET_MS) {
      const bucketEnd = bucketStart + BINANCE_ALIGN_BUCKET_MS;
      const binanceBucket: number[] = [];
      const chainlinkBucket: number[] = [];

      while (binanceIdx < binanceRecent.length && binanceRecent[binanceIdx].t < bucketStart) binanceIdx++;
      while (chainlinkIdx < chainlinkRecent.length && chainlinkRecent[chainlinkIdx].t < bucketStart) chainlinkIdx++;

      let i = binanceIdx;
      while (i < binanceRecent.length && binanceRecent[i].t < bucketEnd) {
        binanceBucket.push(binanceRecent[i].price);
        i++;
      }
      let j = chainlinkIdx;
      while (j < chainlinkRecent.length && chainlinkRecent[j].t < bucketEnd) {
        chainlinkBucket.push(chainlinkRecent[j].price);
        j++;
      }

      const binanceMedian = calcMedian(binanceBucket);
      const chainlinkMedian = calcMedian(chainlinkBucket);
      if (binanceMedian != null && chainlinkMedian != null) {
        diffs.push(chainlinkMedian - binanceMedian);
      }
    }
  }

  if (!diffs.length) {
    return chainlinkRecent[chainlinkRecent.length - 1].price - binanceRecent[binanceRecent.length - 1].price;
  }
  if (diffs.length < 5) {
    return calcTrimmedMean(diffs, 0);
  }

  const median = calcMedian(diffs);
  if (median == null) return null;
  const absDeviations = diffs.map((diff) => Math.abs(diff - median));
  const mad = calcMedian(absDeviations) ?? 0;
  const threshold = Math.max(10, mad * 3);
  const filtered = diffs.filter((diff) => Math.abs(diff - median) <= threshold);
  const stable = filtered.length >= 3 ? filtered : diffs;
  return calcTrimmedMean(stable, 0.15);
}

function refreshBinanceOffset(reason: string, options: { allowLatestFallback?: boolean; forceLog?: boolean } = {}): boolean {
  const nextOffset = calculateBinanceOffset(options.allowLatestFallback ?? false);
  if (nextOffset == null) return false;

  const prevOffset = state.binanceOffset;
  const changed = prevOffset == null || Math.abs(prevOffset - nextOffset) > BINANCE_OFFSET_EPSILON;
  state.binanceOffset = nextOffset;

  if (!changed) return true;

  if (options.forceLog || prevOffset == null) {
    const prefix = prevOffset == null ? "初始化偏移" : `${reason}更新`;
    console.log(`[BinanceOffset] ${prefix} ${nextOffset >= 0 ? "+" : ""}${nextOffset.toFixed(2)}`);
  }

  broadcastState();
  return true;
}

function maybeInitializeBinanceOffset(): void {
  if (state.binanceOffset != null) return;
  void refreshBinanceOffset("初始化", { allowLatestFallback: true, forceLog: true });
}

function resetStrategyRuntime(reason?: string): void {
  strategyRuntime.state = "IDLE";
  strategyRuntime.activeStrategy = null;
  strategyRuntime.direction = null;
  strategyRuntime.buyAmount = 0;
  strategyRuntime.posBeforeBuy = 0;
  strategyRuntime.posBeforeSell = 0;
  strategyRuntime.waitVerifyAfterSell = false;
  strategyRuntime.cleanupAfterVerify = false;
  strategyRuntime.actionTs = 0;
  strategyRuntime.prevUpPct = null;
  strategyRuntime.buyLockUntil = 0;
  strategyRuntime.roundEntryCount = 0;
  for (const s of getAllStrategies()) s.resetState();
  if (reason) console.log(`[Strategy] 重置: ${reason}`);
}

function strategyKeyOf(strategy: StrategyNumber): StrategyKey {
  return `s${strategy}` as StrategyKey;
}

function transitionToDone(): void {
  if (strategyRuntime.roundEntryCount < strategyConfig.maxRoundEntries && anyStrategyEnabled()) {
    console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] 完成，回到扫描(${strategyRuntime.roundEntryCount}/${strategyConfig.maxRoundEntries})`);
    strategyRuntime.state = "SCANNING";
    strategyRuntime.activeStrategy = null;
    strategyRuntime.direction = null;
    strategyRuntime.buyAmount = 0;
    strategyRuntime.posBeforeBuy = 0;
    strategyRuntime.posBeforeSell = 0;
    strategyRuntime.waitVerifyAfterSell = false;
    strategyRuntime.cleanupAfterVerify = false;
    strategyRuntime.actionTs = 0;
  } else {
    strategyRuntime.state = "DONE";
  }
  broadcastState();
}

function anyStrategyEnabled(): boolean {
  return ALL_STRATEGY_KEYS.some((key) => strategyConfig.enabled[key]);
}

function hasConfirmedBuyPosition(): boolean {
  return strategyRuntime.direction != null
    && getDirectionLocalSize(strategyRuntime.direction) > strategyRuntime.posBeforeBuy + 0.01;
}

function canReleaseUnconfirmedBuy(now = Date.now()): boolean {
  if (now - strategyRuntime.actionTs < FILL_RECONCILE_TIMEOUT_MS) return false;
  if (!strategyRuntime.direction) return true;
  if ((positions.lastApiSyncAt ?? 0) <= strategyRuntime.actionTs) return false;
  return getDirectionApiSize(strategyRuntime.direction) <= strategyRuntime.posBeforeBuy + 0.01;
}


function buildStrategyRuntimePayload(): Record<string, unknown> {
  const perStrategy: Record<string, Record<string, unknown>> = {};
  for (const s of getAllStrategies()) {
    perStrategy[s.key] = s.getStatePayload();
  }
  return {
    state: strategyRuntime.state,
    activeStrategy: strategyRuntime.activeStrategy,
    direction: strategyRuntime.direction,
    buyAmount: strategyRuntime.buyAmount,
    posBeforeBuy: strategyRuntime.posBeforeBuy,
    posBeforeSell: strategyRuntime.posBeforeSell,
    waitVerifyAfterSell: strategyRuntime.waitVerifyAfterSell,
    cleanupAfterVerify: strategyRuntime.cleanupAfterVerify,
    actionTs: strategyRuntime.actionTs,
    prevUpPct: strategyRuntime.prevUpPct,
    buyLockUntil: strategyRuntime.buyLockUntil,
    positionsReady: strategyRuntime.positionsReady,
    roundEntryCount: strategyRuntime.roundEntryCount,
    perStrategy,
  };
}

/** 计算当前合理概率（供 s5/s10/s11 前端面板实时展示） */
function computeFairProbPayload(): {
  diff: number | null;
  rem: number;
  upPct: number | null;
  fairUp: number | null;
  biasUp: number | null;
} | null {
  const diff = getStrategyDiff();
  const rem = getStrategyRemainingSeconds();
  const snap = getProbabilitySnapshot();
  if (diff == null || !snap) return { diff, rem, upPct: snap?.upPct ?? null, fairUp: null, biasUp: null };
  const fairUp = getFairProb(diff, rem);
  const biasUp = fairUp != null ? fairUp - snap.upPct : null;
  return { diff, rem, upPct: snap.upPct, fairUp, biasUp };
}

function buildStatePayload(options: boolean | StatePayloadOptions = false): Record<string, unknown> {
  const normalized = typeof options === "boolean" ? { includeHistory: options } : options;
  const includeHistory = normalized.includeHistory === true;
  const simple = normalized.simple === true;
  const bids = [...state.bids.entries()]
    .map(([price, size]) => ({ price: Number(price), size: Number(size) }))
    .sort((a, b) => b.price - a.price).slice(0, 8);
  const asks = [...state.asks.entries()]
    .map(([price, size]) => ({ price: Number(price), size: Number(size) }))
    .sort((a, b) => a.price - b.price).slice(0, 8);

  const payload: Record<string, unknown> = {
    windowStart:  state.windowStart,
    windowEnd:    state.windowEnd,
    bestBid:      state.bestBid,
    bestAsk:      state.bestAsk,
    downBestBid:  state.downBestBid,
    downBestAsk:  state.downBestAsk,
    probabilityReady: isProbabilityReady(),
    lastPrice:    state.lastPrice,
    lastSide:     state.lastSide,
    updatedAt:    state.updatedAt,
    priceToBeat:  state.priceToBeat,
    currentPrice: state.currentPrice,
    binanceOffset: state.binanceOffset,
    klineCounts: { k1m: state.kline1m.length, k5m: state.kline5m.length },
    binanceDiff: getStrategyDiff(),
    fairProb: computeFairProbPayload(),
    usdc:           positions.usdc,
    usdcAllowanceStatus: positions.usdcAllowanceStatus,
    usdcAllowanceMin: positions.usdcAllowanceMin,
    upLocalSize:    positions.localSize[state.upTokenId]   ?? 0,
    downLocalSize:  positions.localSize[state.downTokenId] ?? 0,
    upApiSize:      positions.apiSize[state.upTokenId]     ?? 0,
    downApiSize:    positions.apiSize[state.downTokenId]   ?? 0,
    upApiVerified:  positions.apiVerified[state.upTokenId]   ?? false,
    downApiVerified:positions.apiVerified[state.downTokenId] ?? false,
    lastTradeAt:    positions.lastTradeAt,
    lastApiSyncAt:  positions.lastApiSyncAt,
    runtimeMode:    APP_MODE,
    strategyConfig,
    strategy:       buildStrategyRuntimePayload(),
    ts: Date.now(),
  };
  if (!simple) {
    payload.conditionId = state.conditionId;
    payload.upTokenId = state.upTokenId;
    payload.downTokenId = state.downTokenId;
    payload.bids = bids;
    payload.asks = asks;
    payload.usdcAllowanceDetails = positions.usdcAllowanceDetails;
  }
  if (includeHistory && !simple) {
    payload.priceHistory = state.priceHistory;
    payload.binanceHistory = state.binanceHistory;
  }
  return payload;
}

function sendStateToClient(ws: WebSocket, options: { includeHistory?: boolean } = {}): void {
  const session = getClientSession(ws);
  const simple = session.dataMode === "low";
  send(ws, "state", buildStatePayload({
    includeHistory: options.includeHistory === true && !simple,
    simple,
  }));
  session.lastStateSentAt = Date.now();
}

function scheduleStateToClient(ws: WebSocket, includeHistory = false): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const session = getClientSession(ws);
  session.stateDirty = true;
  session.stateIncludeHistory = session.stateIncludeHistory || includeHistory;
  if (session.stateTimer) return;
  const elapsed = Date.now() - session.lastStateSentAt;
  const waitMs = Math.max(0, getStateIntervalMs(session) - elapsed);
  session.stateTimer = setTimeout(() => {
    const latestSession = clientSessions.get(ws);
    if (!latestSession) return;
    latestSession.stateTimer = null;
    if (!latestSession.stateDirty || ws.readyState !== WebSocket.OPEN) return;
    const nextIncludeHistory = latestSession.stateIncludeHistory;
    latestSession.stateDirty = false;
    latestSession.stateIncludeHistory = false;
    if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      latestSession.stateDirty = true;
      latestSession.stateIncludeHistory = nextIncludeHistory;
      scheduleStateToClient(ws, nextIncludeHistory);
      return;
    }
    sendStateToClient(ws, { includeHistory: nextIncludeHistory });
  }, waitMs);
}

function broadcastState(includeHistory = false): void {
  if (!wss) return;
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    scheduleStateToClient(client, includeHistory);
  }
}

function applyClientConfig(ws: WebSocket, raw: unknown): void {
  if (!isRecord(raw) || raw.type !== "clientConfig") return;
  const session = getClientSession(ws);
  const nextMode = normalizeClientDataMode(raw.dataMode);
  if (session.dataMode === nextMode) return;
  session.dataMode = nextMode;
  session.stateDirty = false;
  session.stateIncludeHistory = false;
  clearStateTimer(session);
  console.log(`[WS] 客户端数据模式切换为 ${nextMode}`);
  send(ws, "clientConfig", { dataMode: nextMode });
  sendStateToClient(ws, { includeHistory: true });
}

async function fetchBookTopOfBook(tokenId: string): Promise<{ bestBid: number; bestAsk: number }> {
  const book = await fetch(`${CLOB_URL}/book?token_id=${tokenId}`).then(r => r.json()) as {
    bids?: { price: string }[]; asks?: { price: string }[];
  };
  const bids = (book.bids || []).map(b => Number(b.price)).filter(p => p > 0);
  const asks = (book.asks || []).map(a => Number(a.price)).filter(p => p > 0);
  return {
    bestBid: bids.length ? Math.max(...bids) : 0,
    bestAsk: asks.length ? Math.min(...asks) : 0,
  };
}

// ── Gamma API ─────────────────────────────────────────────────
async function fetchMarket(windowStart: number): Promise<{
  conditionId: string; upTokenId: string; downTokenId: string;
  windowStart: number; windowEnd: number;
  eventStartTime: string; endDate: string;
} | null> {
  const slug = `btc-updown-5m-${windowStart}`;
  const startedAt = Date.now();
  try {
    const res = await fetch(`${GAMMA_URL}/events?slug=${slug}`);
    const events = await res.json() as Record<string, unknown>[];
    if (!events?.length) {
      console.warn(`[Window] 市场未找到 slug=${slug} 耗时:${Date.now() - startedAt}ms`);
      return null;
    }
    const event = events[0];
    const market = ((event.markets || []) as Record<string, unknown>[])[0];
    if (!market) {
      console.warn(`[Window] 市场缺少盘口 slug=${slug} 耗时:${Date.now() - startedAt}ms`);
      return null;
    }
    const tokens   = JSON.parse(market.clobTokenIds as string || "[]") as string[];
    const outcomes = JSON.parse(market.outcomes     as string || "[]") as string[];
    const upIdx    = outcomes.findIndex((o) => o.toLowerCase() === "up");
    return {
      conditionId:    market.conditionId as string,
      upTokenId:      tokens[upIdx >= 0 ? upIdx : 0],
      downTokenId:    tokens[upIdx >= 0 ? 1 - upIdx : 1],
      windowStart,
      windowEnd:      windowStart + 300,
      eventStartTime: market.eventStartTime as string || new Date(windowStart * 1000).toISOString(),
      endDate:        market.endDate        as string || new Date((windowStart + 300) * 1000).toISOString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Window] 市场查询失败 slug=${slug} 耗时:${Date.now() - startedAt}ms 原因:${msg}`);
    return null;
  }
}

// ── 基准价 ────────────────────────────────────────────────────
async function fetchCryptoPrice(eventStartTime: string, endDate: string): Promise<void> {
  try {
    const url = `https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime=${encodeURIComponent(eventStartTime)}&variant=fiveminute&endDate=${encodeURIComponent(endDate)}`;
    const data = await fetch(url).then(r => r.json()) as { openPrice?: number };
    if (data.openPrice != null) state.priceToBeat = data.openPrice;
  } catch { /* 静默 */ }
}

// ── 持仓 API 查询 ──────────────────────────────────────────────
async function syncPositionsFromApi(): Promise<boolean> {
  if (!PROXY_ADDRESS) {
    strategyRuntime.positionsReady = true;
    return true;
  }
  try {
    const pos = await fetch(
      `https://data-api.polymarket.com/positions?user=${PROXY_ADDRESS}&sizeThreshold=0.01`
    ).then(r => r.json()) as Array<{ asset: string; size: number }>;
    const apiMap: Record<string, number> = {};
    for (const p of pos) { apiMap[p.asset] = p.size; positions.apiSize[p.asset] = p.size; }
    for (const tokenId of [state.upTokenId, state.downTokenId]) {
      if (!tokenId) continue;
      if (!(tokenId in apiMap)) positions.apiSize[tokenId] = 0;
      const apiVal   = apiMap[tokenId] ?? 0;
      const localVal = positions.localSize[tokenId] ?? 0;
      const msSinceTrade = Date.now() - (positions.lastTradeAt ?? 0);
      if (msSinceTrade < POST_TRADE_CALIBRATION_MS) continue;
      if (Math.abs(apiVal - localVal) <= 0.5) {
        positions.localSize[tokenId]   = apiVal;
        positions.apiVerified[tokenId] = true;
      }
    }
    positions.lastApiSyncAt = Date.now();
    strategyRuntime.positionsReady = true;
    return true;
  } catch {
    return false;
  }
}

// ── USDC 余额查询 ──────────────────────────────────────────────
async function syncUsdcBalance(): Promise<void> {
  if (!PROXY_ADDRESS) return;
  try {
    if (!(await ensureClobClient())) return;
    const resp = await clobClient!.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }) as {
      balance?: string;
      allowance?: string;
      allowances?: Record<string, string>;
    };

    positions.usdc = resp.balance != null ? parseFloat(ethers.formatUnits(resp.balance, 6)) : null;

    const allowanceMap = resp.allowances && typeof resp.allowances === "object"
      ? Object.entries(resp.allowances)
      : resp.allowance != null
        ? [["default", resp.allowance]]
        : [];

    const details = allowanceMap.map(([spender, raw]) => {
      const amount = raw != null ? parseFloat(ethers.formatUnits(raw, 6)) : null;
      return { spender, amount: Number.isFinite(amount) ? amount : null };
    });

    positions.usdcAllowanceDetails = details;

    if (!details.length) {
      positions.usdcAllowanceStatus = "未授权";
      positions.usdcAllowanceMin = null;
      return;
    }

    const positiveCount = details.filter((item) => (item.amount ?? 0) > 0).length;
    const minAllowance = details.reduce<number | null>((min, item) => {
      if (item.amount == null) return min;
      return min == null ? item.amount : Math.min(min, item.amount);
    }, null);

    positions.usdcAllowanceMin = minAllowance;
    positions.usdcAllowanceStatus = positiveCount === 0
      ? "未授权"
      : positiveCount === details.length
        ? "已授权"
        : "未完全授权";
  } catch (e) {
    console.error("[USDC] 余额/授权查询失败:", e instanceof Error ? (e as any).shortMessage ?? e.message : String(e));
  }
}

// ── 退避重连工具 ──────────────────────────────────────────────
function backoffDelay(attempt: number): number {
  const delays = [0, 1000, 2000, 4000, 8000, 30000];
  return delays[Math.min(attempt, delays.length - 1)];
}

// ── User WS（监听成交） ────────────────────────────────────────
let userWs: WebSocket | null = null;
let userWsPingTimer: ReturnType<typeof setInterval> | null = null;
let userWsAttempt = 0;

function startUserWs(): void {
  if (!existsSync(CREDS_FILE)) { console.log("[UserWS] 未找到凭证文件，跳过"); return; }
  const creds = JSON.parse(readFileSync(CREDS_FILE, "utf-8")) as {
    key: string; secret: string; passphrase: string;
  };

  userWs = new WebSocket(USER_WS_URL);

  userWs.on("open", () => {
    console.log(userWsAttempt === 0 ? "[UserWS] 已连接" : "[UserWS] 重连成功");
    userWsAttempt = 0;
    wsStatus.user = true; broadcastWsStatus();
    userWs!.send(JSON.stringify({
      auth: { apiKey: creds.key, secret: creds.secret, passphrase: creds.passphrase },
      type: "user",
    }));
    userWsPingTimer = setInterval(() => {
      if (userWs?.readyState === WebSocket.OPEN) userWs.send("PING");
    }, 10000);
  });

  userWs.on("message", (data) => {
    const msg = data.toString();
    if (msg === "PONG") return;
    try {
      const arr = JSON.parse(msg);
      const events = Array.isArray(arr) ? arr : [arr];
      for (const evt of events) {
        if (!isRecord(evt)) continue;
        if ((evt.type === "TRADE" || evt.event_type === "trade") && evt.status === "MINED") {
          const tradeId = evt.id as string;
          if (!rememberBounded(positions.confirmedIds, positions.confirmedIdOrder, tradeId, MAX_CONFIRMED_TRADE_IDS)) continue;
          const assetId = typeof evt.asset_id === "string" ? evt.asset_id : "";
          const side = normalizeTradeSide(evt.side);
          const candidateIds = _extractCandidateOrderIds(evt);
          const ownFill = extractOwnFillFromEvt(evt, candidateIds);
          const size = ownFill?.size ?? (typeof evt.size === "number" ? evt.size : parseFloat(String(evt.size ?? "")));
          const price = ownFill?.price ?? (typeof evt.price === "number" ? evt.price : parseFloat(String(evt.price ?? "")));
          const orderId = ownFill?.matchedOrderId ?? candidateIds[0];
          if (!assetId || !side || !Number.isFinite(size) || size <= 0) continue;
          const pendingMeta = consumePendingTradeMeta(evt);
          const gtcFollowBuyDelta = pendingMeta?.gtcFollowBuyDelta;
          const direction = pendingMeta?.direction ?? getDirectionByAssetId(assetId);
          const txHash = typeof evt.transaction_hash === "string" && evt.transaction_hash
            ? evt.transaction_hash
            : undefined;
          // WS 事件可能落在互补 token 上，仓位必须更新到实际买入的 outcome token
          const positionTokenId = direction ? getDirectionTokenId(direction) : assetId;
          if (positionTokenId) {
            if (!(positionTokenId in positions.localSize)) positions.localSize[positionTokenId] = 0;
            positions.localSize[positionTokenId] = side === "buy"
              ? positions.localSize[positionTokenId] + size
              : Math.max(0, positions.localSize[positionTokenId] - size);
            positions.apiVerified[positionTokenId] = false;
          }
          positions.lastTradeAt = parseTradeEventTimestamp(evt);
          if (direction && Number.isFinite(price) && price > 0) {
            recordTradeHistory({
              ts: positions.lastTradeAt,
              windowStart: pendingMeta?.windowStart ?? state.windowStart,
              side,
              direction,
              amount: size,
              price,
              worstPrice: pendingMeta?.worstPrice ?? null,
              status: "MINED",
              source: pendingMeta?.source ?? "manual",
              txHash,
              orderId,
              exitReason: pendingMeta?.exitReason,
              roundEntry: pendingMeta?.roundEntry,
            });
          }
          console.log(
            `[UserWS] MINED ${side.toUpperCase()} ${size.toFixed(4)} @ ${Number.isFinite(price) ? price : "-"}`
            + ` asset: ...${assetId.slice(-6)}`
            + `${orderId ? ` order:${orderId.slice(0, 12)}...` : ""}`
            + `${txHash ? ` tx:${txHash.slice(0, 10)}...` : ""}`
            + `${ownFill && ownFill.matchedOrderId ? ` ownFill` : " eventFill"}`
          );
          broadcastState();

          if (
            pendingMeta?.side === "buy"
            && gtcFollowBuyDelta != null
            && pendingMeta?.source === "manual-gtc"
            && direction
          ) {
            const resolved = resolveGtcFollowOutcomeFill({
              direction,
              evtAssetId: assetId,
              evtPrice: price,
              evtSize: size,
              pendingWorstPrice: pendingMeta.worstPrice,
              pendingAmount: pendingMeta.amount,
            });
            if (resolved) {
              void placeGtcFollowupSellAfterBuy({
                tokenId: resolved.tokenId,
                direction,
                fillPrice: resolved.fillPrice,
                wsFillSize: resolved.wsFillSize,
                priceBump: gtcFollowBuyDelta,
                txHash,
                orderId,
              });
            } else {
              console.warn("[Order:manual-gtc-follow] 无法解析 outcome 成交价/份额，跳过跟卖");
            }
          }

          // 买入后异步链上校准：WS 推送的 size 有 ~1% 偏差，用链上真实值修正
          if (side === "buy" && txHash && PROXY_ADDRESS && positionTokenId) {
            const wsSize = size;
            void (async () => {
              const realFill = await getRealFillFromTx(txHash, PROXY_ADDRESS);
              if (realFill == null) {
                console.log(`[ChainWatcher] ⚠ 校准失败 tx:${txHash.slice(0, 10)}... 将由 REST 兜底`);
                return;
              }
              const delta = realFill - wsSize;
              if (Math.abs(delta) < 0.000001) {
                console.log(`[ChainWatcher] ✓ 买入校准 ${positionTokenId.slice(-6)} WS:${wsSize} = 链上:${realFill}`);
              } else {
                positions.localSize[positionTokenId] = (positions.localSize[positionTokenId] ?? 0) + delta;
                console.log(`[ChainWatcher] ✓ 买入校准 ${positionTokenId.slice(-6)} WS:${wsSize} → 链上:${realFill} (delta:${delta >= 0 ? "+" : ""}${delta.toFixed(6)})`);
              }
              positions.apiSize[positionTokenId] = positions.localSize[positionTokenId];
              positions.apiVerified[positionTokenId] = true;
              broadcastState();
            })();
          }
        }
      }
    } catch { /* 忽略 */ }
  });

  userWs.on("close", () => {
    if (userWsPingTimer) clearInterval(userWsPingTimer);
    const delay = backoffDelay(userWsAttempt++);
    console.log(`[UserWS] 断开，${delay}ms 后重连 (第${userWsAttempt}次)`);
    wsStatus.user = false; broadcastWsStatus();
    if (!stopped) setTimeout(startUserWs, delay);
  });
  userWs.on("error", (err) => { console.error("[UserWS] 错误:", err.message); });
}

// ── Market WS ─────────────────────────────────────────────────
let marketWs: WebSocket | null = null;
let marketPingTimer:   ReturnType<typeof setInterval> | null = null;
let marketRenderTimer: ReturnType<typeof setInterval> | null = null;
let marketValidationTimer: ReturnType<typeof setInterval> | null = null;
let lastBestBidAskTimestamp = 0;
let lastDownBestBidAskTimestamp = 0;
let bestBidAskPausedUntil = 0;
let marketValidationMismatchStreak = 0;
let marketReconnectPending = false;
let marketBestReady = false;

function isProbabilityReady(now = Date.now()): boolean {
  if (!wsStatus.market) return false;
  if (!marketBestReady) return false;
  if (now < bestBidAskPausedUntil) return false;
  const bid = Number(state.bestBid);
  const ask = Number(state.bestAsk);
  return Number.isFinite(bid) && Number.isFinite(ask);
}

function parseEventTimestamp(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function applyBestBidAskUpdate(
  bestBid: unknown,
  bestAsk: unknown,
  timestamp: unknown,
): boolean {
  if (typeof bestBid !== "string" || typeof bestAsk !== "string") return false;
  if (Date.now() < bestBidAskPausedUntil) return false;
  const ts = parseEventTimestamp(timestamp);
  if (ts > 0 && ts < lastBestBidAskTimestamp) return false;
  if (ts > 0) lastBestBidAskTimestamp = ts;
  state.bestBid = bestBid;
  state.bestAsk = bestAsk;
  marketBestReady = true;
  scheduleStrategyTick();  // 盘口更新（概率变化）立即触发策略检查
  return true;
}

function applyDownBestBidAskUpdate(
  bestBid: unknown,
  bestAsk: unknown,
  timestamp: unknown,
): boolean {
  if (typeof bestBid !== "string" || typeof bestAsk !== "string") return false;
  if (Date.now() < bestBidAskPausedUntil) return false;
  const ts = parseEventTimestamp(timestamp);
  if (ts > 0 && ts < lastDownBestBidAskTimestamp) return false;
  if (ts > 0) lastDownBestBidAskTimestamp = ts;
  state.downBestBid = bestBid;
  state.downBestAsk = bestAsk;
  return true;
}

function clearProbabilityForMs(ms: number, reason: string): void {
  const until = Date.now() + ms;
  if (until > bestBidAskPausedUntil) bestBidAskPausedUntil = until;
  marketBestReady = false;
  lastBestBidAskTimestamp = 0;
  lastDownBestBidAskTimestamp = 0;
  state.bestBid = "-";
  state.bestAsk = "-";
  state.downBestBid = "-";
  state.downBestAsk = "-";
  state.updatedAt = Date.now();
  console.warn(`[概率校验] ${reason}，清空概率 ${ms}ms`);
  broadcastState();
}

function requestMarketReconnect(reason: string, options?: { clearProbabilityMs?: number }): void {
  clearProbabilityForMs(options?.clearProbabilityMs ?? 0, reason);
  marketValidationMismatchStreak = 0;
  if (marketReconnectPending) return;
  marketReconnectPending = true;
  console.warn(`[MarketWS] 触发重连: ${reason}`);
  if (marketWs) {
    marketWs.close();
    return;
  }
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    void subscribeWindow(Math.max(subscribedWindow, getCurrentWindowStart()));
  }, 1000);
}

async function validateMarketProbability(expectedWindowStart: number, upTokenId: string): Promise<void> {
  if (marketReconnectPending) return;
  if (subscribedWindow !== expectedWindowStart) return;
  if (!marketWs || marketWs.readyState !== WebSocket.OPEN) return;

  try {
    const { bestBid, bestAsk } = await fetchBookTopOfBook(upTokenId);
    if (subscribedWindow !== expectedWindowStart || upTokenId !== state.upTokenId) return;
    if (!(bestBid > 0) || !(bestAsk > 0)) return;

    const wsBid = Number(state.bestBid);
    const wsAsk = Number(state.bestAsk);
    if (!Number.isFinite(wsBid) || !Number.isFinite(wsAsk)) return;

    const restMid = (bestBid + bestAsk) / 2;
    const wsMid = (wsBid + wsAsk) / 2;
    const diffPct = Math.abs(restMid - wsMid) * 100;

    if (diffPct > 3) {
      marketValidationMismatchStreak++;
      console.warn(`[概率校验] REST偏差 ${diffPct.toFixed(2)}%，连续 ${marketValidationMismatchStreak}/3`);
      if (marketValidationMismatchStreak >= 3) {
        requestMarketReconnect(`概率连续3次偏差>${3}%`);
      }
      return;
    }

    marketValidationMismatchStreak = 0;
  } catch (err) {
    if (subscribedWindow !== expectedWindowStart || upTokenId !== state.upTokenId) return;
    requestMarketReconnect(
      `REST校验失败: ${err instanceof Error ? err.message : String(err)}`,
      { clearProbabilityMs: 2000 },
    );
  }
}

let _marketWsConnectedOnce = false;
function startMarketWs(expectedWindowStart: number, upTokenId: string, downTokenId: string, onClose: () => void): WebSocket {
  const ws = new WebSocket(MARKET_WS_URL);
  ws.on("open", () => {
    if (ws !== marketWs || subscribedWindow !== expectedWindowStart) return;
    console.log(_marketWsConnectedOnce ? "[MarketWS] 重连成功" : "[MarketWS] 已连接");
    _marketWsConnectedOnce = true;
    marketReconnectPending = false;
    marketValidationMismatchStreak = 0;
    marketBestReady = false;
    wsStatus.market = true; broadcastWsStatus();
    ws.send(JSON.stringify({
      assets_ids: [upTokenId, downTokenId],
      type: "market",
      custom_feature_enabled: true,
    }));
    marketRenderTimer = setInterval(broadcastState, 1000);
    marketValidationTimer = setInterval(() => {
      void validateMarketProbability(expectedWindowStart, upTokenId);
    }, 1000);
    marketPingTimer   = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("PING");
    }, 10000);
  });
  ws.on("message", (data) => {
    if (ws !== marketWs || subscribedWindow !== expectedWindowStart || state.upTokenId !== upTokenId) return;
    const msg = data.toString();
    if (msg === "PONG" || msg === "[]") return;
    try {
      const events = Array.isArray(JSON.parse(msg)) ? JSON.parse(msg) : [JSON.parse(msg)];
      for (const evt of events) {
        if (evt.bids !== undefined && evt.asks !== undefined) {
          if (evt.asset_id && evt.asset_id !== upTokenId) continue;
          state.bids.clear(); state.asks.clear();
          for (const b of (evt.bids as { price: string; size: string }[])) {
            if (Number(b.size) > 0) state.bids.set(b.price, b.size);
          }
          for (const a of (evt.asks as { price: string; size: string }[])) {
            if (Number(a.size) > 0) state.asks.set(a.price, a.size);
          }
          state.updatedAt = Date.now();
          broadcastState();
        } else if (evt.event_type === "best_bid_ask") {
          const aid = typeof evt.asset_id === "string" ? evt.asset_id : "";
          let updated = false;
          if (aid === upTokenId) {
            if (applyBestBidAskUpdate(evt.best_bid, evt.best_ask, evt.timestamp)) updated = true;
          } else if (aid === downTokenId) {
            if (applyDownBestBidAskUpdate(evt.best_bid, evt.best_ask, evt.timestamp)) updated = true;
          }
          if (!updated) continue;
          state.updatedAt = Date.now();
          broadcastState();
        } else if (evt.event_type === "price_change" && evt.price_changes) {
          for (const change of evt.price_changes as Record<string, string>[]) {
            if (change.asset_id !== upTokenId) continue;
            if (change.price && change.size !== undefined) {
              state.lastPrice = Number(change.price).toFixed(2);
              state.lastSide  = change.side;
              // 同步更新盘口深度
              const size = Number(change.size);
              const map = change.side === 'BUY' ? state.bids : state.asks;
              if (size > 0) map.set(change.price, change.size);
              else map.delete(change.price);
            }
          }
          state.updatedAt = Date.now();
          broadcastState();
        }
      }
    } catch { /* 忽略 */ }
  });
  ws.on("close", () => {
    if (ws !== marketWs || subscribedWindow !== expectedWindowStart) return;
    if (marketPingTimer)   clearInterval(marketPingTimer);
    if (marketRenderTimer) clearInterval(marketRenderTimer);
    if (marketValidationTimer) {
      clearInterval(marketValidationTimer);
      marketValidationTimer = null;
    }
    marketBestReady = false;
    state.bestBid = "-";
    state.bestAsk = "-";
    state.downBestBid = "-";
    state.downBestAsk = "-";
    state.updatedAt = Date.now();
    console.log("[MarketWS] 连接断开，1秒后重连");
    wsStatus.market = false; broadcastWsStatus();
    broadcastState();
    broadcast("marketDown", {});
    onClose();
  });
  ws.on("error", (err) => { console.error("[MarketWS] 错误:", err.message); });
  return ws;
}

// ── Chainlink WS ──────────────────────────────────────────────
let chainlinkWs: WebSocket | null = null;

function startChainlinkWs(expectedWindowStart: number, eventSlug: string, onClose: () => void, attempt = 0): WebSocket {
  const ws = new WebSocket(CHAINLINK_WS_URL);
  ws.on("open", () => {
    if (ws !== chainlinkWs || subscribedWindow !== expectedWindowStart) return;
    console.log(attempt === 0 ? "[ChainlinkWS] 已连接" : "[ChainlinkWS] 重连成功");
    wsStatus.chainlink = true; broadcastWsStatus();
    ws.send(JSON.stringify({
      action: "subscribe",
      subscriptions: [
        { topic: "crypto_prices_chainlink", type: "update", filters: JSON.stringify({ symbol: "btc/usd" }) },
        { topic: "activity", type: "orders_matched", filters: JSON.stringify({ event_slug: eventSlug }) },
      ],
    }));
  });
  ws.on("message", (data) => {
    if (ws !== chainlinkWs || subscribedWindow !== expectedWindowStart) return;
    try {
      const msg = JSON.parse(data.toString()) as { topic?: string; type?: string; timestamp?: number; payload?: { value?: number; timestamp?: number } };
      if (msg.topic === "crypto_prices_chainlink" && msg.type === "update") {
        const val = msg.payload?.value;
        if (val != null) {
          state.currentPrice = val;
          const now = msg.payload?.timestamp ?? msg.timestamp ?? Date.now();
          state.priceHistory.push({ t: now, price: val });
          trimHistory(state.priceHistory, now - HISTORY_RETENTION_MS, MAX_CHAINLINK_HISTORY_POINTS);
          maybeInitializeBinanceOffset();
          broadcast("chainlinkPrice", { t: now, price: val });
          broadcastState();
          scheduleStrategyTick();  // 价格更新立即触发策略检查
        }
      }
    } catch { /* 忽略 */ }
  });
  ws.on("close", () => {
    if (ws !== chainlinkWs || subscribedWindow !== expectedWindowStart) return;
    const delay = backoffDelay(attempt);
    console.log(`[ChainlinkWS] 连接断开，${delay}ms 后重连 (第${attempt + 1}次)`);
    wsStatus.chainlink = false; broadcastWsStatus();
    broadcast("chainlinkDown", {});
    onClose();
  });
  ws.on("error", (err) => { console.error("[ChainlinkWS] 错误:", err.message); });
  return ws;
}

// ── 币安 WS ───────────────────────────────────────────────────
let binanceWs: WebSocket | null = null;
let binanceWsAttempt = 0;

function updateKlineArray(arr: Kline[], k: Kline, maxSize: number): void {
  const last = arr[arr.length - 1];
  if (last && last.openTime === k.openTime) {
    // 同一根 K 线更新中
    arr[arr.length - 1] = k;
  } else {
    arr.push(k);
    if (arr.length > maxSize) arr.splice(0, arr.length - maxSize);
  }
}

/** 从 Binance REST 拉取历史 K 线（用于启动预填充和重连后补缺口） */
async function fetchHistoricalKlines(interval: "1m" | "5m", limit: number): Promise<Kline[] | null> {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const raw = await res.json() as Array<Array<string | number>>;
    return raw.map((r) => ({
      openTime: Number(r[0]),
      open: parseFloat(String(r[1])),
      high: parseFloat(String(r[2])),
      low: parseFloat(String(r[3])),
      close: parseFloat(String(r[4])),
      volume: parseFloat(String(r[5])),
      closed: true,  // REST 返回的都是已收盘的
    }));
  } catch (err) {
    console.warn(`[Binance] 拉取历史 ${interval} K 线失败: ${(err as Error).message}`);
    return null;
  }
}

/** 合并历史 K 线到现有数组，去重并保留最新 maxSize 根 */
function mergeKlines(existing: Kline[], fetched: Kline[], maxSize: number): void {
  const map = new Map<number, Kline>();
  for (const k of existing) map.set(k.openTime, k);
  for (const k of fetched) {
    // 历史数据只在当前没有或为未收盘时覆盖
    const curr = map.get(k.openTime);
    if (!curr || !curr.closed) map.set(k.openTime, k);
  }
  const sorted = [...map.values()].sort((a, b) => a.openTime - b.openTime);
  existing.length = 0;
  const start = Math.max(0, sorted.length - maxSize);
  for (let i = start; i < sorted.length; i++) existing.push(sorted[i]);
}

async function loadHistoricalKlines(): Promise<void> {
  const [k1m, k5m] = await Promise.all([
    fetchHistoricalKlines("1m", MAX_KLINE_1M),
    fetchHistoricalKlines("5m", MAX_KLINE_5M),
  ]);
  if (k1m) {
    mergeKlines(state.kline1m, k1m, MAX_KLINE_1M);
    console.log(`[Binance] 1m K 线预填充 ${state.kline1m.length} 根`);
  }
  if (k5m) {
    mergeKlines(state.kline5m, k5m, MAX_KLINE_5M);
    console.log(`[Binance] 5m K 线预填充 ${state.kline5m.length} 根`);
  }
}

function startBinanceWs(): void {
  binanceWs = new WebSocket(BINANCE_WS_URL);
  binanceWs.on("open", () => {
    console.log(binanceWsAttempt === 0 ? "[BinanceWS] 已连接" : "[BinanceWS] 重连成功");
    binanceWsAttempt = 0;
    wsStatus.binance = true;
    broadcastWsStatus();
    // 连接成功后异步拉取历史 K 线，填充 / 补缺口
    void loadHistoricalKlines();
  });
  binanceWs.on("message", (data) => {
    try {
      const raw = JSON.parse(data.toString()) as { stream?: string; data?: Record<string, unknown> };
      const stream = raw.stream;
      const payload = raw.data;
      if (!stream || !payload) return;

      if (stream.endsWith("@aggTrade")) {
        const p = payload as { p?: string; T?: number };
        const price = parseFloat(p.p ?? "");
        const t = p.T ?? Date.now();
        if (!price) return;
        state.binanceHistory.push({ t, price });
        trimHistory(state.binanceHistory, t - HISTORY_RETENTION_MS, MAX_BINANCE_HISTORY_POINTS);
        maybeInitializeBinanceOffset();
        broadcast("binancePrice", { t, price });
        scheduleStrategyTick();  // 价格变化立即触发策略检查
        return;
      }

      if (stream.endsWith("@kline_1m") || stream.endsWith("@kline_5m")) {
        const kData = (payload as { k?: Record<string, unknown> }).k;
        if (!kData) return;
        const kline: Kline = {
          openTime: Number(kData.t),
          open: parseFloat(String(kData.o)),
          high: parseFloat(String(kData.h)),
          low: parseFloat(String(kData.l)),
          close: parseFloat(String(kData.c)),
          volume: parseFloat(String(kData.v)),
          closed: Boolean(kData.x),
        };
        if (stream.endsWith("@kline_1m")) {
          updateKlineArray(state.kline1m, kline, MAX_KLINE_1M);
        } else {
          updateKlineArray(state.kline5m, kline, MAX_KLINE_5M);
        }
        scheduleStrategyTick();  // K线更新立即触发策略检查
        return;
      }
    } catch { /* 忽略 */ }
  });
  binanceWs.on("close", () => {
    const delay = backoffDelay(binanceWsAttempt++);
    console.log(`[BinanceWS] 断开，${delay}ms 后重连 (第${binanceWsAttempt}次)`);
    wsStatus.binance = false; broadcastWsStatus();
    if (!stopped) setTimeout(startBinanceWs, delay);
  });
  binanceWs.on("error", (err) => { console.error("[BinanceWS] 错误:", err.message); });
}

// ── 最近4轮结果查询 ───────────────────────────────────────────
function parseResolvedOutcome(event: Record<string, unknown> | undefined): "up" | "down" | null {
  const market = ((event?.markets as Record<string, unknown>[] | undefined) || [])[0];
  if (!market) return null;

  let outcomes: string[] = [];
  let outcomePrices: string[] = [];

  try { outcomes = JSON.parse(String(market.outcomes || "[]")) as string[]; } catch { /* 忽略 */ }
  try { outcomePrices = JSON.parse(String(market.outcomePrices || "[]")) as string[]; } catch { /* 忽略 */ }

  if (!outcomes.length || outcomes.length !== outcomePrices.length) return null;

  const upIdx = outcomes.findIndex((o) => o.toLowerCase() === "up");
  const downIdx = outcomes.findIndex((o) => o.toLowerCase() === "down");
  if (upIdx < 0 || downIdx < 0) return null;

  const upPrice = Number(outcomePrices[upIdx]);
  const downPrice = Number(outcomePrices[downIdx]);
  if (!Number.isFinite(upPrice) || !Number.isFinite(downPrice)) return null;

  if (upPrice >= 0.999 && downPrice <= 0.001) return "up";
  if (downPrice >= 0.999 && upPrice <= 0.001) return "down";
  return null;
}

async function fetchRecentResults(currentWindow: number, immediate = false): Promise<void> {
  if (!immediate) await new Promise(r => setTimeout(r, 5000));
  if (stopped) return;
  try {
    const slugs = [1,2,3,4].map(i => `btc-updown-5m-${currentWindow - i * 300}`);
    const query = slugs.map(s => `slug=${s}`).join("&");
    const events = await fetch(`${GAMMA_URL}/events?${query}`).then(r => r.json()) as Record<string, unknown>[];
    const results = slugs.map(slug => {
      const event = events.find((e: Record<string, unknown>) => e.slug === slug) as Record<string, unknown> | undefined;
      const ws = parseInt(slug.split("-").pop()!);
      const timeRange = `${new Date(ws*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}→${new Date((ws+300)*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;
      const result = parseResolvedOutcome(event);
      return { timeRange, result };
    });
    const summary = results
      .map((item) => `${item.timeRange}${item.result === "up" ? "涨赢" : item.result === "down" ? "跌赢" : "待确认"}`)
      .join(" | ");
    console.log(`[Result] ${summary}`);
    broadcast("recentResults", { results });
  } catch (e) { console.error(`[Result] 请求失败:`, (e as Error).message); }
}

// ── 窗口切换 ──────────────────────────────────────────────────
let subscribedWindow = 0;
let stopped = false;
let switchTimer:    ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function disconnectWindowStreams(): void {
  const hadMarketFeed = !!marketWs || wsStatus.market;
  const hadChainlinkFeed = !!chainlinkWs || wsStatus.chainlink;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (marketPingTimer) {
    clearInterval(marketPingTimer);
    marketPingTimer = null;
  }
  if (marketRenderTimer) {
    clearInterval(marketRenderTimer);
    marketRenderTimer = null;
  }
  if (marketValidationTimer) {
    clearInterval(marketValidationTimer);
    marketValidationTimer = null;
  }
  if (marketWs) {
    marketWs.removeAllListeners("close");
    marketWs.close();
    marketWs = null;
  }
  if (chainlinkWs) {
    chainlinkWs.removeAllListeners("close");
    chainlinkWs.close();
    chainlinkWs = null;
  }
  if (wsStatus.market || wsStatus.chainlink) {
    wsStatus.market = false;
    wsStatus.chainlink = false;
    broadcastWsStatus();
  }
  if (hadMarketFeed) broadcast("marketDown", {});
  if (hadChainlinkFeed) broadcast("chainlinkDown", {});
}

function clearWindowRuntimeState(): void {
  state.bids.clear();
  state.asks.clear();
  state.bestBid = "-";
  state.bestAsk = "-";
  state.downBestBid = "-";
  state.downBestAsk = "-";
  state.lastPrice = "-";
  state.lastSide = "";
  state.priceToBeat = null;
  state.currentPrice = null;
  state.binanceOffset = null;
  state.updatedAt = Date.now();
  marketBestReady = false;
  marketValidationMismatchStreak = 0;
  bestBidAskPausedUntil = 0;
  strategyRuntime.positionsReady = !PROXY_ADDRESS;
  resetStrategyRuntime();
  broadcastState();
}

function getCurrentWindowStart(now = Date.now()): number {
  return Math.floor(now / 1000 / 300) * 300;
}

async function advanceToLiveWindow(targetWindowStart: number): Promise<void> {
  const switchStartedAt = Date.now();
  let attempt = 0;
  let clearedExpiredWindow = false;
  while (!stopped) {
    const desiredWindow = Math.max(targetWindowStart, getCurrentWindowStart());
    if (attempt === 0) {
      console.log(`[Window] 切换开始 ${subscribedWindow || "-"} -> ${desiredWindow}`);
    }
    if (!clearedExpiredWindow && desiredWindow > subscribedWindow) {
      disconnectWindowStreams();
      clearWindowRuntimeState();
      clearedExpiredWindow = true;
    }
    const subscribeStartedAt = Date.now();
    await subscribeWindow(desiredWindow);
    if (subscribedWindow === desiredWindow) {
      console.log(`[Window] 切换成功 windowStart=${desiredWindow} 耗时:${Date.now() - switchStartedAt}ms`);
      return;
    }

    const delay = Math.min(1000 * Math.max(++attempt, 1), 5000);
    console.warn(`[Window] 切换重试 windowStart=${desiredWindow} ${delay}ms 后继续`);
    await new Promise(r => setTimeout(r, delay));
  }
}

function scheduleNextWindow(windowEnd: number): void {
  if (switchTimer) clearTimeout(switchTimer);
  const msUntilEnd = windowEnd * 1000 - Date.now();
  switchTimer = setTimeout(async () => {
    if (stopped) return;
    await advanceToLiveWindow(windowEnd);
  }, Math.max(0, msUntilEnd));
}

async function subscribeWindow(windowStart: number): Promise<void> {
  const startedAt = Date.now();
  const info = await fetchMarket(windowStart);
  if (!info) {
    broadcast("error", { message: `未找到市场 windowStart=${windowStart}` });
    console.warn(`[Window] 订阅失败 windowStart=${windowStart} 耗时:${Date.now() - startedAt}ms`);
    return;
  }

  const isNewWindow = subscribedWindow !== windowStart;
  const prevWindowStart = subscribedWindow;
  subscribedWindow = windowStart;

  state.windowStart = info.windowStart; state.windowEnd   = info.windowEnd;
  state.upTokenId   = info.upTokenId;   state.downTokenId = info.downTokenId;
  state.conditionId = info.conditionId;
  state.bids.clear(); state.asks.clear();
  state.bestBid = "-"; state.bestAsk = "-";
  state.downBestBid = "-"; state.downBestAsk = "-";
  state.lastPrice = "-"; state.lastSide = "";
  state.binanceOffset = null;
  state.updatedAt = Date.now();
  lastBestBidAskTimestamp = 0;
  lastDownBestBidAskTimestamp = 0;
  marketBestReady = false;
  bestBidAskPausedUntil = 0;
  marketValidationMismatchStreak = 0;
  marketReconnectPending = false;

  if (isNewWindow) {
    if (prevWindowStart > 0) fetchRecentResults(windowStart);
    state.priceToBeat = null; state.currentPrice = null;
    strategyRuntime.positionsReady = !PROXY_ADDRESS;
    resetStrategyRuntime(`切换到窗口 ${windowStart}`);
    prunePositionCaches([info.upTokenId, info.downTokenId]);
    positions.localSize[info.upTokenId]     = 0;
    positions.localSize[info.downTokenId]   = 0;
    positions.apiSize[info.upTokenId]       = 0;
    positions.apiSize[info.downTokenId]     = 0;
    positions.apiVerified[info.upTokenId]   = false;
    positions.apiVerified[info.downTokenId] = false;
    const thisWindow = info.windowStart;
    const tryFetch = () => {
      if (stopped || subscribedWindow !== thisWindow) return;
      fetchCryptoPrice(info.eventStartTime, info.endDate).then(() => {
        if (state.priceToBeat == null && !stopped && subscribedWindow === thisWindow) setTimeout(tryFetch, 1000);
        else broadcastState();
      });
    };
    tryFetch();
    syncPositionsFromApi().then(() => broadcastState());
  }

  broadcast("window", {
    windowStart: info.windowStart, windowEnd: info.windowEnd,
    conditionId: info.conditionId, upTokenId: info.upTokenId, downTokenId: info.downTokenId,
  });

  if (marketWs || chainlinkWs || reconnectTimer) {
    disconnectWindowStreams();
  }

  marketWs = startMarketWs(info.windowStart, info.upTokenId, info.downTokenId, () => {
    if (stopped) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      void subscribeWindow(Math.max(subscribedWindow, getCurrentWindowStart()));
    }, 1000);
  });

  const eventSlug = `btc-updown-5m-${info.windowStart}`;
  let clAttempt = 0;
  const reconnectChainlink = () => {
    if (stopped) return;
    const delay = backoffDelay(clAttempt);
    clAttempt++;
    setTimeout(() => {
      if (stopped) return;
      chainlinkWs = startChainlinkWs(subscribedWindow, `btc-updown-5m-${subscribedWindow}`, reconnectChainlink, clAttempt);
    }, delay);
  };
  chainlinkWs = startChainlinkWs(info.windowStart, eventSlug, reconnectChainlink, 0);

  scheduleNextWindow(info.windowEnd);
}

// ── Claim 查询 ────────────────────────────────────────────────
interface ClaimPosition {
  conditionId: string; title: string; currentValue: number; size: number;
}
let claimablePositions: ClaimPosition[] = [];
let claimableTotal = 0;
let claimCycleTimer: ReturnType<typeof setTimeout> | null = null;
let claimCycleRunning = false;
let claimNextCheckAt = 0;
let claimCooldownUntil = 0;       // Claim 冷却截止时间戳（5 分钟）
let claimLastReason = "";         // 最近一次跳过的原因，供前端显示

function broadcastClaimCooldown(running = false): void {
  broadcast("claimCooldown", {
    running,
    nextCheckAt: claimNextCheckAt,
    cooldownUntil: claimCooldownUntil,
    reason: claimLastReason,
  });
}

function resetClaimableState(): void {
  claimablePositions = [];
  claimableTotal = 0;
  broadcast("claimable", { total: claimableTotal, positions: claimablePositions });
}

async function syncClaimable(options: { clearOnError?: boolean } = {}): Promise<boolean> {
  if (!PROXY_ADDRESS) {
    resetClaimableState();
    return false;
  }
  try {
    const pos = await fetch(
      `https://data-api.polymarket.com/positions?user=${PROXY_ADDRESS}&sizeThreshold=.01&redeemable=true&limit=100&offset=0`
    ).then(r => r.json()) as Array<{ conditionId: string; title: string; currentValue: number; size: number; curPrice: number }>;
    claimablePositions = pos.filter(p => p.curPrice === 1).map(p => ({
      conditionId: p.conditionId, title: p.title, currentValue: p.currentValue, size: p.size,
    }));
    claimableTotal = claimablePositions.reduce((s, p) => s + p.currentValue, 0);
    broadcast("claimable", { total: claimableTotal, positions: claimablePositions });
    return true;
  } catch (err) {
    if (options.clearOnError) resetClaimableState();
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Claim] 查询可领取仓位失败: ${msg}`);
    return false;
  }
}

function scheduleClaimCycle(delayMs = CLAIM_CYCLE_DELAY_MS): void {
  if (stopped || !PROXY_ADDRESS) {
    if (claimCycleTimer) clearTimeout(claimCycleTimer);
    claimCycleTimer = null;
    claimNextCheckAt = 0;
    broadcastClaimCooldown(false);
    return;
  }
  if (claimCycleTimer) clearTimeout(claimCycleTimer);
  claimNextCheckAt = Date.now() + Math.max(0, delayMs);
  broadcastClaimCooldown(false);
  claimCycleTimer = setTimeout(() => {
    void autoClaimCycle().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[自动Claim] 后台领取异常: ${msg}`);
      scheduleClaimCycle();
    });
  }, Math.max(0, delayMs));
}

async function autoClaimCycle(): Promise<void> {
  if (stopped || claimCycleRunning) return;
  claimCycleRunning = true;
  claimNextCheckAt = 0;
  broadcastClaimCooldown(true);
  try {
    // Step 1: 每次循环都查询最新可领取金额（高频刷新，前端显示实时）
    const synced = await syncClaimable({ clearOnError: true });
    if (!synced) return;

    // Step 2: 决定是否执行 claim
    if (!strategyConfig.autoClaimEnabled || !PRIVATE_KEY) {
      claimLastReason = "";
      return;
    }
    if (!claimablePositions.length || claimInProgress) {
      claimLastReason = "";
      return;
    }

    // 冷却期：上次 claim 后 5 分钟内不再执行
    if (Date.now() < claimCooldownUntil) {
      const remain = Math.ceil((claimCooldownUntil - Date.now()) / 1000);
      claimLastReason = `冷却中 剩余${remain}s`;
      return;
    }

    // 策略忙：入场/持仓/出场中 → 不触发 Safe 交易（避免 nonce 冲突）
    const strategyBusy = strategyRuntime.state !== "IDLE"
                      && strategyRuntime.state !== "DONE"
                      && strategyRuntime.state !== "SCANNING";
    if (strategyBusy || hasOpenPosition()) {
      claimLastReason = `策略忙(${strategyRuntime.state})`;
      console.log(`[自动Claim] ${claimLastReason}，跳过本次`);
      return;
    }

    // Step 3: claim 前再刷新一次金额（确保 conditionId 和数量最新）
    await syncClaimable({ clearOnError: false });
    if (!claimablePositions.length) {
      claimLastReason = "";
      return;
    }

    console.log(`[自动Claim] 检测到 ${claimablePositions.length} 个可领取仓位，后台开始领取...`);
    claimLastReason = "";
    claimCooldownUntil = Date.now() + CLAIM_COOLDOWN_MS;  // 进入冷却（无论下面成功失败）
    await runClaim({ refreshAfter: false });
  } finally {
    claimCycleRunning = false;
    scheduleClaimCycle();
  }
}

// ── Claim 核心逻辑 ───────────────────────────────────────────
let claimInProgress = false;

// 复用 provider：避免每次 claim 都 new 一个触发网络探测循环
// 用完整 Network 对象 + staticNetwork 对象版本，跳过启动时的 eth_chainId 探测
const CLAIM_NETWORK = new ethers.Network("polygon", 137);
let cachedClaimProvider: ethers.JsonRpcProvider | null = null;
function getClaimProvider(): ethers.JsonRpcProvider {
  if (!cachedClaimProvider) {
    cachedClaimProvider = new ethers.JsonRpcProvider(
      "https://polygon-bor-rpc.publicnode.com",
      CLAIM_NETWORK,
      { staticNetwork: CLAIM_NETWORK },
    );
    // 静默 RPC error（原来的 console.error 会反复打印相同错误）
    cachedClaimProvider.on("error", () => { /* 由调用方处理 */ });
  }
  return cachedClaimProvider;
}

async function runClaim(options: { refreshAfter?: boolean } = {}): Promise<{ title: string; txHash?: string; error?: string }[]> {
  const { refreshAfter = true } = options;
  if (!PROXY_ADDRESS || !PRIVATE_KEY) return [];
  if (claimInProgress) return [];
  if (!claimablePositions.length) return [];
  claimInProgress = true;

  const contracts = getContractConfig(137);
  const CTF = contracts.conditionalTokens;
  const USDC_ADDR = contracts.collateral;  // V2 升级后为 pUSD
  const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

  const provider = getClaimProvider();
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const ctfIface = new ethers.Interface([
    "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)"
  ]);
  const safeIface = new ethers.Interface([
    "function nonce() view returns (uint256)",
    "function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)",
    "function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool)",
  ]);
  const safe = new ethers.Contract(PROXY_ADDRESS, safeIface, wallet);

  const snapshot = [...claimablePositions];
  const total = snapshot.length;
  const results: { title: string; txHash?: string; error?: string }[] = [];
  console.log(`[Claim] 开始领取 共${total}个: ${snapshot.map(p => p.title).join(' | ')}`);
  try {
    for (let i = 0; i < snapshot.length; i++) {
      const p = snapshot[i];
      console.log(`[Claim] (${i+1}/${total}) ${p.title} 金额:${p.currentValue.toFixed(2)} conditionId:${p.conditionId}`);
      broadcast("claimProgress", { current: i, total, title: p.title, status: "running" });
      try {
        const calldata = ctfIface.encodeFunctionData("redeemPositions", [
          USDC_ADDR, ZERO_BYTES32, p.conditionId, [1, 2]
        ]);
        const nonce = await safe.nonce();
        console.log(`[Claim] nonce:${nonce} 构建交易中...`);
        const txHash = await safe.getTransactionHash(CTF, 0, calldata, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce);
        const sig = await wallet.signMessage(ethers.getBytes(txHash));
        const v = parseInt(sig.slice(-2), 16) + 4;
        const adjustedSig = sig.slice(0, -2) + v.toString(16).padStart(2, '0');
        console.log(`[Claim] 发送交易...`);
        const tx = await safe.execTransaction(CTF, 0, calldata, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, adjustedSig);
        console.log(`[Claim] 等待上链 txHash:${tx.hash}`);
        const receipt = await Promise.race([
          tx.wait(),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error('等待上链超时(30s)')), 30000)),
        ]);
        if (!receipt) throw new Error('等待上链超时(30s)');
        console.log(`[Claim] ✓ 成功 ${p.title} → ${tx.hash}`);
        results.push({ title: p.title, txHash: tx.hash });
        broadcast("claimProgress", { current: i + 1, total, title: p.title, status: "success" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Claim] ✗ 失败 ${p.title}: ${msg}`);
        results.push({ title: p.title, error: msg });
        broadcast("claimProgress", { current: i + 1, total, title: p.title, status: "error", error: msg });
      }
    }
  } finally {
    claimInProgress = false;
  }
  console.log(`[Claim] 完成 成功:${results.filter(r=>r.txHash).length} 失败:${results.filter(r=>r.error).length}`);
  if (refreshAfter) {
    await syncClaimable({ clearOnError: true });
    await syncUsdcBalance();
    broadcastState();
  }
  return results;
}

function extractOrderError(result: unknown): string {
  const obj = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const candidates = [obj.error, obj.message, obj.errorMsg, obj.errorMessage];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

/** CLOB 在链上 MINED 后条件 token 余额索引可能短暂滞后，可 refresh+重试 */
function isTransientClobBalanceOrAllowanceMessage(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("not enough balance") || m.includes("allowance") || m.includes("balance / allowance");
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmtOrderField(value: unknown): string {
  if (value == null || value === "") return "-";
  return String(value);
}

function getDecimalPlaces(value: string | number): number {
  const text = String(value);
  const [, decimals = ""] = text.split(".");
  return decimals.replace(/0+$/, "").length;
}

function floorToDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor((value + Number.EPSILON) * factor) / factor;
}

function isOrderWindowStale(now = Date.now()): boolean {
  if (!state.windowStart || !state.windowEnd) return true;
  if (state.windowEnd * 1000 <= now) return true;
  return state.windowStart < getCurrentWindowStart(now);
}

function getStrategyRemainingSeconds(now = Date.now()): number {
  return state.windowEnd ? state.windowEnd - Math.floor(now / 1000) : 0;
}

function buildTickContext(rem: number, upPct: number | null, dnPct: number | null, diff: number | null, now: number): import("./strategies/types.js").StrategyTickContext {
  return {
    rem, upPct, dnPct, diff, now,
    prevUpPct: strategyRuntime.prevUpPct,
    kline1m: state.kline1m,
    kline5m: state.kline5m,
    marketHoursOnly: strategyConfig.marketHoursOnly,
  };
}

function checkEntry(ctx: import("./strategies/types.js").StrategyTickContext): { strategy: StrategyNumber; dir: StrategyDirection } | null {
  for (const s of getAllStrategies()) {
    if (!strategyConfig.enabled[s.key]) continue;
    const signal = s.checkEntry(ctx);
    if (signal) return { strategy: s.number, dir: signal.direction };
  }
  return null;
}

function checkExit(ctx: import("./strategies/types.js").StrategyTickContext): import("./strategies/types.js").ExitSignal {
  const stratNum = strategyRuntime.activeStrategy;
  const direction = strategyRuntime.direction;
  if (!stratNum || !direction) return null;
  const key = strategyKeyOf(stratNum);
  const s = getStrategy(key);
  if (!s) return null;
  return s.checkExit(ctx, direction);
}

interface PlaceOrderInput {
  direction: StrategyDirection;
  side: "buy" | "sell";
  amount: number;
  slippage?: number;
  source?: string;
  exitReason?: string;
  roundEntry?: string;
}

interface OrderExecutionResult {
  success: boolean;
  statusCode: number;
  body: Record<string, unknown>;
  errorMessage?: string;
}

async function placeOrder(input: PlaceOrderInput): Promise<OrderExecutionResult> {
  const { direction, side, amount, source = "manual" } = input;
  const slippageVal = typeof input.slippage === "number" && input.slippage >= 0
    ? input.slippage
    : strategyConfig.slippage;
  const orderTag = `[Order:${source}]`;

  if (!direction || !side || !amount || amount <= 0) {
    return { success: false, statusCode: 400, body: { error: "参数错误" }, errorMessage: "参数错误" };
  }
  if (!(await ensureClobClient())) {
    return {
      success: false,
      statusCode: 500,
      body: { error: "CLOB 客户端未初始化，请检查 POLYMARKET_PRIVATE_KEY" },
      errorMessage: "CLOB 客户端未初始化，请检查 POLYMARKET_PRIVATE_KEY",
    };
  }
  if (isOrderWindowStale()) {
    return {
      success: false,
      statusCode: 409,
      body: { error: "当前市场窗口已过期，等待切换到新窗口" },
      errorMessage: "当前市场窗口已过期，等待切换到新窗口",
    };
  }
  if (!isProbabilityReady()) {
    return {
      success: false,
      statusCode: 409,
      body: { error: "盘口概率暂不可用，等待WS恢复" },
      errorMessage: "盘口概率暂不可用，等待WS恢复",
    };
  }

  const tokenId = direction === "up" ? state.upTokenId : state.downTokenId;
  if (!tokenId) {
    return {
      success: false,
      statusCode: 400,
      body: { error: "当前窗口市场未就绪" },
      errorMessage: "当前窗口市场未就绪",
    };
  }

  let bestBid = 0;
  let bestAsk = 0;
  try {
    ({ bestBid, bestAsk } = await fetchBookTopOfBook(tokenId));
  } catch {
    return {
      success: false,
      statusCode: 500,
      body: { error: "无法获取盘口价格" },
      errorMessage: "无法获取盘口价格",
    };
  }

  const worstPrice = side === "buy"
    ? Math.min(bestAsk + slippageVal, 0.99)
    : Math.max(bestBid - slippageVal, 0.01);

  try {
    const tickSize = await clobClient!.getTickSize(tokenId);
    const priceDecimals = getDecimalPlaces(tickSize);
    const normalizedAmount = floorToDecimals(amount, 2);
    const normalizedWorstPrice = floorToDecimals(worstPrice, priceDecimals);
    const orderDebug = `tickSize:${tickSize} amount:${amount}->${normalizedAmount} worstPrice:${worstPrice}->${normalizedWorstPrice}`;
    if (normalizedAmount <= 0 || normalizedWorstPrice <= 0) {
      console.warn(`${orderTag} 参数精度处理后无效 ${orderDebug}`);
      return {
        success: false,
        statusCode: 400,
        body: { error: "下单参数精度处理后无效", bestBid, bestAsk, worstPrice: normalizedWorstPrice },
        errorMessage: "下单参数精度处理后无效",
      };
    }

    const signedOrder = await clobClient!.createMarketOrder(
      { tokenID: tokenId, side: side === "buy" ? Side.BUY : Side.SELL, amount: normalizedAmount, price: normalizedWorstPrice },
      { tickSize, negRisk: false }
    );
    const result = await clobClient!.postOrder(signedOrder, OrderType.FOK);
    const sideZh = side === "buy" ? "买入" : "卖出";
    const dirZh = direction === "up" ? "涨" : "跌";
    const rawStatus = result?.status ?? "未知";
    const orderError = extractOrderError(result);

    if (result?.status === 400 || orderError) {
      console.warn(`${orderTag} ${sideZh}${dirZh} ${normalizedAmount} 状态:${rawStatus} 原因:${orderError || "-"} ${orderDebug}`);
      return {
        success: false,
        statusCode: 400,
        body: { error: orderError || `下单被拒绝 status=${rawStatus}`, result, bestBid, bestAsk, worstPrice: normalizedWorstPrice },
        errorMessage: orderError || `下单被拒绝 status=${rawStatus}`,
      };
    }

    const statusZh = rawStatus === "matched" ? "成功" : rawStatus;
    console.log(`${orderTag} ${sideZh}${dirZh} ${normalizedAmount} 状态:${statusZh} 成交:${fmtOrderField(result?.takingAmount)} 花费:${fmtOrderField(result?.makingAmount)} ${orderDebug}`);
    rememberPendingTradeMeta({
      orderId: typeof result?.orderID === "string" && result.orderID ? result.orderID : undefined,
      ts: Date.now(),
      windowStart: state.windowStart,
      side,
      direction,
      amount: normalizedAmount,
      worstPrice: normalizedWorstPrice,
      source,
      exitReason: input.exitReason,
      roundEntry: input.roundEntry,
    });
    if (!(typeof result?.orderID === "string" && result.orderID)) {
      console.warn(`${orderTag} 下单回包缺少 orderID，MINED 事件将退化为按方向/数量匹配`);
    }
    broadcastState();
    return {
      success: true,
      statusCode: 200,
      body: { success: true, result, bestBid, bestAsk, worstPrice: normalizedWorstPrice },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${orderTag} 失败:`, msg);
    return {
      success: false,
      statusCode: 500,
      body: { error: msg },
      errorMessage: msg,
    };
  }
}

const GTC_LIMIT_OFFSETS = [0.02, 0.1, 0.3] as const;
const GTC_FOLLOW_BUMP_VALUES = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3] as const;
/** 跟卖份额 = min(链上或WS成交, 本地仓) × 此系数，略小于真实可卖，减少拒单 */
const GTC_FOLLOW_SELL_SIZE_FACTOR = 0.997;

function isNearAllowedOffset(value: number, allowed: readonly number[]): boolean {
  return allowed.some((a) => Math.abs(a - value) < 1e-5);
}

function normalizeOpenOrderSide(raw: unknown): "buy" | "sell" | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (s === "buy") return "buy";
  if (s === "sell") return "sell";
  return null;
}

interface PlaceGtcOrderInput {
  direction: StrategyDirection;
  side: "buy" | "sell";
  shares: number;
  limitOffset: number;
  followBuyDelta?: number | null;
  source?: string;
}

/** 通过 REST 查询订单 size_matched，获取真实成交份额 */
async function fetchOrderSizeMatched(orderId: string): Promise<number | null> {
  if (!orderId || !(await ensureClobClient())) return null;
  try {
    const order = await clobClient!.getOrder(orderId);
    if (!order) return null;
    const data = (order as any)?.order ?? order;
    if (!data || typeof data !== "object") return null;
    const matched = (data as any).size_matched ?? (data as any).sizeMatched;
    if (matched == null || matched === "") return null;
    const val = parseFloat(String(matched));
    return Number.isFinite(val) && val > 0 ? val : null;
  } catch {
    return null;
  }
}

/** GTC 买单 MINED 后：挂限价卖（止盈），份额优先链上 TransferSingle / REST size_matched，并与本地仓位取小后再略缩 */
async function placeGtcFollowupSellAfterBuy(args: {
  tokenId: string;
  direction: StrategyDirection;
  fillPrice: number;
  wsFillSize: number;
  priceBump: number;
  txHash?: string;
  orderId?: string;
}): Promise<void> {
  const tag = "[Order:manual-gtc-follow]";
  const { tokenId, direction, fillPrice, wsFillSize, priceBump, txHash, orderId } = args;
  if (!(await ensureClobClient())) {
    console.warn(`${tag} CLOB 未初始化，跳过跟卖`);
    return;
  }
  if (isOrderWindowStale()) {
    console.warn(`${tag} 窗口已过期，跳过跟卖`);
    return;
  }
  if (!Number.isFinite(fillPrice) || !Number.isFinite(wsFillSize) || wsFillSize <= 0) return;

  let baseShares = wsFillSize;

  // 1) 优先链上 receipt
  if (txHash && PROXY_ADDRESS) {
    const chain = await getRealFillFromTx(txHash, PROXY_ADDRESS);
    if (chain != null && Number.isFinite(chain) && chain > 0) {
      baseShares = chain;
      console.log(`${tag} 链上成交份额 ${chain}（WS ${wsFillSize}）`);
    } else {
      console.log(`${tag} 链上查询失败，尝试 REST size_matched`);
    }
  }

  // 2) fallback: REST API size_matched（参考 trading-bot 的做法）
  if (baseShares === wsFillSize && orderId) {
    const restMatched = await fetchOrderSizeMatched(orderId);
    if (restMatched != null && restMatched > 0) {
      baseShares = restMatched;
      console.log(`${tag} REST size_matched ${restMatched}（WS ${wsFillSize}）`);
    }
  }

  // 不再用 positions.localSize 做 cap：WS 事件可能落在互补 token 上，
  // 导致实际买入 token 的 localSize 未被更新（为 0）。baseShares 已是链上/REST 真实成交。
  let sellSize = floorToDecimals(baseShares * GTC_FOLLOW_SELL_SIZE_FACTOR, 2);

  if (!(sellSize > 0.001)) {
    console.warn(`${tag} 跟卖份额无效 base:${baseShares} sellSize:${sellSize}`);
    return;
  }

  // 3) 卖单前查询 CLOB 条件余额，避免 not enough balance
  let clobBalance: number | null = null;
  try {
    const balResp = (await clobClient!.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    })) as { balance?: string; allowance?: string } | null;
    if (balResp && balResp.balance != null) {
      clobBalance = parseFloat(balResp.balance) / 1e6;
    }
  } catch (balErr) {
    console.warn(`${tag} 查询条件余额失败:`, balErr instanceof Error ? balErr.message : String(balErr));
  }

  if (clobBalance != null && clobBalance >= 0) {
    const safeFromBalance = floorToDecimals(clobBalance * GTC_FOLLOW_SELL_SIZE_FACTOR, 2);
    if (safeFromBalance < sellSize) {
      console.log(`${tag} 条件余额 ${clobBalance} < 目标卖量 ${sellSize}，缩至 ${safeFromBalance}`);
      sellSize = safeFromBalance;
    }
  }

  if (!(sellSize > 0.001)) {
    console.warn(`${tag} 最终卖量不足（${sellSize}），放弃跟卖`);
    return;
  }

  const maxSellAttempts = 6;
  try {
    const tickSize = await clobClient!.getTickSize(tokenId);
    const negRisk = await clobClient!.getNegRisk(tokenId);
    const priceDecimals = getDecimalPlaces(tickSize);
    const rawLimit = fillPrice + priceBump;
    const limitPrice = floorToDecimals(Math.min(0.99, Math.max(0.01, rawLimit)), priceDecimals);
    if (limitPrice <= 0) {
      console.warn(`${tag} 跟卖限价无效 ${limitPrice}`);
      return;
    }
    for (let attempt = 0; attempt < maxSellAttempts; attempt++) {
      // 重试前刷新 CLOB 条件余额缓存（GET 请求，让服务端同步链上状态）
      try {
        await clobClient!.updateBalanceAllowance({
          asset_type: AssetType.CONDITIONAL,
          token_id: tokenId,
        });
      } catch (syncErr) {
        console.warn(
          `${tag} updateBalanceAllowance(CONDITIONAL) 第 ${attempt + 1}/${maxSellAttempts} 次:`,
          syncErr instanceof Error ? syncErr.message : String(syncErr),
        );
      }
      // 给链上→CLOB 同步留时间：首等 800ms，逐次递增
      await delayMs(800 + attempt * 600);

      try {
        const result = await clobClient!.createAndPostOrder(
          { tokenID: tokenId, side: Side.SELL, price: limitPrice, size: sellSize },
          { tickSize, negRisk },
          OrderType.GTC,
        );
        const orderError = extractOrderError(result);
        if (result?.status === 400 || orderError) {
          const errText = orderError || String(result?.status ?? "unknown");
          if (isTransientClobBalanceOrAllowanceMessage(errText) && attempt < maxSellAttempts - 1) {
            console.warn(`${tag} 条件余额未就绪: ${errText} → 重试 ${attempt + 2}/${maxSellAttempts}`);
            continue;
          }
          console.warn(`${tag} 跟卖失败: ${errText}`);
          return;
        }
        const dirZh = direction === "up" ? "涨" : "跌";
        console.log(`${tag} 卖出${dirZh} ${sellSize} @${limitPrice} 状态:${result?.status ?? "unknown"}`);
        rememberPendingTradeMeta({
          orderId: typeof result?.orderID === "string" && result.orderID ? result.orderID : undefined,
          ts: Date.now(),
          windowStart: state.windowStart,
          side: "sell",
          direction,
          amount: sellSize,
          worstPrice: limitPrice,
          source: "manual-gtc-follow",
        });
        broadcastState();
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isTransientClobBalanceOrAllowanceMessage(msg) && attempt < maxSellAttempts - 1) {
          console.warn(`${tag} 跟卖异常(可重试): ${msg} → ${attempt + 2}/${maxSellAttempts}`);
          continue;
        }
        console.error(`${tag} 异常:`, msg);
        return;
      }
    }
  } catch (err) {
    console.error(`${tag} 准备跟卖失败:`, err instanceof Error ? err.message : String(err));
  }
}

async function placeGtcOrder(input: PlaceGtcOrderInput): Promise<OrderExecutionResult> {
  const { direction, side, shares, limitOffset, source = "manual-gtc" } = input;
  const orderTag = `[Order:${source}]`;

  if (!direction || !side || !shares || shares <= 0) {
    return { success: false, statusCode: 400, body: { error: "参数错误" }, errorMessage: "参数错误" };
  }
  if (!isNearAllowedOffset(limitOffset, GTC_LIMIT_OFFSETS)) {
    return { success: false, statusCode: 400, body: { error: "limitOffset 须为 0.02 / 0.1 / 0.3" }, errorMessage: "limitOffset 非法" };
  }
  let followBuyDelta: number | undefined;
  if (side === "buy") {
    const raw = input.followBuyDelta;
    if (raw != null) {
      if (!isNearAllowedOffset(raw, GTC_FOLLOW_BUMP_VALUES)) {
        return { success: false, statusCode: 400, body: { error: "followBuyDelta 须为 0.05 … 0.3 之一" }, errorMessage: "followBuyDelta 非法" };
      }
      followBuyDelta = raw;
    }
  }

  if (!(await ensureClobClient())) {
    return {
      success: false,
      statusCode: 500,
      body: { error: "CLOB 客户端未初始化，请检查 POLYMARKET_PRIVATE_KEY" },
      errorMessage: "CLOB 客户端未初始化，请检查 POLYMARKET_PRIVATE_KEY",
    };
  }
  if (isOrderWindowStale()) {
    return {
      success: false,
      statusCode: 409,
      body: { error: "当前市场窗口已过期，等待切换到新窗口" },
      errorMessage: "当前市场窗口已过期，等待切换到新窗口",
    };
  }
  if (!isProbabilityReady()) {
    return {
      success: false,
      statusCode: 409,
      body: { error: "盘口概率暂不可用，等待WS恢复" },
      errorMessage: "盘口概率暂不可用，等待WS恢复",
    };
  }

  const tokenId = direction === "up" ? state.upTokenId : state.downTokenId;
  if (!tokenId) {
    return {
      success: false,
      statusCode: 400,
      body: { error: "当前窗口市场未就绪" },
      errorMessage: "当前窗口市场未就绪",
    };
  }

  let bestBid = 0;
  let bestAsk = 0;
  try {
    ({ bestBid, bestAsk } = await fetchBookTopOfBook(tokenId));
  } catch {
    return {
      success: false,
      statusCode: 500,
      body: { error: "无法获取盘口价格" },
      errorMessage: "无法获取盘口价格",
    };
  }

  if (side === "buy" && !(bestAsk > 0)) {
    return {
      success: false,
      statusCode: 409,
      body: { error: "无卖盘，无法计算买单限价", bestBid, bestAsk },
      errorMessage: "无卖盘，无法计算买单限价",
    };
  }
  if (side === "sell" && !(bestBid > 0)) {
    return {
      success: false,
      statusCode: 409,
      body: { error: "无买盘，无法计算卖单限价", bestBid, bestAsk },
      errorMessage: "无买盘，无法计算卖单限价",
    };
  }

  const rawLimit = side === "buy" ? bestAsk - limitOffset : bestBid + limitOffset;

  try {
    const tickSize = await clobClient!.getTickSize(tokenId);
    const negRisk = await clobClient!.getNegRisk(tokenId);
    const priceDecimals = getDecimalPlaces(tickSize);
    const limitPrice = floorToDecimals(Math.min(0.99, Math.max(0.01, rawLimit)), priceDecimals);
    const normalizedSize = floorToDecimals(shares, 2);
    const orderDebug = `tickSize:${tickSize} size:${shares}->${normalizedSize} limit:${rawLimit}->${limitPrice}`;
    if (normalizedSize <= 0 || limitPrice <= 0) {
      console.warn(`${orderTag} GTC 参数精度处理后无效 ${orderDebug}`);
      return {
        success: false,
        statusCode: 400,
        body: { error: "下单参数精度处理后无效", bestBid, bestAsk, limitPrice },
        errorMessage: "下单参数精度处理后无效",
      };
    }

    const result = await clobClient!.createAndPostOrder(
      {
        tokenID: tokenId,
        side: side === "buy" ? Side.BUY : Side.SELL,
        price: limitPrice,
        size: normalizedSize,
      },
      { tickSize, negRisk },
      OrderType.GTC,
    );
    const sideZh = side === "buy" ? "买入" : "卖出";
    const dirZh = direction === "up" ? "涨" : "跌";
    const rawStatus = result?.status ?? "未知";
    const orderError = extractOrderError(result);

    if (result?.status === 400 || orderError) {
      console.warn(`${orderTag} GTC ${sideZh}${dirZh} 状态:${rawStatus} 原因:${orderError || "-"} ${orderDebug}`);
      return {
        success: false,
        statusCode: 400,
        body: { error: orderError || `下单被拒绝 status=${rawStatus}`, result, bestBid, bestAsk, limitPrice },
        errorMessage: orderError || `下单被拒绝 status=${rawStatus}`,
      };
    }

    console.log(`${orderTag} GTC ${sideZh}${dirZh} ${normalizedSize} 价:${limitPrice} 状态:${rawStatus} ${orderDebug}`);
    rememberPendingTradeMeta({
      orderId: typeof result?.orderID === "string" && result.orderID ? result.orderID : undefined,
      ts: Date.now(),
      windowStart: state.windowStart,
      side,
      direction,
      amount: normalizedSize,
      worstPrice: limitPrice,
      source,
      ...(followBuyDelta != null ? { gtcFollowBuyDelta: followBuyDelta } : {}),
    });
    if (!(typeof result?.orderID === "string" && result.orderID)) {
      console.warn(`${orderTag} GTC 回包缺少 orderID，成交匹配可能降级`);
    }
    broadcastState();
    return {
      success: true,
      statusCode: 200,
      body: { success: true, result, bestBid, bestAsk, limitPrice, followBuyDelta: followBuyDelta ?? null },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${orderTag} GTC 失败:`, msg);
    return {
      success: false,
      statusCode: 500,
      body: { error: msg },
      errorMessage: msg,
    };
  }
}

async function cancelOpenOrdersForScope(scope: "buys" | "sells" | "all"): Promise<OrderExecutionResult> {
  const orderTag = "[OrderCancel]";
  if (!(await ensureClobClient())) {
    return {
      success: false,
      statusCode: 500,
      body: { error: "CLOB 客户端未初始化" },
      errorMessage: "CLOB 客户端未初始化",
    };
  }
  const tokenIds = new Set([state.upTokenId, state.downTokenId].filter(Boolean));
  if (tokenIds.size === 0) {
    return {
      success: false,
      statusCode: 400,
      body: { error: "当前窗口市场未就绪" },
      errorMessage: "当前窗口市场未就绪",
    };
  }
  let openOrders: Awaited<ReturnType<ClobClient["getOpenOrders"]>>;
  try {
    openOrders = await clobClient!.getOpenOrders(undefined, false);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, statusCode: 500, body: { error: msg }, errorMessage: msg };
  }
  const toCancel = openOrders.filter((o) => {
    if (!tokenIds.has(o.asset_id)) return false;
    const os = normalizeOpenOrderSide(o.side);
    if (!os) return false;
    if (scope === "all") return true;
    if (scope === "buys") return os === "buy";
    return os === "sell";
  });
  let cancelled = 0;
  const failedIds: string[] = [];
  for (const o of toCancel) {
    try {
      await clobClient!.cancelOrder({ orderID: o.id });
      cancelled++;
    } catch {
      failedIds.push(o.id);
    }
  }
  console.log(`${orderTag} scope=${scope} 请求撤回 ${toCancel.length} 成功 ${cancelled} 失败 ${failedIds.length}`);
  return {
    success: failedIds.length === 0,
    statusCode: 200,
    body: {
      scope,
      requested: toCancel.length,
      cancelled,
      failedIds,
    },
    ...(failedIds.length ? { errorMessage: "部分订单未能撤回" } : {}),
  };
}

async function strategyBuy(direction: StrategyDirection, amount: number): Promise<void> {
  strategyRuntime.posBeforeBuy = getDirectionLocalSize(direction);
  strategyRuntime.actionTs = Date.now();
  strategyRuntime.buyLockUntil = Date.now() + STRAT_BUY_LOCK_MS;
  strategyRuntime.state = "WAIT_FILL";
  broadcastState();

  const orderResult = await placeOrder({
    direction,
    side: "buy",
    amount,
    slippage: strategyConfig.slippage,
    source: `strategy${strategyRuntime.activeStrategy ?? ""}`,
    roundEntry: `${strategyRuntime.roundEntryCount}/${strategyConfig.maxRoundEntries}`,
  });

  if (!orderResult.success) {
    console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] 买入失败: ${orderResult.errorMessage || "下单失败"}`);
    strategyRuntime.buyLockUntil = 0;
    strategyRuntime.state = "SCANNING";
    strategyRuntime.activeStrategy = null;
    broadcastState();
  }
}

async function strategySell(direction: StrategyDirection, exitReason?: string): Promise<void> {
  const totalPos = getDirectionLocalSize(direction);
  const shares = getSellableShares(direction);
  if (shares <= 0) {
    transitionToDone();
    return;
  }

  strategyRuntime.posBeforeSell = totalPos;
  strategyRuntime.waitVerifyAfterSell = !isDirectionVerified(direction);
  strategyRuntime.actionTs = Date.now();
  strategyRuntime.state = "WAIT_SELL_FILL";
  broadcastState();

  const orderResult = await placeOrder({
    direction,
    side: "sell",
    amount: shares,
    slippage: strategyConfig.slippage,
    source: `strategy${strategyRuntime.activeStrategy ?? ""}`,
    exitReason,
    roundEntry: `${strategyRuntime.roundEntryCount}/${strategyConfig.maxRoundEntries}`,
  });

  if (!orderResult.success) {
    console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] 卖出失败: ${orderResult.errorMessage || "下单失败"}`);
    strategyRuntime.waitVerifyAfterSell = false;
    strategyRuntime.state = "HOLDING";
    broadcastState();
  }
}

// ── 回测数据收集 ─────────────────────────────────────────────
const BACKTEST_STATE_FILE = resolve(__dirname, ".backtest-state.json");

function loadBacktestState(): boolean {
  try {
    if (!existsSync(BACKTEST_STATE_FILE)) return true;  // 首次运行默认开启
    const data = JSON.parse(readFileSync(BACKTEST_STATE_FILE, "utf-8"));
    return typeof data.collecting === "boolean" ? data.collecting : true;
  } catch {
    return true;
  }
}

function persistBacktestState(): void {
  try {
    writeFileSync(BACKTEST_STATE_FILE, JSON.stringify({ collecting: backtestCollecting }, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.warn(`[Backtest] 状态保存失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let backtestCollecting = loadBacktestState();
let backtestLastTickTs = 0;
let backtestLastCleanupDate = "";
const BACKTEST_RETENTION_DAYS = 30;

// 启动时确保数据目录存在（防止首次写入失败）
if (backtestCollecting) {
  try { mkdirSync(BACKTEST_DATA_DIR, { recursive: true }); } catch { /* 忽略 */ }
}

function setBacktestCollecting(enabled: boolean): void {
  backtestCollecting = enabled;
  console.log(`[Backtest] 数据收集${enabled ? "已开启" : "已关闭"}`);
  persistBacktestState();
  if (enabled) {
    mkdirSync(BACKTEST_DATA_DIR, { recursive: true });
    cleanupOldBacktestFiles();
  }
  broadcastBacktestStatus();
}

function cleanupOldBacktestFiles(): void {
  try {
    if (!existsSync(BACKTEST_DATA_DIR)) return;
    const files = readdirSync(BACKTEST_DATA_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
    if (files.length <= BACKTEST_RETENTION_DAYS) return;
    files.sort(); // 按日期字典序升序，旧的在前
    const toDelete = files.slice(0, files.length - BACKTEST_RETENTION_DAYS);
    for (const f of toDelete) {
      try {
        unlinkSync(resolve(BACKTEST_DATA_DIR, f));
        console.log(`[Backtest] 已清理旧数据文件: ${f}`);
      } catch {}
    }
  } catch (err) {
    console.warn(`[Backtest] 清理旧文件失败: ${(err as Error).message}`);
  }
}

function broadcastBacktestStatus(): void {
  broadcast("backtestStatus", { collecting: backtestCollecting });
}

function getBacktestFilePath(): string {
  const dateStr = new Date().toISOString().slice(0, 10);
  return resolve(BACKTEST_DATA_DIR, `${dateStr}.jsonl`);
}

function backtestAppend(record: Record<string, unknown>): void {
  try {
    appendFileSync(getBacktestFilePath(), JSON.stringify(record) + "\n");
  } catch (err) {
    console.warn(`[Backtest] 写入失败: ${(err as Error).message}`);
  }
}

function backtestTick(): void {
  if (!backtestCollecting) return;
  const now = Date.now();
  if (now - backtestLastTickTs < 1000) return;

  const snapshot = getProbabilitySnapshot();
  const diff = getStrategyDiff();
  const rem = getStrategyRemainingSeconds(now);
  if (snapshot == null || diff == null || !state.windowStart) return;

  // 每天首次写入时清理旧文件（超过保留天数的）
  const todayStr = new Date().toISOString().slice(0, 10);
  if (todayStr !== backtestLastCleanupDate) {
    cleanupOldBacktestFiles();
    backtestLastCleanupDate = todayStr;
  }

  backtestAppend({
    type: "tick",
    ts: now,
    windowStart: state.windowStart,
    diff: Math.round(diff * 100) / 100,
    upPct: snapshot.upPct,
    rem,
  });
  backtestLastTickTs = now;
}


// 事件驱动的策略调度器：短时间内多次事件只触发一次 tick
let strategyTickScheduled = false;
let strategyTickLastRunTs = 0;
const STRATEGY_TICK_MIN_GAP_MS = 10;  // 连续 tick 最小间隔（防止风暴）

function scheduleStrategyTick(): void {
  if (strategyTickScheduled) return;
  strategyTickScheduled = true;
  const now = Date.now();
  const elapsed = now - strategyTickLastRunTs;
  if (elapsed >= STRATEGY_TICK_MIN_GAP_MS) {
    setImmediate(() => {
      strategyTickScheduled = false;
      strategyTickLastRunTs = Date.now();
      runStrategyTick();
    });
  } else {
    setTimeout(() => {
      strategyTickScheduled = false;
      strategyTickLastRunTs = Date.now();
      runStrategyTick();
    }, STRATEGY_TICK_MIN_GAP_MS - elapsed);
  }
}

function runStrategyTick(): void {
  const snapshot = getProbabilitySnapshot();
  const upPct = snapshot?.upPct ?? null;
  const dnPct = snapshot?.dnPct ?? null;
  const diff = getStrategyDiff();
  const now = Date.now();
  const rem = getStrategyRemainingSeconds(now);
  const currentPosition = getDirectionLocalSize(strategyRuntime.direction);
  const ctx = buildTickContext(rem, upPct, dnPct, diff, now);
  const finalize = () => {
    strategyRuntime.prevUpPct = upPct;
    // 通知已启用且需要 finalizeTick 的策略（s1/s2 记录 lastDiff）
    for (const s of getAllStrategies()) {
      if (strategyConfig.enabled[s.key] && "finalizeTick" in s && typeof (s as any).finalizeTick === "function") {
        (s as any).finalizeTick(diff);
      }
    }
  };

  if (isOrderWindowStale(now)) {
    finalize();
    return;
  }

  if (!strategyRuntime.positionsReady) {
    finalize();
    return;
  }

  // 更新已启用策略的守卫状态（冷却锁等）
  for (const s of getAllStrategies()) {
    if (strategyConfig.enabled[s.key]) s.updateGuards(ctx);
    // 策略6 的因子评分作为市场观察数据无论是否启用都要计算
    else if (s.key === "s6" && "computeFactors" in s && typeof (s as any).computeFactors === "function") {
      (s as any).computeFactors(ctx);
    }
  }

  if (strategyRuntime.cleanupAfterVerify && strategyRuntime.direction) {
    if (!isDirectionVerified(strategyRuntime.direction)) {
      finalize();
      return;
    }
    if (currentPosition < 0.01) {
      strategyRuntime.cleanupAfterVerify = false;
      transitionToDone();
      finalize();
      return;
    }
    strategyRuntime.cleanupAfterVerify = false;
    strategyRuntime.state = "SELLING";
    console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] 仓位已校准，剩余 ${currentPosition.toFixed(2)}，执行清仓卖出`);
    broadcastState();
    void strategySell(strategyRuntime.direction, `校准清仓 剩余${currentPosition.toFixed(2)}`);
    finalize();
    return;
  }

  if (strategyRuntime.state === "IDLE") {
    if (upPct == null || diff == null) {
      finalize();
      return;
    }
    if (anyStrategyEnabled()) {
      strategyRuntime.state = "SCANNING";
      broadcastState();
    }
    finalize();
    return;
  }

  if (strategyRuntime.state === "SCANNING") {
    if (!anyStrategyEnabled()) {
      strategyRuntime.state = "IDLE";
      broadcastState();
      finalize();
      return;
    }
    if (hasOpenPosition() || hasPendingStrategyBuyLock(now) || upPct == null || dnPct == null || diff == null) {
      finalize();
      return;
    }
    if (strategyRuntime.roundEntryCount >= strategyConfig.maxRoundEntries) {
      finalize();
      return;
    }
    const entry = checkEntry(ctx);
    if (!entry) {
      finalize();
      return;
    }
    const buyAmount = strategyConfig.amount[strategyKeyOf(entry.strategy)];
    if (!hasEnoughUsdcForBuy(buyAmount)) {
      finalize();
      return;
    }
    strategyRuntime.roundEntryCount++;
    strategyRuntime.activeStrategy = entry.strategy;
    strategyRuntime.direction = entry.dir;
    strategyRuntime.buyAmount = buyAmount;
    strategyRuntime.state = "BUYING";
    console.log(`[Strategy${entry.strategy}] 触发入场(${strategyRuntime.roundEntryCount}/${strategyConfig.maxRoundEntries}) ${entry.dir === "up" ? "买涨" : "买跌"} 金额:${buyAmount}`);
    broadcastState();
    void strategyBuy(entry.dir, buyAmount);
    finalize();
    return;
  }

  if (strategyRuntime.state === "WAIT_FILL") {
    if (hasConfirmedBuyPosition()) {
      strategyRuntime.buyLockUntil = 0;
      strategyRuntime.state = "HOLDING";
      console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] 买入成交确认`);
      // 通知策略买入成交（用于初始化追踪峰值等）
      if (strategyRuntime.activeStrategy && strategyRuntime.direction) {
        const activeStrat = getStrategy(strategyKeyOf(strategyRuntime.activeStrategy));
        if (activeStrat?.onEntryFilled) activeStrat.onEntryFilled(ctx, strategyRuntime.direction);
      }
      broadcastState();
    } else if (now - strategyRuntime.actionTs > WAIT_FILL_TIMEOUT_MS) {
      console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] 买入超过10s未确认，进入延迟确认等待`);
      strategyRuntime.state = "RECONCILING_FILL";
      broadcastState();
      finalize();
      return;
    } else {
      finalize();
      return;
    }
  }

  if (strategyRuntime.state === "RECONCILING_FILL") {
    if (hasConfirmedBuyPosition()) {
      strategyRuntime.buyLockUntil = 0;
      strategyRuntime.state = "HOLDING";
      console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] 延迟确认成功，恢复持仓管理`);
      if (strategyRuntime.activeStrategy && strategyRuntime.direction) {
        const activeStrat = getStrategy(strategyKeyOf(strategyRuntime.activeStrategy));
        if (activeStrat?.onEntryFilled) activeStrat.onEntryFilled(ctx, strategyRuntime.direction);
      }
      broadcastState();
    } else if (canReleaseUnconfirmedBuy(now)) {
      console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] 超过15s且API确认无仓位，恢复扫描`);
      strategyRuntime.state = "SCANNING";
      strategyRuntime.activeStrategy = null;
      strategyRuntime.direction = null;
      strategyRuntime.buyAmount = 0;
      strategyRuntime.posBeforeBuy = 0;
      strategyRuntime.actionTs = 0;
      strategyRuntime.buyLockUntil = 0;
      broadcastState();
      finalize();
      return;
    } else {
      finalize();
      return;
    }
  }

  if (strategyRuntime.state === "HOLDING") {
    if (currentPosition <= 0) {
      transitionToDone();
      finalize();
      return;
    }
    if (upPct == null || dnPct == null || diff == null) {
      finalize();
      return;
    }
    const exit = checkExit(ctx);
    if (exit && strategyRuntime.direction) {
      console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] ${exit.signal === "tp" ? "止盈" : "止损"}触发: ${exit.reason}`);
      strategyRuntime.state = "SELLING";
      broadcastState();
      void strategySell(strategyRuntime.direction, exit.reason);
    }
    finalize();
    return;
  }

  if (strategyRuntime.state === "WAIT_SELL_FILL") {
    if (currentPosition < strategyRuntime.posBeforeSell - 0.01) {
      if (currentPosition < 0.01) {
        strategyRuntime.waitVerifyAfterSell = false;
        strategyRuntime.cleanupAfterVerify = false;
        console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] 卖出确认，完成`);
        transitionToDone();
        finalize();
        return;
      }

      if (strategyRuntime.waitVerifyAfterSell) {
        strategyRuntime.waitVerifyAfterSell = false;
        if (isDirectionVerified(strategyRuntime.direction)) {
          console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] 卖出后已校准，剩余 ${currentPosition.toFixed(2)}，立即执行清仓`);
          strategyRuntime.cleanupAfterVerify = false;
          strategyRuntime.state = "SELLING";
          broadcastState();
          if (strategyRuntime.direction) void strategySell(strategyRuntime.direction, `校准清仓 剩余${currentPosition.toFixed(2)}`);
          finalize();
          return;
        }
        strategyRuntime.cleanupAfterVerify = true;
        strategyRuntime.state = "DONE";
        console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] 卖出确认，等待校准后检查剩余仓位`);
        broadcastState();
        finalize();
        return;
      }

      strategyRuntime.waitVerifyAfterSell = false;
      strategyRuntime.state = "HOLDING";
      console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] 卖出确认，剩余 ${currentPosition.toFixed(2)} 继续处理`);
      broadcastState();
      finalize();
      return;
    }

    if (now - strategyRuntime.actionTs > WAIT_FILL_TIMEOUT_MS) {
      console.log(`[Strategy${strategyRuntime.activeStrategy ?? ""}] 卖出超时，回持仓`);
      strategyRuntime.waitVerifyAfterSell = false;
      strategyRuntime.state = "HOLDING";
      broadcastState();
    }
    finalize();
    return;
  }

  finalize();
}

function buildApiStatePayload(): Record<string, unknown> {
  return {
    ...buildStatePayload(true),
    tradeHistory,
    wsStatus,
    claimable: {
      total: claimableTotal,
      positions: claimablePositions,
    },
    claimCooldown: {
      running: claimCycleRunning || claimInProgress,
      nextCheckAt: claimNextCheckAt,
      cooldownUntil: claimCooldownUntil,
      reason: claimLastReason,
    },
  };
}

app.get("/api/state", (_req, res) => {
  res.json(buildApiStatePayload());
});

app.get("/api/strategy/descriptions", (_req, res) => {
  res.json(getAllDescriptions());
});

app.get("/api/backtest/status", (_req, res) => {
  res.json({ collecting: backtestCollecting });
});

app.post("/api/backtest/toggle", (_req, res) => {
  setBacktestCollecting(!backtestCollecting);
  res.json({ collecting: backtestCollecting });
});

app.post("/api/strategy/config", (req, res) => {
  const { config, error } = applyStrategyConfigUpdate(strategyConfig, req.body);
  if (!config) {
    res.status(400).json({ error: error || "配置错误" });
    return;
  }

  strategyConfig = config;
  savePersistedStrategyConfig(config);
  const configSummary = ALL_STRATEGY_KEYS.map((k) => `${k}:${config.enabled[k] ? "on" : "off"}(${config.amount[k]})`).join(" ");
  console.log(`[StrategyConfig] 已更新 ${configSummary} maxRound:${config.maxRoundEntries} 当前进程生效`);
  broadcastState();
  res.json({ success: true, strategyConfig });
});

// ── REST：Claim 接口（已弃用）────────────────────────────────
// 自动 Claim 已迁移至 Polymarket 官网（Settings → Auto Redeem）
app.post("/api/claim", async (_req, res) => {
  res.status(410).json({
    error: "本地 Claim 功能已移除",
    hint: "请在 Polymarket 官网 Settings 中开启 Auto Redeem",
  });
});

// ── REST：下单接口 ────────────────────────────────────────────
app.post("/api/order", async (req, res) => {
  const { direction, side, amount, slippage } = req.body as {
    direction: "up" | "down";
    side: "buy" | "sell";
    amount: number;
    slippage?: number;
  };
  const result = await placeOrder({ direction, side, amount, slippage, source: "manual" });
  res.status(result.statusCode).json(result.body);
});

app.post("/api/order/gtc", async (req, res) => {
  const { direction, side, shares, limitOffset, followBuyDelta } = req.body as {
    direction: "up" | "down";
    side: "buy" | "sell";
    shares: number;
    limitOffset: number;
    followBuyDelta?: number | null;
  };
  const result = await placeGtcOrder({
    direction,
    side,
    shares,
    limitOffset,
    followBuyDelta: followBuyDelta ?? null,
    source: "manual-gtc",
  });
  res.status(result.statusCode).json(result.body);
});

app.post("/api/orders/cancel", async (req, res) => {
  const scope = (req.body as { scope?: string }).scope;
  if (scope !== "buys" && scope !== "sells" && scope !== "all") {
    res.status(400).json({ error: "scope 须为 buys | sells | all" });
    return;
  }
  const result = await cancelOpenOrdersForScope(scope);
  res.status(result.statusCode).json(result.body);
});

// ── 浏览器 WS 连接 ────────────────────────────────────────────
if (wss) {
  wss.on("connection", (ws, req) => {
    const dataMode = resolveClientDataModeFromUrl(req.url);
    clientSessions.set(ws, createClientSession(dataMode));
    console.log(`[WS] 浏览器已连接，当前: ${wss!.clients.size} mode=${dataMode}`);
    send(ws, "clientConfig", { dataMode });
    sendStateToClient(ws, { includeHistory: true });
    sendTradeHistoryToClient(ws);
    sendPmPnlToClient(ws);
    send(ws, "wsStatus", wsStatus as unknown as Record<string, unknown>);
    send(ws, "claimable", { total: claimableTotal, positions: claimablePositions });
    send(ws, "claimCooldown", { running: claimCycleRunning || claimInProgress, nextCheckAt: claimNextCheckAt, cooldownUntil: claimCooldownUntil, reason: claimLastReason });
    send(ws, "backtestStatus", { collecting: backtestCollecting });
    ws.on("message", (raw) => {
      try {
        applyClientConfig(ws, JSON.parse(raw.toString()));
      } catch {
        // 忽略非 JSON 或非配置消息
      }
    });
    ws.on("close", () => {
      const session = clientSessions.get(ws);
      if (session) {
        clearStateTimer(session);
        clientSessions.delete(ws);
      }
      console.log(`[WS] 浏览器断开，当前: ${wss!.clients.size}`);
    });
  });
}

// ── 启动 ──────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`\n BTC 5m 盘口监控服务已启动`);
  console.log(`  by 岳来岳会赚 | X: @188888_x`);
  console.log(`  运行模式:   ${APP_MODE}`);
  console.log(`  状态接口:   http://localhost:${PORT}/api/state`);
  if (IS_FULL_MODE) {
    console.log(`  浏览器打开: http://localhost:${PORT}`);
    console.log(`  WS 地址:    ws://localhost:${PORT}`);
  }
  console.log("");

  await ensureClobClient();
  startUserWs();
  startBinanceWs();
  await syncPositionsFromApi();
  await syncUsdcBalance();

  setInterval(async () => { await syncPositionsFromApi(); broadcastState(); }, 2000);
  setInterval(async () => { await syncUsdcBalance(); broadcastState(); }, 5000);
  setInterval(() => { refreshBinanceOffset("定时", { allowLatestFallback: false }); }, BINANCE_ALIGN_REFRESH_MS);
  setInterval(() => { runStrategyTick(); backtestTick(); }, STRATEGY_TICK_MS);
  // Claim 功能已移至 Polymarket 官网（Settings → Auto Redeem），本地不再自动执行

  // Polymarket 真实盈亏：启动全量加载 + 每 30 秒增量同步（外部下单也能快速反映）
  // positions 变化较慢（只在结算时），每 5 分钟同步一次就够
  pmPnlManager.init().then(() => broadcastPmPnl()).catch((err) => {
    console.warn(`[PmPnl] 启动加载失败: ${err instanceof Error ? err.message : String(err)}`);
  });
  setInterval(async () => {
    const beforeCount = pmPnlManager.getTotalPnl(0).positionCount;
    await pmPnlManager.syncIncremental();
    const afterCount = pmPnlManager.getTotalPnl(0).positionCount;
    const delta = afterCount - beforeCount;
    console.log(`[PmPnl] 定时增量 tick: ${delta > 0 ? `+${delta}` : '无新'} 笔（总 ${afterCount}）`);
    broadcastPmPnl();
  }, 30 * 1000);
  setInterval(async () => {
    await pmPnlManager.syncPositions();
    broadcastPmPnl();
  }, 5 * 60 * 1000);

  const currentWindow = getCurrentWindowStart();
  fetchRecentResults(currentWindow, true);
  await subscribeWindow(currentWindow);
});

process.on("SIGINT", () => {
  stopped = true;
  if (switchTimer)    clearTimeout(switchTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (claimCycleTimer) clearTimeout(claimCycleTimer);
  if (marketWs)    marketWs.close();
  if (chainlinkWs) chainlinkWs.close();
  if (userWs)      (userWs as WebSocket).close();
  if (binanceWs)   binanceWs.close();
  server.close();
  process.exit(0);
});

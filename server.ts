/**
 * BTC 5分钟涨跌盘口监控 — 独立服务端
 * 启动: npx tsx server.ts
 */

import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync } from "fs";
import { ethers } from "ethers";
import dotenv from "dotenv";
import { ClobClient, Side, OrderType, Chain, SignatureTypeV2 as SignatureType, AssetType, getContractConfig } from "@polymarket/clob-client-v2";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { RelayClient, RelayerTxType } from "@polymarket/builder-relayer-client";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import type { Hex } from "viem";
import { getAllStrategies, getStrategy, getAllDescriptions } from "./strategies/registry.js";
import type { StrategyNumber, StrategyDirection, StrategyLifecycleState, StrategyKey } from "./strategies/types.js";
import { ALL_STRATEGY_KEYS } from "./strategies/types.js";

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
}

interface StrategyConfigUpdate {
  enabled?: Partial<Record<StrategyKey, unknown>>;
  amount?: Partial<Record<StrategyKey, unknown>>;
  slippage?: unknown;
  autoClaimEnabled?: unknown;
  maxRoundEntries?: unknown;
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
const BINANCE_WS_URL   = "wss://stream.binance.com:9443/ws/btcusdt@aggTrade";
const GAMMA_URL        = "https://gamma-api.polymarket.com";
const CLOB_URL         = "https://clob.polymarket.com";
const HISTORY_RETENTION_MS = 130000;
const MAX_CHAINLINK_HISTORY_POINTS = 2000;
const MAX_BINANCE_HISTORY_POINTS = 4000;
const MAX_CONFIRMED_TRADE_IDS = 2000;
const CLAIM_CYCLE_DELAY_MS = 30000;
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
const POLY_BUILDER_API_KEY = process.env.POLY_BUILDER_API_KEY || "";
const POLY_BUILDER_SECRET = process.env.POLY_BUILDER_SECRET || "";
const POLY_BUILDER_PASSPHRASE = process.env.POLY_BUILDER_PASSPHRASE || "";
const POLY_BUILDER_CODE = process.env.POLY_BUILDER_CODE || "";
const POLY_BUILDER_ADDRESS = process.env.POLY_BUILDER_ADDRESS || "";
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
    autoClaimEnabled: parseBooleanEnv("AUTO_CLAIM_ENABLED", true),
    maxRoundEntries: parseNumberEnv("MAX_ROUND_ENTRIES", 1, 1),
  };
}

function cloneStrategyConfig(config: StrategyConfig): StrategyConfig {
  return {
    enabled: { ...config.enabled },
    amount: { ...config.amount },
    slippage: config.slippage,
    autoClaimEnabled: config.autoClaimEnabled,
    maxRoundEntries: config.maxRoundEntries,
  };
}

function loadPersistedStrategyConfig(config: StrategyConfig): void {
  if (!existsSync(STRATEGY_CONFIG_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(STRATEGY_CONFIG_FILE, "utf-8"));
    if (typeof raw.maxRoundEntries === "number" && raw.maxRoundEntries >= 1) {
      config.maxRoundEntries = Math.floor(raw.maxRoundEntries);
    }
  } catch {
    // ignore
  }
}

function savePersistedStrategyConfig(config: StrategyConfig): void {
  try {
    writeFileSync(STRATEGY_CONFIG_FILE, JSON.stringify({ maxRoundEntries: config.maxRoundEntries }, null, 2));
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
  broadcastTradeHistory();
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

function parseTradeEventTimestamp(evt: Record<string, unknown>): number {
  const raw = typeof evt.match_time === "string"
    ? evt.match_time
    : typeof evt.last_update === "string"
      ? evt.last_update
      : "";
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function consumePendingTradeMeta(evt: Record<string, unknown>): PendingTradeMeta | null {
  cleanupPendingTradeMeta();
  const candidateIds: string[] = [];
  if (typeof evt.taker_order_id === "string" && evt.taker_order_id) {
    candidateIds.push(evt.taker_order_id);
  }
  if (Array.isArray(evt.maker_orders)) {
    for (const makerOrder of evt.maker_orders) {
      if (!isRecord(makerOrder) || typeof makerOrder.order_id !== "string" || !makerOrder.order_id) continue;
      candidateIds.push(makerOrder.order_id);
    }
  }
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

function normalizeBuilderCode(raw: string): `0x${string}` | null {
  const code = raw.trim();
  if (!code) return null;
  if (/^0x[0-9a-fA-F]{64}$/.test(code)) return code as `0x${string}`;
  if (ethers.isAddress(code)) {
    return `0x${code.toLowerCase().slice(2).padStart(64, "0")}` as `0x${string}`;
  }
  return null;
}

function buildBuilderConfig(): { builderConfig?: { builderAddress: string; builderCode: `0x${string}` } } {
  const builderCode = normalizeBuilderCode(POLY_BUILDER_CODE);
  if (!builderCode) return {};
  const fallback = PROXY_ADDRESS || "";
  const builderAddress = POLY_BUILDER_ADDRESS.trim() || fallback;
  if (!builderAddress || !ethers.isAddress(builderAddress)) {
    console.warn("[Builder] POLY_BUILDER_CODE 已配置但 builderAddress 无效，忽略 builder 配置。");
    return {};
  }
  return {
    builderConfig: {
      builderAddress,
      builderCode,
    },
  };
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
  let sigType = SignatureType.EOA;
  if (PROXY_ADDRESS) {
    const provider = new ethers.JsonRpcProvider("https://polygon-bor-rpc.publicnode.com", 137, { staticNetwork: true });
    const isSafe = await detectSafeClaimSupport(provider, PROXY_ADDRESS);
    sigType = isSafe ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.POLY_PROXY;
    console.log(`[Auth] 使用 signatureType=${isSafe ? "POLY_GNOSIS_SAFE" : "POLY_PROXY"}`);
  }
  const funderAddress = PROXY_ADDRESS || undefined;
  const saved   = loadCreds();
  const builderOpts = buildBuilderConfig();

  if (saved) {
    const creds = { key: saved.key, secret: saved.secret, passphrase: saved.passphrase };
    if (PRIVATE_KEY) {
      const signer = adaptSigner(new ethers.Wallet(PRIVATE_KEY)) as any;
      return new ClobClient({ host: CLOB_URL, chain: Chain.POLYGON, signer, creds, signatureType: sigType, funderAddress, ...builderOpts });
    }
    return new ClobClient({ host: CLOB_URL, chain: Chain.POLYGON, creds, signatureType: sigType, funderAddress, ...builderOpts });
  }

  if (!PRIVATE_KEY) {
    console.warn("[Auth] 未配置 POLYMARKET_PRIVATE_KEY，下单功能不可用");
    return null;
  }

  console.log("[Auth] 首次使用，通过私钥生成 Polymarket API 凭证...");
  const wallet = new ethers.Wallet(PRIVATE_KEY);
  const signer = adaptSigner(wallet) as any;
  const client = new ClobClient({ host: CLOB_URL, chain: Chain.POLYGON, signer, signatureType: sigType, funderAddress, ...builderOpts });
  const creds  = await client.createOrDeriveApiKey();
  writeFileSync(CREDS_FILE, JSON.stringify({ key: creds.key, secret: creds.secret, passphrase: creds.passphrase, address: wallet.address }, null, 2));
  console.log("[Auth] 凭证已保存到 .polymarket-creds.json");
  return new ClobClient({ host: CLOB_URL, chain: Chain.POLYGON, signer, creds, signatureType: sigType, funderAddress, ...builderOpts });
}

function clearCachedCreds(): void {
  try {
    if (existsSync(CREDS_FILE)) unlinkSync(CREDS_FILE);
  } catch (err) {
    console.warn(`[Auth] 清理本地凭证失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isUnauthorizedApiKeyError(msg: string): boolean {
  const text = msg.toLowerCase();
  return text.includes("unauthorized/invalid api key") || (text.includes("unauthorized") && text.includes("api key"));
}

async function rebuildClobClientCreds(): Promise<boolean> {
  if (!PRIVATE_KEY) return false;
  clearCachedCreds();
  clobClient = null;
  return ensureClobClient();
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
  lastPrice: "-",
  lastSide: "",
  updatedAt: 0,
  priceToBeat: null as number | null,
  currentPrice: null as number | null,
  binanceOffset: null as number | null,
  priceHistory: [] as Array<{ t: number; price: number }>,
  binanceHistory: [] as Array<{ t: number; price: number }>,
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
    probabilityReady: isProbabilityReady(),
    lastPrice:    state.lastPrice,
    lastSide:     state.lastSide,
    updatedAt:    state.updatedAt,
    priceToBeat:  state.priceToBeat,
    currentPrice: state.currentPrice,
    binanceOffset: state.binanceOffset,
    binanceDiff: getStrategyDiff(),
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
          const size = typeof evt.size === "number" ? evt.size : parseFloat(String(evt.size ?? ""));
          const side = normalizeTradeSide(evt.side);
          const price = typeof evt.price === "number" ? evt.price : parseFloat(String(evt.price ?? ""));
          if (!assetId || !side || !Number.isFinite(size) || size <= 0) continue;
          const pendingMeta = consumePendingTradeMeta(evt);
          const direction = pendingMeta?.direction ?? getDirectionByAssetId(assetId);
          const orderId = typeof evt.taker_order_id === "string" && evt.taker_order_id
            ? evt.taker_order_id
            : pendingMeta?.orderId;
          const txHash = typeof evt.transaction_hash === "string" && evt.transaction_hash
            ? evt.transaction_hash
            : undefined;
          if (!(assetId in positions.localSize)) positions.localSize[assetId] = 0;
          positions.localSize[assetId] = side === "buy"
            ? positions.localSize[assetId] + size
            : Math.max(0, positions.localSize[assetId] - size);
          positions.apiVerified[assetId] = false;
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
            `[UserWS] MINED ${side.toUpperCase()} ${size} @ ${Number.isFinite(price) ? price : "-"}`
            + ` asset: ...${assetId.slice(-6)}`
            + `${orderId ? ` order:${orderId}` : ""}`
            + `${txHash ? ` tx:${txHash.slice(0, 10)}...` : ""}`
          );
          broadcastState();
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
  return true;
}

function clearProbabilityForMs(ms: number, reason: string): void {
  const until = Date.now() + ms;
  if (until > bestBidAskPausedUntil) bestBidAskPausedUntil = until;
  marketBestReady = false;
  lastBestBidAskTimestamp = 0;
  state.bestBid = "-";
  state.bestAsk = "-";
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
          if (evt.asset_id && evt.asset_id !== upTokenId) continue;
          if (!applyBestBidAskUpdate(evt.best_bid, evt.best_ask, evt.timestamp)) continue;
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

function startBinanceWs(): void {
  binanceWs = new WebSocket(BINANCE_WS_URL);
  binanceWs.on("open", () => { console.log(binanceWsAttempt === 0 ? "[BinanceWS] 已连接" : "[BinanceWS] 重连成功"); binanceWsAttempt = 0; wsStatus.binance = true; broadcastWsStatus(); });
  binanceWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString()) as { p?: string; T?: number };
      const price = parseFloat(msg.p ?? "");
      const t = msg.T ?? Date.now();
      if (!price) return;
      state.binanceHistory.push({ t, price });
      trimHistory(state.binanceHistory, t - HISTORY_RETENTION_MS, MAX_BINANCE_HISTORY_POINTS);
      maybeInitializeBinanceOffset();
      broadcast("binancePrice", { t, price });
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
  state.lastPrice = "-"; state.lastSide = "";
  state.binanceOffset = null;
  state.updatedAt = Date.now();
  lastBestBidAskTimestamp = 0;
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
  conditionId: string; title: string; currentValue: number; size: number; outcomeIndex: number;
}
let claimablePositions: ClaimPosition[] = [];
let claimableTotal = 0;
let claimCycleTimer: ReturnType<typeof setTimeout> | null = null;
let claimCycleRunning = false;
let claimNextCheckAt = 0;

function broadcastClaimCooldown(running = false): void {
  broadcast("claimCooldown", { running, nextCheckAt: claimNextCheckAt });
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
    ).then(r => r.json()) as Array<{ conditionId: string; title: string; currentValue: number; size: number; curPrice: number; outcomeIndex?: number; redeemable?: boolean }>;
    claimablePositions = pos.filter(p => p.redeemable === true && Number(p.currentValue ?? 0) > 0).map(p => ({
      conditionId: p.conditionId, title: p.title, currentValue: p.currentValue, size: p.size, outcomeIndex: Number(p.outcomeIndex ?? 0),
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
    const synced = await syncClaimable({ clearOnError: true });
    if (!synced) return;
    if (!strategyConfig.autoClaimEnabled || !PRIVATE_KEY) return;
    if (!claimablePositions.length || claimInProgress) return;
    console.log(`[自动Claim] 检测到 ${claimablePositions.length} 个可领取仓位，后台开始领取...`);
    await runClaim({ refreshAfter: false });
  } finally {
    claimCycleRunning = false;
    scheduleClaimCycle();
  }
}

// ── Claim 核心逻辑 ───────────────────────────────────────────
let claimInProgress = false;
let safeClaimSupport: boolean | null = null;
const POLY_PROXY_FACTORY_ADDRESS = "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052";
let relayClient: RelayClient | null = null;
let relayClientInitTried = false;

function hasRelayerCreds(): boolean {
  return !!(POLY_BUILDER_API_KEY && POLY_BUILDER_SECRET && POLY_BUILDER_PASSPHRASE);
}

function getOrCreateRelayClient(): RelayClient | null {
  if (relayClient) return relayClient;
  if (!PRIVATE_KEY || !hasRelayerCreds()) return null;
  if (relayClientInitTried) return null;
  relayClientInitTried = true;
  try {
    const privateKey = (PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`) as Hex;
    const account = privateKeyToAccount(privateKey);
    const wallet = createWalletClient({
      account,
      chain: polygon,
      transport: http("https://polygon-bor-rpc.publicnode.com", { timeout: 30_000 }),
    });
    const builderConfig = new BuilderConfig({
      localBuilderCreds: {
        key: POLY_BUILDER_API_KEY,
        secret: POLY_BUILDER_SECRET,
        passphrase: POLY_BUILDER_PASSPHRASE,
      },
    }) as any;
    relayClient = new RelayClient(
      "https://relayer-v2.polymarket.com/",
      137,
      wallet,
      builderConfig,
      RelayerTxType.PROXY,
    );
    console.log("[Claim] Relayer 客户端初始化成功，Claim 将优先走 gasless。");
    return relayClient;
  } catch (err) {
    console.error(`[Claim] Relayer 客户端初始化失败，回退链上直发: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function tryGaslessRedeemBatch(
  client: RelayClient,
  calls: { to: `0x${string}`; data: `0x${string}`; value: "0" }[],
): Promise<string> {
  const response: any = await client.execute(calls, `Web Claim ${calls.length} positions`);
  const txId = response?.hash ?? response?.transactionID ?? "";
  const receipt = await response.wait();
  const state = String(receipt?.state ?? "");
  if (state === "STATE_CONFIRMED" || state === "STATE_MINED") {
    return txId;
  }
  throw new Error(`Relayer 状态异常: ${state || "unknown"}`);
}

async function detectSafeClaimSupport(
  provider: ethers.Provider,
  safeAddress: string,
): Promise<boolean> {
  try {
    const code = await provider.getCode(safeAddress);
    if (!code || code === "0x") return false;
    const nonceData = new ethers.Interface([
      "function nonce() view returns (uint256)",
    ]).encodeFunctionData("nonce");
    await provider.call({ to: safeAddress, data: nonceData });
    return true;
  } catch {
    return false;
  }
}

async function getProxyOwnerAddress(
  provider: ethers.Provider,
  proxyAddress: string,
): Promise<string | null> {
  try {
    const ownerData = new ethers.Interface([
      "function owner() view returns (address)",
    ]).encodeFunctionData("owner");
    const raw = await provider.call({ to: proxyAddress, data: ownerData });
    const [owner] = new ethers.Interface([
      "function owner() view returns (address)",
    ]).decodeFunctionResult("owner", raw);
    return String(owner);
  } catch {
    return null;
  }
}

async function runClaim(options: { refreshAfter?: boolean } = {}): Promise<{ title: string; txHash?: string; error?: string }[]> {
  const { refreshAfter = true } = options;
  if (!PROXY_ADDRESS || !PRIVATE_KEY) return [];
  if (claimInProgress) return [];
  if (!claimablePositions.length) return [];
  claimInProgress = true;

  const contracts = getContractConfig(137);
  const CTF = contracts.conditionalTokens;
  const USDC_ADDR = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // 与 poly-redeem 一致，CTF redeem 使用 USDC.e
  const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

  const provider = new ethers.JsonRpcProvider("https://polygon-bor-rpc.publicnode.com", 137, { staticNetwork: true });
  provider.on('error', (e) => console.error('[RPC]', e.message));
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const ctfIface = new ethers.Interface([
    "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)"
  ]);
  const safeIface = new ethers.Interface([
    "function nonce() view returns (uint256)",
    "function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)",
    "function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool)",
  ]);
  const proxyFactoryIface = new ethers.Interface([
    "function proxy((uint8 typeCode,address to,uint256 value,bytes data)[] calls) payable returns (bytes[] returnValues)",
  ]);
  const safe = new ethers.Contract(PROXY_ADDRESS, safeIface, wallet);
  const proxyFactory = new ethers.Contract(POLY_PROXY_FACTORY_ADDRESS, proxyFactoryIface, wallet);
  const relayer = getOrCreateRelayClient();

  if (safeClaimSupport == null) {
    safeClaimSupport = await detectSafeClaimSupport(provider, PROXY_ADDRESS);
  }
  const claimMode = safeClaimSupport ? "safe" : "proxy_factory";
  console.log(`[Claim] 使用执行模式: ${claimMode}`);
  if (claimMode === "proxy_factory") {
    const owner = await getProxyOwnerAddress(provider, PROXY_ADDRESS);
    if (owner && owner.toLowerCase() !== wallet.address.toLowerCase()) {
      const msg = `当前私钥地址 ${wallet.address} 不是代理钱包 owner(${owner})，无法发起 claim。请在 .env 使用该代理钱包对应的私钥。`;
      console.error(`[Claim] ${msg}`);
      claimInProgress = false;
      return claimablePositions.map((p) => ({ title: p.title, error: msg }));
    }
  }

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
        const indexSet = 1 << p.outcomeIndex;
        const calldata = ctfIface.encodeFunctionData("redeemPositions", [
          USDC_ADDR, ZERO_BYTES32, p.conditionId, [indexSet]
        ]);
        if (relayer) {
          console.log("[Claim] 发送 Relayer(gasless) 交易...");
          const txHash = await tryGaslessRedeemBatch(relayer, [
            { to: CTF as `0x${string}`, data: calldata as `0x${string}`, value: "0" },
          ]);
          console.log(`[Claim] ✓ 成功 ${p.title} → ${txHash || "(relayer id unavailable)"}`);
          results.push({ title: p.title, txHash: txHash || undefined });
          broadcast("claimProgress", { current: i + 1, total, title: p.title, status: "success" });
          continue;
        }
        let tx: ethers.TransactionResponse;
        if (claimMode === "safe") {
          const nonce = await safe.nonce();
          console.log(`[Claim] nonce:${nonce} 构建 Safe 交易...`);
          const txHash = await safe.getTransactionHash(CTF, 0, calldata, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce);
          const sig = await wallet.signMessage(ethers.getBytes(txHash));
          const v = parseInt(sig.slice(-2), 16) + 4;
          const adjustedSig = sig.slice(0, -2) + v.toString(16).padStart(2, '0');
          console.log(`[Claim] 发送 Safe 交易...`);
          tx = await safe.execTransaction(CTF, 0, calldata, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, adjustedSig);
        } else {
          console.log(`[Claim] 发送 ProxyFactory 交易...`);
          tx = await proxyFactory.proxy([
            { typeCode: 1, to: CTF, value: 0, data: calldata },
          ]);
        }
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
  return { rem, upPct, dnPct, diff, now, prevUpPct: strategyRuntime.prevUpPct };
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
    let result = await clobClient!.postOrder(signedOrder, OrderType.FOK);
    let orderError = extractOrderError(result);
    const needRefreshCreds = result?.status === 401 || (orderError && isUnauthorizedApiKeyError(orderError));
    if (needRefreshCreds) {
      console.warn(`${orderTag} 检测到 API 凭证失效，自动重建并重试一次下单`);
      if (await rebuildClobClientCreds()) {
        result = await clobClient!.postOrder(signedOrder, OrderType.FOK);
        orderError = extractOrderError(result);
      }
    }
    const sideZh = side === "buy" ? "买入" : "卖出";
    const dirZh = direction === "up" ? "涨" : "跌";
    const rawStatus = result?.status ?? "未知";

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
    if (isUnauthorizedApiKeyError(msg)) {
      console.warn(`${orderTag} 捕获到 401 API key 错误，自动重建 CLOB 凭证`);
      await rebuildClobClientCreds();
    }
    console.error(`${orderTag} 失败:`, msg);
    return {
      success: false,
      statusCode: 500,
      body: { error: msg },
      errorMessage: msg,
    };
  }
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
let backtestCollecting = false;
let backtestLastTickTs = 0;

function setBacktestCollecting(enabled: boolean): void {
  backtestCollecting = enabled;
  console.log(`[Backtest] 数据收集${enabled ? "已开启" : "已关闭"}`);
  if (enabled) {
    mkdirSync(BACKTEST_DATA_DIR, { recursive: true });
  }
  broadcastBacktestStatus();
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

// ── REST：Claim 接口 ──────────────────────────────────────────
app.post("/api/claim", async (_req, res) => {
  if (!PROXY_ADDRESS || !PRIVATE_KEY) {
    res.status(500).json({ error: "未配置钱包信息" }); return;
  }
  if (claimInProgress) {
    res.status(429).json({ error: "领取中，请稍候" }); return;
  }
  claimNextCheckAt = 0;
  broadcastClaimCooldown(true);
  const synced = await syncClaimable({ clearOnError: true });
  if (!synced) {
    scheduleClaimCycle();
    res.status(503).json({ error: "查询可领取仓位失败，请稍后重试" }); return;
  }
  if (!claimablePositions.length) {
    scheduleClaimCycle();
    res.status(400).json({ error: "暂无可领取资金" }); return;
  }
  const results = await runClaim({ refreshAfter: false });
  scheduleClaimCycle();
  res.json({ results });
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

// ── 浏览器 WS 连接 ────────────────────────────────────────────
if (wss) {
  wss.on("connection", (ws, req) => {
    const dataMode = resolveClientDataModeFromUrl(req.url);
    clientSessions.set(ws, createClientSession(dataMode));
    console.log(`[WS] 浏览器已连接，当前: ${wss!.clients.size} mode=${dataMode}`);
    send(ws, "clientConfig", { dataMode });
    sendStateToClient(ws, { includeHistory: true });
    sendTradeHistoryToClient(ws);
    send(ws, "wsStatus", wsStatus as unknown as Record<string, unknown>);
    send(ws, "claimable", { total: claimableTotal, positions: claimablePositions });
    send(ws, "claimCooldown", { running: claimCycleRunning || claimInProgress, nextCheckAt: claimNextCheckAt });
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
  scheduleClaimCycle(0);

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

/**
 * 策略5 · 概率追赶 — diff穿越时概率偏低，等概率追赶diff后止盈
 *
 * 核心逻辑：diff突破阈值的瞬间，如果概率还没跟上（和历史合理概率有偏差），
 * 说明市场反应慢，入场买入等概率追赶。
 *
 * 数据验证：4.5天数据显示，偏差≥10%时92%获利率，30秒内平均追赶16%。
 */

import type {
  IStrategy, StrategyKey, StrategyNumber, StrategyDirection,
  StrategyTickContext, EntrySignal, ExitSignal, StrategyDescription,
} from "./types.js";

// ── 入场参数 ────────────────────────────────────────────────
const ENTRY_DIFF = 25;                   // diff 穿越此阈值时检查偏差
const ENTRY_BIAS_MIN = 10;              // 概率偏差至少此百分点才入场（合理概率 - 实际概率 ≥ 10）
const WINDOW_MAX_REMAINING = 240;        // 入场扫描起始：剩余 ≤240s
const WINDOW_MIN_REMAINING = 30;         // 入场扫描截止：剩余 ≤30s

// ── 出场参数 ────────────────────────────────────────────────
const TP_BIAS_CLOSE = 3;                 // 偏差缩小到此值以下止盈（概率已追赶到位）
const SL_BIAS_EXPAND = 1.5;              // 偏差扩大到入场时的此倍数止损（概率反向走）
const MAX_HOLD_SECONDS = 30;             // 最大持仓秒数，超时按当前价平仓
const FORCE_EXIT_REM = 8;               // 窗口结束前强制平仓

// ── 合理概率映射表（diff桶×rem段 → upPct中位数） ─────────────
// 基于 2026-04-03 ~ 2026-04-07 的 30万条 tick 数据统计
// key 格式: "diff,remBin" → upPct 中位数
const FAIR_PROB_RAW: Array<[number, string, number]> = [
  [-140,"30-60",1],[-140,"60-120",1],[-140,"120-180",4],
  [-130,"30-60",1],[-130,"60-120",3],[-130,"120-180",4],
  [-125,"30-60",1],[-125,"60-120",3],[-125,"120-180",5],[-125,"180-240",9],
  [-120,"30-60",1],[-120,"60-120",2],[-120,"120-180",4],[-120,"180-240",9],
  [-105,"30-60",1],[-105,"60-120",3],[-105,"120-180",6],[-105,"180-240",12],
  [-95,"30-60",1],[-95,"60-120",4],[-95,"120-180",6],[-95,"180-240",15],
  [-90,"30-60",2],[-90,"60-120",3],[-90,"120-180",9],[-90,"180-240",15],
  [-80,"30-60",1],[-80,"60-120",3],[-80,"120-180",10],[-80,"180-240",13],
  [-70,"30-60",3],[-70,"60-120",6],[-70,"120-180",8],[-70,"180-240",17],
  [-60,"30-60",3],[-60,"60-120",7],[-60,"120-180",14],[-60,"180-240",18],
  [-50,"30-60",4],[-50,"60-120",7],[-50,"120-180",13],[-50,"180-240",23],
  [-45,"30-60",4],[-45,"60-120",8],[-45,"120-180",16],[-45,"180-240",19],
  [-40,"30-60",5],[-40,"60-120",10],[-40,"120-180",17],[-40,"180-240",22],
  [-35,"30-60",5],[-35,"60-120",10],[-35,"120-180",19],[-35,"180-240",26],
  [-30,"30-60",7],[-30,"60-120",16],[-30,"120-180",21],[-30,"180-240",27],
  [-25,"30-60",8],[-25,"60-120",16],[-25,"120-180",26],[-25,"180-240",30],
  [-20,"30-60",14],[-20,"60-120",19],[-20,"120-180",27],[-20,"180-240",32],
  [-15,"30-60",19],[-15,"60-120",28],[-15,"120-180",33],[-15,"180-240",36],
  [-10,"30-60",25],[-10,"60-120",32],[-10,"120-180",37],[-10,"180-240",39],
  [-5,"30-60",35],[-5,"60-120",41],[-5,"120-180",44],[-5,"180-240",45],
  [0,"30-60",52],[0,"60-120",52],[0,"120-180",52],[0,"180-240",52],
  [5,"30-60",65],[5,"60-120",62],[5,"120-180",58],[5,"180-240",57],
  [10,"30-60",78],[10,"60-120",68],[10,"120-180",64],[10,"180-240",62],
  [15,"30-60",83],[15,"60-120",72],[15,"120-180",67],[15,"180-240",67],
  [20,"30-60",88],[20,"60-120",81],[20,"120-180",74],[20,"180-240",70],
  [25,"30-60",92],[25,"60-120",85],[25,"120-180",76],[25,"180-240",71],
  [30,"30-60",94],[30,"60-120",89],[30,"120-180",86],[30,"180-240",75],
  [35,"30-60",95],[35,"60-120",91],[35,"120-180",82],[35,"180-240",75],
  [40,"30-60",95],[40,"60-120",91],[40,"120-180",82],[40,"180-240",73],
  [45,"30-60",95],[45,"60-120",93],[45,"120-180",83],[45,"180-240",79],
  [50,"30-60",97],[50,"60-120",93],[50,"120-180",87],[50,"180-240",76],
  [55,"30-60",98],[55,"60-120",92],[55,"120-180",86],[55,"180-240",80],
  [60,"30-60",98],[60,"60-120",94],[60,"120-180",88],[60,"180-240",81],
  [65,"30-60",98],[65,"60-120",96],[65,"120-180",88],[65,"180-240",81],
  [70,"30-60",99],[70,"60-120",97],[70,"120-180",91],[70,"180-240",85],
  [75,"30-60",99],[75,"60-120",97],[75,"120-180",92],[75,"180-240",88],
  [80,"30-60",100],[80,"60-120",96],[80,"120-180",92],[80,"180-240",86],
  [85,"30-60",100],[85,"60-120",97],[85,"120-180",93],[85,"180-240",89],
  [90,"30-60",100],[90,"60-120",98],[90,"120-180",94],[90,"180-240",90],
  [95,"30-60",100],[95,"60-120",98],[95,"120-180",92],[95,"180-240",92],
];

const FAIR_PROB_MAP = new Map<string, number>();
for (const [diff, rb, prob] of FAIR_PROB_RAW) {
  FAIR_PROB_MAP.set(`${diff},${rb}`, prob);
}

function getRemBin(rem: number): string | null {
  if (rem >= 180 && rem < 240) return "180-240";
  if (rem >= 120 && rem < 180) return "120-180";
  if (rem >= 60 && rem < 120) return "60-120";
  if (rem >= 30 && rem < 60) return "30-60";
  return null;
}

function getFairProb(diff: number, rem: number): number | null {
  const db = Math.round(diff / 5) * 5;
  const rb = getRemBin(rem);
  if (!rb) return null;
  return FAIR_PROB_MAP.get(`${db},${rb}`) ?? null;
}

interface S5State {
  lastDiff: number | null;
  entryBias: number;       // 入场时的偏差值
  entryTs: number;         // 入场时间戳
}

function createState(): S5State {
  return {
    lastDiff: null,
    entryBias: 0,
    entryTs: 0,
  };
}

export class S5ProbChase implements IStrategy {
  readonly key: StrategyKey = "s5";
  readonly number: StrategyNumber = 5;
  readonly name = "概率追赶";

  private s: S5State = createState();

  getDescription(): StrategyDescription {
    return {
      key: this.key,
      number: this.number,
      name: this.name,
      title: "策略5 · 概率追赶",
      lines: [
        { text: `⏱ 剩余 ${WINDOW_MAX_REMAINING}s~${WINDOW_MIN_REMAINING}s 时检测` },
        { text: `📈 diff穿越±${ENTRY_DIFF}且概率偏差≥${ENTRY_BIAS_MIN}%时入场` },
        { text: "偏差 = 历史合理概率 - 当前概率（概率还没跟上diff）" },
        { text: `止盈：偏差缩小到<${TP_BIAS_CLOSE}%（概率追赶到位）`, color: "#3fb950", marginTop: true },
        { text: `止损：偏差扩大到入场时的${SL_BIAS_EXPAND}倍`, color: "#f85149" },
        { text: `超时：持仓超${MAX_HOLD_SECONDS}秒或剩余<${FORCE_EXIT_REM}秒平仓`, color: "#f85149" },
        { text: "基于 diff+rem 二维映射表判断合理概率", color: "#888", marginTop: true },
      ],
    };
  }

  updateGuards(_ctx: StrategyTickContext): void {}

  checkEntry(ctx: StrategyTickContext): EntrySignal | null {
    const { rem, upPct, dnPct, diff } = ctx;
    if (upPct == null || dnPct == null || diff == null) return null;
    if (rem > WINDOW_MAX_REMAINING || rem <= WINDOW_MIN_REMAINING) return null;

    const lastDiff = this.s.lastDiff;
    if (lastDiff == null) return null;

    // 买涨穿越
    if (lastDiff <= ENTRY_DIFF && diff > ENTRY_DIFF) {
      const fair = getFairProb(diff, rem);
      if (fair != null && fair - upPct >= ENTRY_BIAS_MIN) {
        this.s.entryBias = fair - upPct;
        return { direction: "up" };
      }
    }

    // 买跌穿越
    if (lastDiff >= -ENTRY_DIFF && diff < -ENTRY_DIFF) {
      const fair = getFairProb(diff, rem);
      if (fair != null) {
        const fairDn = 100 - fair;
        const bias = fairDn - dnPct;
        if (bias >= ENTRY_BIAS_MIN) {
          this.s.entryBias = bias;
          return { direction: "down" };
        }
      }
    }

    return null;
  }

  onEntryFilled(ctx: StrategyTickContext, _direction: StrategyDirection): void {
    this.s.entryTs = ctx.now;
  }

  checkExit(ctx: StrategyTickContext, direction: StrategyDirection): ExitSignal {
    const { rem, upPct, dnPct, diff, now } = ctx;
    if (upPct == null || dnPct == null || diff == null) return null;

    const myPct = direction === "up" ? upPct : dnPct;
    const fair = getFairProb(diff, rem);

    // 强制平仓
    if (rem <= FORCE_EXIT_REM && rem > 0) {
      return { signal: myPct >= 50 ? "tp" : "sl", reason: `强制平仓 剩余${rem}秒 概率${myPct}%` };
    }

    // 超时平仓
    if (this.s.entryTs > 0 && now - this.s.entryTs > MAX_HOLD_SECONDS * 1000) {
      return { signal: myPct >= 50 ? "tp" : "sl", reason: `超时平仓 持仓${Math.round((now - this.s.entryTs) / 1000)}秒 概率${myPct}%` };
    }

    if (fair == null) return null;

    // 当前偏差
    const currentBias = direction === "up"
      ? fair - upPct
      : (100 - fair) - dnPct;

    // 止盈：偏差缩小到阈值以下（概率追赶到位）
    if (currentBias <= TP_BIAS_CLOSE) {
      return { signal: "tp", reason: `概率追赶到位 偏差${currentBias}%<${TP_BIAS_CLOSE}% 概率${myPct}%` };
    }

    // 止损：偏差扩大到入场时的倍数（概率反向走）
    if (this.s.entryBias > 0 && currentBias >= this.s.entryBias * SL_BIAS_EXPAND) {
      return { signal: "sl", reason: `偏差扩大 ${currentBias}%≥${Math.round(this.s.entryBias * SL_BIAS_EXPAND)}% 入场偏差${this.s.entryBias}%` };
    }

    // 止损：diff反转（趋势完全消失）
    if (direction === "up" && diff <= 0) {
      return { signal: "sl", reason: `diff反转 差价${Math.round(diff)}≤0` };
    }
    if (direction === "down" && diff >= 0) {
      return { signal: "sl", reason: `diff反转 差价${Math.round(diff)}≥0` };
    }

    return null;
  }

  finalizeTick(diff: number | null): void {
    this.s.lastDiff = diff;
  }

  resetState(): void {
    this.s = createState();
  }

  getStatePayload(): Record<string, unknown> {
    return {
      lastDiff: this.s.lastDiff,
      entryBias: this.s.entryBias,
      entryTs: this.s.entryTs,
    };
  }
}

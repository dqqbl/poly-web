/**
 * 策略7 · 峰值阈扫尾 — 基于策略6：rem>90 时记录涨跌方向各自峰值 diff，
 * rem≤90 后需 diff 突破该方向峰值的 30% 才入场；diff 下限 15（高于 s6 的 10）
 */

import type {
  IStrategy, StrategyKey, StrategyNumber, StrategyDirection,
  StrategyTickContext, EntrySignal, ExitSignal, StrategyDescription,
} from "./types.js";

const WINDOW_MAX_REMAINING = 90;
const ENTRY_PROB_CAP = 90;
/** diff 入场门槛下限；动态阈值 max(本值, 峰值×比例) */
const MIN_ENTRY_DIFF = 15;
const PEAK_FRACTION = 0.3;

interface S7State {
  upMaxDiff: number;
  downMaxDiff: number;
}

function createState(): S7State {
  return { upMaxDiff: Number.NEGATIVE_INFINITY, downMaxDiff: Number.NEGATIVE_INFINITY };
}

export class S7PeakSweep implements IStrategy {
  readonly key: StrategyKey = "s7";
  readonly number: StrategyNumber = 7;
  readonly name = "峰值阈扫尾";

  private s: S7State = createState();

  getDescription(): StrategyDescription {
    return {
      key: this.key,
      number: this.number,
      name: this.name,
      title: "策略7 · 峰值阈扫尾",
      lines: [
        { text: `⏱ rem>${WINDOW_MAX_REMAINING}s 时记录峰值；剩余≤${WINDOW_MAX_REMAINING}s 时检测入场` },
        { text: `📈 涨侧峰值 up_max：rem>90 期间 diff>0 时的最大 diff` },
        { text: `📉 跌侧峰值 down_max：rem>90 期间 diff<0 时的最大 |diff|` },
        { text: `入场：diff > max(${MIN_ENTRY_DIFF}, up_max×${PEAK_FRACTION})，涨概率<${ENTRY_PROB_CAP}%（跌对称）`, marginTop: true },
        { text: `若某侧未采到峰值，该侧仅用下限 ±${MIN_ENTRY_DIFF}`, color: "#888" },
        { text: "止盈：>40s ≥98% / >20s ≥99% / >10s ≥100% / <10s 持仓到结束", color: "#3fb950", marginTop: true },
        { text: "无 diff 止损", color: "#888" },
      ],
    };
  }

  updateGuards(ctx: StrategyTickContext): void {
    const { rem, diff } = ctx;
    if (diff == null) return;
    if (rem <= WINDOW_MAX_REMAINING) return;
    if (diff > 0) {
      this.s.upMaxDiff = Math.max(this.s.upMaxDiff, diff);
    }
    if (diff < 0) {
      this.s.downMaxDiff = Math.max(this.s.downMaxDiff, -diff);
    }
  }

  private upEntryThreshold(): number {
    if (this.s.upMaxDiff <= 0) return MIN_ENTRY_DIFF;
    return Math.max(MIN_ENTRY_DIFF, this.s.upMaxDiff * PEAK_FRACTION);
  }

  private downEntryThreshold(): number {
    if (this.s.downMaxDiff <= 0) return MIN_ENTRY_DIFF;
    return Math.max(MIN_ENTRY_DIFF, this.s.downMaxDiff * PEAK_FRACTION);
  }

  checkEntry(ctx: StrategyTickContext): EntrySignal | null {
    const { rem, upPct, dnPct, diff } = ctx;
    if (upPct == null || dnPct == null || diff == null) return null;
    if (rem > WINDOW_MAX_REMAINING || rem <= 0) return null;

    const upTh = this.upEntryThreshold();
    const dnTh = this.downEntryThreshold();

    if (diff > upTh && upPct < ENTRY_PROB_CAP) return { direction: "up" };
    if (diff < -dnTh && dnPct < ENTRY_PROB_CAP) return { direction: "down" };
    return null;
  }

  checkExit(ctx: StrategyTickContext, direction: StrategyDirection): ExitSignal {
    const { rem, upPct, dnPct } = ctx;
    if (upPct == null || dnPct == null) return null;
    const myPct = direction === "up" ? upPct : dnPct;

    if (rem >= 40 && myPct >= 98) return { signal: "tp", reason: `阶梯止盈 概率${myPct}%≥98% rem=${rem}s` };
    if (rem >= 20 && rem < 40 && myPct >= 99) return { signal: "tp", reason: `阶梯止盈 概率${myPct}%≥99% rem=${rem}s` };
    if (rem >= 10 && rem < 20 && myPct >= 100) return { signal: "tp", reason: `阶梯止盈 概率${myPct}%≥100% rem=${rem}s` };

    return null;
  }

  resetState(): void {
    this.s = createState();
  }

  getStatePayload(): Record<string, unknown> {
    return {
      upMaxDiff: Number.isFinite(this.s.upMaxDiff) ? this.s.upMaxDiff : null,
      downMaxDiff: Number.isFinite(this.s.downMaxDiff) ? this.s.downMaxDiff : null,
    };
  }
}

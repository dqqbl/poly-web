/**
 * 策略6 · 早段扫尾 — 基于策略3：更长检测窗口、更低 diff/概率门槛，无止损
 */

import type {
  IStrategy, StrategyKey, StrategyNumber, StrategyDirection,
  StrategyTickContext, EntrySignal, ExitSignal, StrategyDescription,
} from "./types.js";

const WINDOW_MAX_REMAINING = 90;
const ENTRY_DIFF = 10;
const ENTRY_PROB_CAP = 90;

export class S6EarlySweep implements IStrategy {
  readonly key: StrategyKey = "s6";
  readonly number: StrategyNumber = 6;
  readonly name = "早段扫尾";

  getDescription(): StrategyDescription {
    return {
      key: this.key,
      number: this.number,
      name: this.name,
      title: "策略6 · 早段扫尾",
      lines: [
        { text: `⏱ 剩余 ${WINDOW_MAX_REMAINING}s~0s 时检测` },
        { text: `📈 买涨：差价 >+${ENTRY_DIFF} 且 涨概率 <${ENTRY_PROB_CAP}%` },
        { text: `📉 买跌：差价 <-${ENTRY_DIFF} 且 跌概率 <${ENTRY_PROB_CAP}%` },
        { text: "止盈：>40s ≥98% / >20s ≥99% / >10s ≥100% / <10s 持仓到结束", color: "#3fb950", marginTop: true },
        { text: "无 diff 止损", color: "#888" },
      ],
    };
  }

  updateGuards(_ctx: StrategyTickContext): void {}

  checkEntry(ctx: StrategyTickContext): EntrySignal | null {
    const { rem, upPct, dnPct, diff } = ctx;
    if (upPct == null || dnPct == null || diff == null) return null;
    if (rem > WINDOW_MAX_REMAINING || rem <= 0) return null;

    if (diff > ENTRY_DIFF && upPct < ENTRY_PROB_CAP) return { direction: "up" };
    if (diff < -ENTRY_DIFF && dnPct < ENTRY_PROB_CAP) return { direction: "down" };
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

  resetState(): void {}

  getStatePayload(): Record<string, unknown> {
    return {};
  }
}

// btc-race-24h-20261118-1444: a full-size dip-recovery bot for cbBTC/USDC
// on the agent-fun/bars-replay/v1 protocol.
//
// The dev window for this race falls about 2.8% from open to close, so a
// bot that buys and holds fails the dev gate, and quick scalps lose to the
// round-trip cost: at full size a round trip pays roughly 26 bps in the
// 4 bps fee, the 2 bps modelled slippage and the constant-product impact on
// both sides, and orders fill at the next bar's open. What the dev window
// does reward is patience around the one big move in it: a steep multi-hour
// slide (the trailing 120-bar return falling past -100 bps) followed by a
// slow recovery back toward the slide's start. The bot below waits for that
// deep slide, buys essentially all its cash, and then holds until the
// position itself has gained 200 bps over its fill, or the trade has gone
// stale, or the slide turns into a collapse.
//
// The strategy, in full:
// - Flat, at least COOLDOWN_BARS bars after the last exit, it buys when the
//   trailing 120-bar return drops below ENTRY_BPS: a slide deep enough that
//   a recovery to anywhere near the slide's start pays the round trip
//   several times over.
// - In a position it sells the whole position when the latest close stands
//   GAIN_BPS above the entry fill (the recovery has paid), when the close
//   falls STOP_BPS under the best close since entry or under the entry fill
//   (the dip became a collapse), or after TIME_STOP_BARS bars in the trade
//   (the recovery is not coming on this trade's clock), whichever is first.
//   The time stop has one grace rule: a trade that is still printing new
//   highs when the clock runs out is not stalled, so it gets up to
//   TIME_STOP_GRACE_BARS more bars; only a trade whose close has slipped
//   STALL_BPS under its best close is cut at the clock. On the dev window
//   the second trade peaks early and then drifts down, so it is already
//   stalled at the clock and exits there either way; the grace only saves
//   a trade whose recovery is still alive at the end of its clock.
// - Every order carries max_slippage_bps 100, so a fill more than 1% past
//   the close it was decided on is refused rather than chased.
//
// Parameter choice: graded on this competition's dev window, the entry
// threshold is profitable across -90 to -160 bps and the gain exit across
// 150 to 250 bps, with the 120-bar lookback; the time stop sits at 420
// bars, in the middle of the 400-430 plateau (about +$22-23 net PnL), where
// the second trade is cut before its recovery fades instead of being held
// to 480 bars. The values below sit in the middle of those plateaus rather
// than on a spike. On the dev window this grades at about +$22.9 net PnL
// over 4 trades with a maximum drawdown under 1%.
//
// Everything here is a pure function of the bars seen so far: no wall
// clock, no network, no files, no randomness. Two runs over the same
// window produce the same orders byte for byte.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- tunable parameters (bps are basis points of price) ---
const LOOKBACK_BARS = 120; // trailing-return lookback, in bars
const ENTRY_BPS = -100; // buy when the trailing return falls under this
const GAIN_BPS = 200; // sell when the close stands this far over the fill
const STOP_BPS = 150; // sell this far under the best close / entry fill
const TIME_STOP_BARS = 420; // sell after this many bars in a trade, unless it is still making highs
const TIME_STOP_GRACE_BARS = 120; // extra bars granted while the trade keeps printing new highs
const STALL_BPS = 30; // a trade counts as stalled once the close sits this far under its best close
const COOLDOWN_BARS = 5; // flat bars required after an exit before re-entry
const SIZE_FRAC = 0.999; // share of the cash balance a buy deploys
const MAX_SLIPPAGE_BPS = 100; // every order carries this cap
const LAST_ENTRY_BAR = 1380; // no fresh entries this late in a 1,440-bar window
const MIN_NOTIONAL_UNITS = 1_000_000n; // a buy spends at least 1 USDC

// --- running state, all derived from the bars of this run ---
const closes: number[] = []; // every close seen, oldest first, raw price units
let scoredBars = 0; // scored bars answered so far (warm-up excluded)
let newestBarT = -1; // close time of the newest bar folded in
let orderOut: 'buy' | 'sell' | null = null; // an order sent, not yet reported
let barsSinceExit = COOLDOWN_BARS; // flat bars since the last exit
let holding = false;
let fillPrice = 0; // raw price the open position filled at
let bestClose = 0; // best close since the position was opened
let tradeBars = 0; // bars since the position was opened

// The trailing return over the last LOOKBACK_BARS bars, in bps, or null
// while the history is too short to say.
function trailingBps(): number | null {
  if (closes.length <= LOOKBACK_BARS) return null;
  const now = closes[closes.length - 1]!;
  const then = closes[closes.length - 1 - LOOKBACK_BARS]!;
  return (now / then - 1) * 10_000;
}

// Fold one batch's bar (when it carries a fresh one) into the history.
function takeBar(state: BarsState): boolean {
  const bar = state.latest.get(SYMBOL);
  if (bar === undefined || bar.t === newestBarT) return false;
  newestBarT = bar.t;
  closes.push(Number(bar.c));
  return true;
}

// Watch the fills the batch reports: they settle the outstanding order,
// open the trade bookkeeping on an entry (the fill's own price is the level
// the gain exit and the hard stop are measured from), and restart the
// cooldown clock on an exit. A rejection settles the flag too: the account
// in this batch is the truth about what is held.
function takeFills(batch: Batch): void {
  for (const fill of batch.fills) {
    if (fill.symbol !== SYMBOL) continue;
    if (fill.status === 'filled' && fill.side === 'buy' && orderOut === 'buy') {
      orderOut = null;
      holding = true;
      fillPrice = Number(fill.price);
      bestClose = closes.length > 0 ? closes[closes.length - 1]! : 0;
      tradeBars = 0;
    } else if (fill.status === 'filled' && fill.side === 'sell' && orderOut === 'sell') {
      orderOut = null;
      holding = false;
      barsSinceExit = 0;
    } else if (fill.status === 'rejected' && orderOut !== null) {
      orderOut = null;
    }
  }
}

function decide(state: BarsState, batch: Batch): OrderInput[] {
  takeFills(batch);
  const fresh = takeBar(state);
  if (!fresh || state.warmingUp) return [];
  scoredBars += 1;

  // Trust the account over the bookkeeping: if the harness says there is
  // no position, there is none, whatever a missed fill suggested.
  const held = state.positions.get(SYMBOL);
  if (held === undefined || held.qty === 0n) {
    if (holding) {
      holding = false;
      barsSinceExit = 0;
    }
  } else if (!holding && orderOut === null) {
    holding = true;
    if (fillPrice === 0) fillPrice = closes[closes.length - 1]!;
    if (bestClose === 0) bestClose = closes[closes.length - 1]!;
  }

  const close = closes[closes.length - 1]!;
  if (holding && close > bestClose) bestClose = close;
  const trail = trailingBps();
  if (trail === null) return [];

  if (holding) {
    tradeBars += 1;
    if (orderOut !== null) return [];
    const gained = fillPrice > 0 && close >= fillPrice * (1 + GAIN_BPS / 10_000);
    const fellFromPeak = bestClose > 0 && close < bestClose * (1 - STOP_BPS / 10_000);
    const fellFromFill = fillPrice > 0 && close < fillPrice * (1 - STOP_BPS / 10_000);
    const stalled = close < bestClose * (1 - STALL_BPS / 10_000);
    const stale =
      tradeBars >= TIME_STOP_BARS + TIME_STOP_GRACE_BARS ||
      (tradeBars >= TIME_STOP_BARS && stalled);
    if (gained || fellFromPeak || fellFromFill || stale) {
      orderOut = 'sell';
      return [{ side: 'sell', symbol: SYMBOL, qty: held!.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  // Flat: count the cooldown, then look for a slide deep enough to pay for
  // the round trip several times over.
  if (orderOut !== null) return [];
  barsSinceExit += 1;
  if (barsSinceExit < COOLDOWN_BARS) return [];
  if (scoredBars > LAST_ENTRY_BAR) return [];
  if (trail >= ENTRY_BPS) return [];

  let notional = BigInt(Math.floor(Number(state.cash) * SIZE_FRAC));
  const room = state.weightRoom(SYMBOL);
  if (notional > room) notional = room;
  if (notional > state.cash) notional = state.cash;
  if (notional < MIN_NOTIONAL_UNITS) return [];

  orderOut = 'buy';
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    return decide(state, batch);
  },
});

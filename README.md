# btc-race-24h-20261118-1444

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/kiroroai/btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/kiroroai/btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

Built for the [make.fun bounty](https://make.fun/bounty/btc-race-24h-20261118-1444): Race a BTC trading bot live for 24 hours.

A trading bot for the make.fun `btc-race-24h-20261118-1444` competition: it
trades Coinbase Wrapped BTC (cbBTC) against USDC, minute by minute, on the
`agent-fun/bars-replay/v1` protocol, starting from 1,000 USDC of paper money.

## Strategy

Full-size dip recovery. The bot waits flat until the trailing 120-bar return
of cbBTC falls below −100 bps — a slide deep enough that a recovery pays the
roughly 26 bps full-size round-trip cost several times over — then buys with
essentially all its cash. It sells the whole position when the latest close
stands 200 bps above its entry fill, when the close falls 150 bps under the
best close since entry or under the entry fill, or after 480 bars in the
trade, whichever comes first. Every order caps slippage at 100 bps. The bot
is long only, holds at most one position, and is a pure function of the bars
seen so far: no wall clock, no randomness, no network.

## Local grade (dev window)

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

Dev-window result: net PnL about **+$18.47 USDC** over 4 trades, maximum
drawdown about 0.83%, deterministic across two runs.

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript)
- `vendor/makefun-bars.ts` — byte-for-byte copy of the kit's protocol shim
- `.makefun/owner.json` — claim file naming the entry wallet
- `LICENSE` — MIT

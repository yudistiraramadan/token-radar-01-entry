# Token Launch Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/yudistiraramadan/token-radar-01-entry/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/yudistiraramadan/token-radar-01-entry/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

An entry for make.fun's **token-radar-01** bounty. It ranks protocols that record no token by an
implied value derived from the sealed DefiLlama snapshot, and gives each one a concrete farm plan.

- `main.ts` reads the snapshot and writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json`.
- `lib/model.ts` holds the value model, the board composition, the farm-plan generator and a pre-flight copy of the gate's board checks.
- `dashboard/` is a static page (`index.html`, `app.css`, `app.js`) with no framework and no network. It reads `../data.js`.
- `vendor/makefun-board.ts` is make.fun's dossier library, vendored unmodified.

## Run

Node 22+, standard library only, no install:

```sh
MAKEFUN_INPUT=../kit/token-radar-01-kit/input/snapshot.json MAKEFUN_OUTPUT_DIR=./out node main.ts
```

Defaults are `/input/snapshot.json` and `/output`; `--input` and `--output` flags override them.
The program reads no clock, no randomness and no network, so two runs write identical bytes.
Open `out/dashboard/index.html` to see the page. The URL hash keeps the view state, for example
`#cat=RWA`, `#open=steakhouse-financial` or `#sort=tvl_usd:desc`.

## Model

```
implied_value = size_value × growth_factor × maturity_factor
```

**Size.** An OLS fit of `ln(mcap) = a + b·ln(tvl)` over every protocol whose token already trades
(gecko_id, symbol and a positive mcap recorded): 128 comparables on this snapshot, giving
`mcap ≈ 1,058 × tvl^0.522`, R² 0.19. Each category with at least 3 comparables gets a multiplier: the
median of `mcap / curve(tvl)`, shrunk toward 1 by `n / (n + 5)`. The result is clipped to
`[0.013, 3.0] × TVL`, the empirical p10 to p90 band of mcap/TVL.

**Growth.** `clamp(1 + 2 × change_7d / 100, 0.5, 2.0)`. A missing change counts as 1.0.

**Maturity.** A step function on days since `listed_at`: under 90 days ×0.6, under a year ×0.9,
one to two years ×1.1 (proven and a launch is expected), two to four years ×1.0, older ×0.85. With
no listing date, ×0.95.

**Board.** All 40 watchlist protocols, plus the 60 highest-valued pre-token protocols outside the
watchlist that pass its own cleanliness rule: no Bridge, Canonical Bridge, Liquid Staking, Liquid
Restaking, Restaked BTC or CEX category; no exchange-name prefix; no whole word wrapped, staked or
staking; no version suffix. The rows are ranked 1 to 100 by implied value, and ties break by slug.
Protocols whose token trades only price the curve and are never ranked.

**Farm plans.** Five steps per protocol. The first three depend on the category (Risk Curators,
RWA, Onchain Capital Allocator, CDP, Basis Trading, Lending, Dexs, Yield, Restaking, Chain, Payments
and Insurance, with a generic fallback) and use the protocol's chains, a deposit size by TVL tier,
gas by chain, its age and its 7-day trend. The last two are a 60-day hold and a −15% 7-day TVL exit
rule. Every step is checked to be 20 to 600 characters.

Implied values are this radar's claim from DefiLlama's record, not a forecast that any token will
launch. A protocol here *records* no token, which does not prove it has none.

## License

MIT, see `LICENSE`.

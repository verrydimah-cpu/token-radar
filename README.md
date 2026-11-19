# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/verrydimah-cpu/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/verrydimah-cpu/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it reads a sealed DefiLlama snapshot of 758 protocols and ranks the ones that record no token yet by what a token would be worth if their record stayed as it is — TVL × their category's median market-cap/TVL ratio from traded comparables, adjusted for seven-day momentum, tokenless age and chain breadth. Wrapped, staked, bridged and exchange products are set aside by a hygiene filter; all 40 watchlist protocols are covered, 198 rows in all. Every row carries a concrete farm plan with costs and time, a plain-language confidence grade, and a dossier view that shows its arithmetic line by line. The dark radar dashboard is sortable, filterable and searchable, with a method page that works the #1 row end to end. Nothing here predicts whether or when a token is issued: an implied value is this board's own claim, derived only from the snapshot's figures.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=hz6kvzj2&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>

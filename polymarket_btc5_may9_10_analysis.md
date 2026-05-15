# Polymarket BTC 5-Minute Wallet Analysis

Wallet: `0xe91016e83d11a0306c12ed390c79e89406eea40a`

Profile URL: <https://polymarket.com/@0xe91016e83d11a0306c12ed390c79e89406eea40a-1778277733959?tab=activity>

Window analyzed: May 9, 2026 12:00 AM ET through May 10, 2026 11:59:59 PM ET. I used ET because the BTC 5-minute market titles themselves are expressed in ET.

## Result

| Metric | Value |
|---|---:|
| BTC 5-minute markets traded | 90 |
| Trade fills included | 3,579 |
| Winning markets | 50 |
| Losing markets | 40 |
| Breakeven markets | 0 |
| Win rate | 55.56% |
| Total buy cost | $41,590.97 |
| Sell proceeds during the window | $5,788.00 |
| Settlement value on winning shares | $63,528.79 |
| Estimated total PnL | $27,725.82 |

## Day Breakdown

| Day | Markets | Wins | Losses | Win rate | Trade fills | Estimated PnL |
|---|---:|---:|---:|---:|---:|---:|
| May 9, 2026 | 60 | 31 | 29 | 51.67% | 3,072 | $23,634.13 |
| May 10, 2026 | 30 | 19 | 11 | 63.33% | 507 | $4,091.69 |

## Method

- Pulled public wallet activity from Polymarket Data API `/activity` with `type=TRADE`, using `start`, `end`, `limit`, and `offset`.
- The wallet had enough activity to hit the endpoint offset ceiling in a full two-day pull, so I fetched six-hour slices and deduped by transaction hash, asset, side, price, size, and timestamp.
- Filtered to markets matching Bitcoin/BTC and `-5m-`, matching the short-term crypto classifier style already in `shared/polymarket.ts`.
- Grouped fills by `conditionId`, so many fills in one 5-minute market count as one market result.
- Pulled each market's final data from Polymarket Gamma API `/events?slug=...`; all 90 markets were closed/resolved.
- Estimated market PnL as `sell proceeds - buy cost + remaining winning shares`. That matches settled binary-market economics, but it is still an estimate from public API data rather than an exchange account statement.

## Audit Notes

- Positive-PnL markets and markets where the user held net winning shares both counted to 50, so the win-rate definition was internally consistent here.
- There were 34 markets with sell proceeds during the window and 2 markets where the user had net shares in both outcomes.
- Largest win: May 9, 2026, 6:00AM-6:05AM ET, winner Up, estimated PnL $3,449.79.
- Largest loss: May 9, 2026, 12:40PM-12:45PM ET, winner Up while the wallet was net Down, estimated PnL -$992.31.

## Sources

- Polymarket Data API user activity: <https://docs.polymarket.com/api-reference/core/get-user-activity>
- Polymarket event/market metadata by slug: <https://docs.polymarket.com/api-reference/events/get-event-by-slug>

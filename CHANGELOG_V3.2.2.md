# V3.2.2 changes

Based directly on V3.2.1.

- Added market regime classification to `/market/sentiment`.
- Added `/market/sectors` full-industry ignition ranking.
- Added `/market/breakouts` B0/B1/B2/B3/FAILED lifecycle scanner.
- Added `index_matrix` to `/market/overview` for main-board, dual-innovation and size/style indices.
- Added Tushare `index_daily` fallback when a free realtime transport does not cover an index.
- Added cross-provider stock volume/amount consensus and 100x defensive normalization.
- Added history-based 100x volume sanity check in breakout scanner.
- Added qfq historical confirmation for bounded breakout candidates.
- Added signal-record schema for future +1/+3/+5/+10 day, MFE/MAE evaluation.
- Updated GPT Action OpenAPI with new sector/breakout operations.
- Preserved all V3.2.1 URLs and read-only behavior.

Known limitation: `/market/breakouts` performs a full-market realtime prefilter, then historical confirmation only for the bounded `scan_limit` pool. It intentionally reports this coverage rather than claiming every A-share received a full 180-day historical scan on every request.

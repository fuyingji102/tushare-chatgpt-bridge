# Tushare → ChatGPT V3.2 (Netlify, multi-source fallback)

这是一个**只读**的 A 股行情数据层，用来让 ChatGPT 在长期聊天里获取尽可能新的事实数据，再结合新闻和交易框架讨论市场。它不是自动交易系统，没有券商连接和下单接口。

## V3.2 的核心变化

### 1. Tushare 永远优先，权限升级后自动启用

不需要为了当前 2000 积分改掉 Tushare。每一类数据先尝试 Tushare：

```text
Tushare realtime / advanced endpoint
        ↓ success
      use it
        ↓ permission / timeout / unavailable
free fallback provider
```

因此以后开通 `rt_k`、`rt_min_daily`，或积分提高到能访问 `cyq_perf`、`kpl_list`、`limit_step` 等接口时，**不需要改 API、OpenAPI 或 ChatGPT Action**；下一次请求会自然优先使用 Tushare。

### 2. 免费实时 fallback

当前加入：

- 实时个股 quote：Eastmoney → Sina
- 分钟线：Eastmoney → Sina
- 指数：Tushare `rt_idx_k` → Eastmoney
- 行业：Tushare `rt_sw_k` → Eastmoney industry boards
- 概念：Tushare THS 概念 → Eastmoney concept boards/members
- 个股资金流：`moneyflow_ths` → Tushare 标准 `moneyflow`
- 全市场：优先 Tushare `rt_k`；Eastmoney 只有在返回覆盖足够完整时才允许用于**全市场 breadth**

免费网页数据源不是交易所 SLA 服务，可能改接口、限速或暂时不可达。因此 V3.2 的原则不是“假装永远实时”，而是**不把未知质量的数据当成 verified realtime**。

### 3. 实时有效性/准确性控制

单股 snapshot 会返回：

```text
data_quality.status
  verified   多个独立来源价格一致
  usable     可用，但独立验证不足/时间较旧
  degraded   来源明显冲突
  stale      时间戳不符合当前市场阶段
  fallback   没有可靠实时价格
```

同时提供：

- `primary_source_time`
- `primary_age_seconds`
- `cross_checks`
- `max_price_difference_pct`
- `warnings`

分钟线也有独立 `quality`。

**午休和收盘后会按市场阶段判断新鲜度**，不会因为 11:30 后没有新成交就简单把午休行情误判为坏数据。

### 4. 全市场数据不允许“100只股票冒充全市场”

如果免费源只返回涨幅榜/成交额榜等部分股票：

- `/market/scan` 可以用于找实时候选；
- `/market/sentiment` 的计数明确标成 `observed_lower_bound`；
- `/market/overview` 的全市场上涨/下跌家数等 breadth 继续使用最近完成交易日，并明确标为 fallback。

只有 provider 返回足够完整覆盖时，才能标记 `coverage=full`。

### 5. 复权/除权日处理

日线技术指标使用 Tushare qfq 历史。如果实时 `pre_close` 与最近完成日的 qfq close 因除权/除息发生尺度变化，V3.2 会先把历史 qfq 序列缩放到当前交易所 `pre_close` 基准，再加入实时 bar，避免 MA/SKDJ 因价格尺度突变失真。

### 6. 量能保护

只有确认 quote 的 `source_time` 属于**当前中国交易日**且未判为 stale 时，才计算：

- `current_volume_hands`
- `projected_full_day_volume_hands`
- `projected_volume_vs_5d_avg`

否则全部返回 `null`，绝不会再把昨日全天成交量当成今天午盘量。

## 只需要两个环境变量

Netlify：

```text
TUSHARE_TOKEN=你的 Tushare token
ACTION_API_KEY=你自己生成的随机长密码
```

**V3.2 没有新增 token。** Eastmoney / Sina fallback 不需要额外环境变量。

不要把真实 token/key 提交到 GitHub。

## 部署升级（从 V3.1.1）

把 V3.2 文件覆盖 GitHub repo 根目录，然后：

```powershell
git add -A
git commit -m "Upgrade to V3.2 multi-source fallback"
git push
```

Netlify 会自动重新部署。现有两个 Environment Variables 保持不变。

## 部署后测试

```powershell
$KEY="你的ACTION_API_KEY"
$BASE="https://tushare-chatgpt-bridge.netlify.app"

curl.exe -H "X-API-Key: $KEY" "$BASE/health"
curl.exe -H "X-API-Key: $KEY" "$BASE/diagnostics/providers?ts_code=600522.SH&freq=5MIN"
curl.exe -H "X-API-Key: $KEY" "$BASE/stock/600522.SH/snapshot"
curl.exe -H "X-API-Key: $KEY" "$BASE/stock/600522.SH/intraday?freq=5MIN"
curl.exe -H "X-API-Key: $KEY" "$BASE/market/overview"
curl.exe -H "X-API-Key: $KEY" "$BASE/market/scan"
curl.exe -H "X-API-Key: $KEY" "$BASE/market/sentiment"
curl.exe -H "X-API-Key: $KEY" "$BASE/market/themes?q=光通信"
```

### 最先看 `/diagnostics/providers`

它会告诉你：

- Tushare `rt_k` / `rt_min_daily` 是否有权限；
- Netlify 出口 IP 能否访问 Eastmoney/Sina；
- 各源延迟和时间戳；
- 中心价格是否被独立来源验证；
- 分钟线 fallback 是否可用。

如果某免费源以后失效，诊断接口会直接暴露错误，不会静默吞掉。

## 主要接口

```text
GET /market/overview
GET /market/scan
GET /market/themes?q=MLCC
GET /market/sentiment

GET /stock/{code}/snapshot
GET /stock/{code}/intraday
GET /stock/{code}/daily
GET /stock/{code}/moneyflow
GET /stock/{code}/context
GET /stock/{code}/lhb
GET /stock/{code}/risk-events

GET /diagnostics/providers
GET /health
```

## ChatGPT Action

`openapi-action.yaml` 的 server 改成你的 Netlify URL，例如：

```yaml
servers:
  - url: https://tushare-chatgpt-bridge.netlify.app
```

Authentication：

```text
API Key
Custom Header: X-API-Key
Value: ACTION_API_KEY
```

不需要把 `TUSHARE_TOKEN` 放进 ChatGPT。

## 数据使用规则

ChatGPT 应始终：

1. 先读取 `as_of_cn`、`data_mode`、`coverage` 和 `data_quality`；
2. `stale/degraded` 时不得给出“当前已确认突破/站稳”之类精确盘中判断；
3. `ranked_partial` 时不得把 observed count 描述成全市场总数；
4. post-close 数据（资金流、daily_basic、margin 等）必须引用其交易日；
5. 新闻/催化由 ChatGPT 另外实时搜索，不由行情 API 猜测。

## 安全

- 只读；
- 无券商账户；
- 无下单；
- 无通用 Tushare proxy；
- `TUSHARE_TOKEN` 仅存在 Netlify 环境变量；
- 固定接口由 `X-API-Key` 保护。

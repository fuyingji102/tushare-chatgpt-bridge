# Tushare → ChatGPT V3.2.2 (Netlify)

V3.2.2 在 V3.2.1 多源实时底座上增加“交易策略层”。默认审核顺序固定为：

```text
情绪 -> 板块 -> 大盘/双创/风格指数 -> 个股
```

核心战法暂时只做一套：**板块共振下的启动突破**，并按生命周期分为 B0/B1/B2/B3/FAILED。

## V3.2.2 新增

### 1. 市场情绪 Regime

`GET /market/sentiment` 新增：

```text
regime = ignition | expansion | climax | divergence | retreat | repair | neutral
breakout_environment = supportive | selective | hostile
recommended_mode
```

Regime 不是单看涨停数，而是综合上涨/下跌家数、市场中位数、>5%/<-5%、涨停/炸板/跌停结构。

### 2. 全行业启动扫描

新增：

```text
GET /market/sectors
```

对 Tushare `stock_basic.industry` 的全部可用行业统一计算：

- 1/3/5/10 日成员收益代理
- 上涨比例、>3%、>5%
- 接近日内高点比例
- 当前成交额和相对 5 日成交扩张
- acceleration
- `ignition_score`
- `IGNITION / EXPANDING / EXTENDED / NEUTRAL / WEAK`

行业收益是**成员股 proxy**，不是申万官方指数；接口会明确标注。

### 3. 指数矩阵

`GET /market/overview` 新增 `index_matrix`：

- 上证指数
- 上证50
- 沪深300
- 中证500
- 中证1000
- 深证成指
- 创业板指
- 科创50
- 科创创业50
- 中证2000

每个指数尽可能返回 realtime；没有免费实时 transport 的指数会回退到 Tushare `index_daily` 并明确 freshness。指标包括 MA5/10/20/60、距均线、5/20 日收益、日内收盘位置、量能相对 5 日。

### 4. 启动突破扫描

新增：

```text
GET /market/breakouts
```

阶段：

```text
B0      临界/预突破：平台收缩，接近参考前高
B1      启动突破：突破参考前高并有量价确认
B2      第一次回踩：突破后 1-5 日首次缩量回踩
B3      过度延伸：趋势强但不追
FAILED  突破失败
WAIT    暂无结构
```

Breakout Score：

```text
Market 15
Sector 20
Base / Compression 15
Breakout Quality 20
Volume 10
Relative Strength 10
Liquidity 10
- Extension Penalty
```

扫描语义刻意写清：**全 A 股进入 realtime/liquidity/sector 预筛，然后只对有限候选池拉 180 日 Tushare qfq 历史确认**。这避免假装每次请求都对 5000+ 股票完整拉 60/180 日历史。

默认：

```text
scan_limit=36
min_amount_million=150
top_n=15
```

可调 `scan_limit` 20-60。

### 5. 成交量单位保护

单股 snapshot 会对 Tushare/Tencent/Eastmoney/Sina 的 `vol_hands` 做多源尺度检查。

- 多源一致：`verified`
- 某一源出现约 100x 等尺度异常：选一致集群并标 `normalized_outlier`
- scanner 还会用 20 日历史量做第二层 100x 防护

避免把 provider 单位异常误判成“126x 放量”。

### 6. Signal evaluation schema

Breakout candidate 会输出 `signal_record`：

```text
signal_id
signal_stage
signal_price
breakout_level
market_regime
sector_status
score
evaluation_horizons_days = [1,3,5,10]
```

以及未来需要回填的：

```text
forward_return
MFE
MAE
invalidation_hit
```

Netlify Function 本身无持久存储，所以 V3.2.2 只输出标准 signal record；后续如需真实回测数据库，可在 V3.3 接入持久化层。

## 数据源顺序

实时个股：

```text
Tushare rt_k -> Tencent -> Eastmoney -> Sina
```

分钟：

```text
Tushare rt_min_daily -> Eastmoney -> Sina
```

全市场：

```text
Tushare rt_k -> Tushare stock_basic universe + Tencent batch -> Eastmoney full attempt
```

只有覆盖率足够且时间戳符合当前交易阶段，才允许计算 `coverage=full` breadth。

历史、复权、涨跌停、资金流、两融等继续以 Tushare 为底座。以后开通 Tushare realtime/高积分权限后会自动优先使用，不需要改 Action。

## 环境变量

仅需要：

```text
TUSHARE_TOKEN
ACTION_API_KEY
```

不要提交真实 token/key 到 GitHub。

## 部署

把 V3.2.2 内容覆盖仓库根目录：

```powershell
git add -A
git commit -m "Upgrade to V3.2.2 breakout strategy engine"
git push
```

Netlify 自动部署。

## 部署后测试

```powershell
$KEY="你的ACTION_API_KEY"
$BASE="https://tushare-chatgpt-bridge.netlify.app"

curl.exe -H "X-API-Key: $KEY" "$BASE/health"
curl.exe -H "X-API-Key: $KEY" "$BASE/market/overview"
curl.exe -H "X-API-Key: $KEY" "$BASE/market/sentiment"
curl.exe -H "X-API-Key: $KEY" "$BASE/market/sectors?top_n=100"
curl.exe -H "X-API-Key: $KEY" "$BASE/market/breakouts?scan_limit=36&top_n=15"
curl.exe -H "X-API-Key: $KEY" "$BASE/diagnostics/providers?ts_code=600522.SH&freq=5MIN"
curl.exe -H "X-API-Key: $KEY" "$BASE/stock/600522.SH/snapshot"
```

## 主要接口

```text
GET /market/overview
GET /market/sentiment
GET /market/sectors
GET /market/breakouts
GET /market/scan
GET /market/themes

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

`openapi-action.yaml` 已使用：

```text
https://tushare-chatgpt-bridge.netlify.app
```

Authentication：

```text
API Key
Custom Header: X-API-Key
Value: ACTION_API_KEY
```

## 默认分析纪律

每次都按：

```text
1 情绪
2 全板块
3 大盘/双创/大小盘风格
4 个股
```

个股优先 B0/B1/B2；B3 明确为追高风险。SKDJ/MACD/RSI 只作为最后辅助，不覆盖价格结构、量能、板块共振和相对强度。

本服务只读，无券商连接和下单功能。

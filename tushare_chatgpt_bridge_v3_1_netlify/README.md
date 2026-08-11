# Tushare → ChatGPT V3.1 (Netlify)

这是一个只读的 A 股行情数据层，目标不是自动交易，而是让 ChatGPT 在长期聊天里随时获取足够新的事实数据，再结合新闻和交易框架与你讨论行情。


## V3.1 新增：交易上下文 / 龙虎榜 / 风险事件

V3.1 在 V3 实时行情层上新增以下官方 Tushare 接口，并保留 Tushare 原始字段名：

- `daily_basic`：`turnover_rate`, `turnover_rate_f`, `volume_ratio`, `pe`, `pe_ttm`, `pb`, `ps`, `ps_ttm`, `dv_ratio`, `dv_ttm`, `total_share`, `float_share`, `free_share`, `total_mv`, `circ_mv`, `limit_status`。
- `margin_detail`：`rzye`, `rqye`, `rzmre`, `rqyl`, `rzche`, `rqchl`, `rqmcl`, `rzrqye`。
- `cyq_perf`：`his_low`, `his_high`, `cost_5pct`, `cost_15pct`, `cost_50pct`, `cost_85pct`, `cost_95pct`, `weight_avg`, `winner_rate`。
- `kpl_list`：`lu_time`, `ld_time`, `open_time`, `last_time`, `lu_desc`, `tag`, `theme`, `net_change`, `bid_amount`, `status`, `bid_change`, `bid_turnover`, `lu_bid_vol`, `bid_pct_chg`, `rt_pct_chg`, `limit_order`, `turnover_rate`, `free_float`, `lu_limit_order` 等。
- `top_inst`：`exalter`, `side`, `buy`, `buy_rate`, `sell`, `sell_rate`, `net_buy`, `reason`。
- 风险事件：`share_float`, `stk_holdertrade`, `forecast`, `disclosure_date`, `repurchase`。

新增路由：

```text
GET /stock/{code}/context
GET /stock/{code}/lhb
GET /stock/{code}/risk-events
```

其中 `/stock/{code}/snapshot` 也会直接返回最新的 `daily_basic`、`margin_detail`、`cyq_perf` 和最近 `kpl_list` 历史；龙虎榜与风险事件保持按需调用，降低日常盘中查询延迟。

`cyq_perf` 是 Tushare 社区模型估算的筹码成本分布，不应当成交易所账户级真实成本。`margin_detail` 通常是次日上午更新前一交易日数据；`daily_basic` 和资金流属于盘后数据。

## V3 新增

- `/market/overview`：实时大盘指数、上涨/下跌家数、>5%/<-5%、全市场成交额、涨跌幅中位数。
- `/market/sentiment`：实时封板、炸板、跌停、情绪梯队；连板高度为“前一交易日天梯 + 今日实时封板”的明确推断值。
- `/market/themes`：
  - `?q=MLCC` / `?q=创新药,光通信` 时，找到同花顺概念成分并用当前 `rt_k` 实时计算题材内部强度和领涨股。
  - 不传 q 时仍返回最近盘后强题材与概念资金流，且明确标注日期和 `post_close`。
- `/market/scan`：实时强申万行业 + 行业内领涨股 + 全市场涨幅/成交额/高流动性强势候选。
- `/stock/{code}/snapshot`：个股一站式实时讨论数据。
- 修正成交量单位：`rt_k/rt_min_daily` 的实时成交量为“股”，`daily.vol` 为“手”；V3 会先换算后再比较量能。

## 你最终只需要两个秘密值

在 Netlify 设置：

```text
TUSHARE_TOKEN=你的 Tushare token
ACTION_API_KEY=你自己生成的一段随机长密码
```

不要把真实 token 写入代码或 GitHub。

可以在 Windows PowerShell 生成 Action key：

```powershell
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

## 最简单部署方式：GitHub + Netlify

1. 解压本项目。
2. 在 GitHub 新建一个**私有仓库**，把本目录全部上传。
3. Netlify → Add new project / Import an existing project → 选择这个 GitHub 仓库。
4. Build 设置保持默认即可；Netlify 会自动识别 `netlify/functions`。
5. Netlify → Project configuration → Environment variables，添加：
   - `TUSHARE_TOKEN`
   - `ACTION_API_KEY`
6. 重新 Deploy。
7. Netlify 会给你一个 HTTPS 地址，例如：

```text
https://my-ashare-data.netlify.app
```

## 部署后先测试

PowerShell：

```powershell
$KEY="你的ACTION_API_KEY"
$BASE="https://my-ashare-data.netlify.app"

curl.exe -H "X-API-Key: $KEY" "$BASE/health"
curl.exe -H "X-API-Key: $KEY" "$BASE/market/overview"
curl.exe -H "X-API-Key: $KEY" "$BASE/market/sentiment"
curl.exe -H "X-API-Key: $KEY" "$BASE/stock/600522.SH/snapshot"
curl.exe -H "X-API-Key: $KEY" "$BASE/stock/600522.SH/context"
curl.exe -H "X-API-Key: $KEY" "$BASE/stock/600522.SH/lhb"
curl.exe -H "X-API-Key: $KEY" "$BASE/stock/600522.SH/risk-events"
curl.exe -H "X-API-Key: $KEY" "$BASE/market/themes?q=光通信"
```

如果 `/health` 成功，而某个行情接口提示 Tushare permission error，通常是对应数据权限未开通，而不是 Netlify 部署失败。

## ChatGPT Action 配置

打开 `openapi-action.yaml`，把：

```yaml
servers:
  - url: https://REPLACE_WITH_YOUR_NETLIFY_DOMAIN
```

改成你的 Netlify 地址，例如：

```yaml
servers:
  - url: https://my-ashare-data.netlify.app
```

然后在 GPT Action 中：

- Authentication: API Key
- Header: `X-API-Key`
- Value: 你的 `ACTION_API_KEY`
- Schema: 粘贴修改后的 `openapi-action.yaml`

项目/GPT 指令直接使用 `PROJECT_INSTRUCTIONS.txt`。

## 推荐的 Tushare 权限

基础/常规：
- `daily`
- `adj_factor`
- `stock_basic`
- `daily_basic`
- `stk_limit`
- `trade_cal`

对“盘中聊行情”最重要的独立实时权限：
- `rt_k`：A股实时日线/全市场截面
- `rt_min_daily`：单股当日累计分钟线
- `rt_idx_k`：指数实时日线
- `rt_sw_k`：申万实时行业

题材/情绪增强（积分要求较高）：
- `ths_index`
- `ths_member`
- `limit_step`
- `limit_cpt_list`
- `moneyflow_ths`
- `moneyflow_cnt_ths`
- `kpl_list`
- `margin_detail`
- `cyq_perf`
- `top_inst`
- `share_float`
- `stk_holdertrade`
- `forecast`
- `disclosure_date`
- `repurchase`

服务会尽可能降级：部分增强权限缺失时，其它接口仍可工作，并在 JSON 的 `permission_errors` / `error` 字段里说明。

## 我们以后怎么用

你说：

```text
今天盘面怎么样？
```

ChatGPT 应先取：

```text
market/overview + market/sentiment
```

你说：

```text
今天还有哪些可以看？
```

再取：

```text
market/scan
```

你说：

```text
MLCC现在是不是主线？
```

取：

```text
market/themes?q=MLCC
```

你说：

```text
中天现在呢？
```

取：

```text
stock/600522.SH/snapshot
```

需要看“早盘 -3 拉回、是否站上 MA5、回踩是否缩量”等路径时，再取 1/5 分钟线。

## 安全边界

- 只读。
- 没有券商账号接口。
- 没有下单接口。
- 没有通用 Tushare proxy，GPT 不能任意调用你的 token。
- `TUSHARE_TOKEN` 仅存在 Netlify 环境变量中。
- 对外只暴露 `X-API-Key` 认证后的固定行情接口。

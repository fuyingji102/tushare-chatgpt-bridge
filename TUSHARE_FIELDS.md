# Tushare fields used by V3.2

This file intentionally keeps Tushare's provider field names unchanged in JSON. V3.2 adds non-Tushare realtime fallback providers, but the Tushare field definitions below remain unchanged and are automatically preferred whenever the account has permission.

## daily_basic

`ts_code`, `trade_date`, `close`, `turnover_rate`, `turnover_rate_f`, `volume_ratio`, `pe`, `pe_ttm`, `pb`, `ps`, `ps_ttm`, `dv_ratio`, `dv_ttm`, `total_share`, `float_share`, `free_share`, `total_mv`, `circ_mv`, `limit_status`

Key interpretation:
- `turnover_rate`: turnover based on unrestricted circulating shares
- `turnover_rate_f`: turnover based on free-float shares
- `volume_ratio`: Tushare daily volume ratio
- `total_share`, `float_share`, `free_share`: 10k shares
- `total_mv`, `circ_mv`: 10k CNY

## margin_detail

`trade_date`, `ts_code`, `name`, `rzye`, `rqye`, `rzmre`, `rqyl`, `rzche`, `rqchl`, `rqmcl`, `rzrqye`

Key interpretation:
- `rzye`: financing balance (CNY)
- `rzmre`: financing buy amount (CNY)
- `rzche`: financing repayment amount (CNY)
- `rqye`: securities-lending balance (CNY)
- `rqyl`: securities-lending remaining quantity (shares)
- `rqmcl`: securities-lending sell quantity
- `rqchl`: securities-lending repayment quantity
- `rzrqye`: total margin financing + securities lending balance (CNY)

## cyq_perf

`ts_code`, `trade_date`, `his_low`, `his_high`, `cost_5pct`, `cost_15pct`, `cost_50pct`, `cost_85pct`, `cost_95pct`, `weight_avg`, `winner_rate`

This is a Tushare community model estimate, not account-level exchange holdings.

## kpl_list

`ts_code`, `name`, `trade_date`, `lu_time`, `ld_time`, `open_time`, `last_time`, `lu_desc`, `tag`, `theme`, `net_change`, `bid_amount`, `status`, `bid_change`, `bid_turnover`, `lu_bid_vol`, `pct_chg`, `bid_pct_chg`, `rt_pct_chg`, `limit_order`, `amount`, `turnover_rate`, `free_float`, `lu_limit_order`

Key interpretation:
- `lu_desc`: limit-up reason
- `theme`: theme/sector label
- `status`: board status / streak status
- `bid_amount`: auction turnover amount (CNY)
- `bid_pct_chg`: auction percentage change
- `bid_turnover`: auction turnover rate (%)
- `lu_bid_vol`: limit-up bid amount
- `limit_order`: sealing order amount
- `lu_limit_order`: maximum sealing order amount

## top_inst (Dragon-Tiger List)

`trade_date`, `ts_code`, `exalter`, `side`, `buy`, `buy_rate`, `sell`, `sell_rate`, `net_buy`, `reason`

`side=0`: buy-side top five; `side=1`: sell-side top five.

## Risk-event interfaces

### share_float
`ts_code`, `ann_date`, `float_date`, `float_share`, `float_ratio`, `holder_name`, `share_type`

### stk_holdertrade
`ts_code`, `ann_date`, `holder_name`, `holder_type`, `in_de`, `change_vol`, `change_ratio`, `after_share`, `after_ratio`, `avg_price`, `total_share`, `begin_date`, `close_date`

`in_de=IN`: increase; `in_de=DE`: decrease.

### forecast
`ts_code`, `ann_date`, `end_date`, `type`, `p_change_min`, `p_change_max`, `net_profit_min`, `net_profit_max`, `last_parent_net`, `first_ann_date`, `summary`, `change_reason`

### disclosure_date
`ts_code`, `ann_date`, `end_date`, `pre_date`, `actual_date`, `modify_date`

### repurchase
`ts_code`, `ann_date`, `end_date`, `proc`, `exp_date`, `vol`, `amount`, `high_limit`, `low_limit`

Tushare's `repurchase` input does not support `ts_code`, so the bridge queries a recent date window and filters locally by `ts_code`.

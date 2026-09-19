# 机械钟表擒纵调校API

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、调校记录、保养记录、游丝更换记录和复测记录。

## 分层

- `server.js`：请求入口，只做路由、报文解析和响应组装
- `lib/domain.js`：状态判定层（纯函数）——磨损准入、频率校验、保养封锁/解除、游丝换新失效重算
- `lib/store.js`：持久化层——JSON 文件读写、种子数据与旧数据迁移

## 启动

```bash
PORT=3021 node server.js
```

端到端校验脚本（会重建 `data/db.json` 并自行重启服务到 3021 端口）：

```bash
node test-e2e.js
```

## 主要接口

- `GET /health`
- `GET /clocks?qualified=true|false`
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/maintenances`
- `POST /clocks/:id/retests`
- `POST /clocks/:id/hairspring-replacements`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /maintenances?clockId=`
- `GET /hairspring-replacements?clockId=`
- `GET /retests?clockId=&qualified=`

## 擒纵磨损准入规则

登记钟表时必须提供：

- `escapementWearLevel`：擒纵磨损等级，仅允许 1 / 2 / 3
- `pivotClearanceMm`：轴尖间隙（毫米）
- `newHairspringFrequency`：新游丝频率

判定规则：

1. 三级磨损（`escapementWearLevel >= 3`）或轴尖间隙 **超过** 0.04 毫米，钟表状态为 `needs-service`（待保养），不能登记调校/复测。
2. 新游丝频率与机芯频率 `balanceFrequency` 不一致，返回 **409** 且不写库（登记和更换游丝接口均适用）。
3. 登记保养 `POST /clocks/:id/maintenances` 必须记录处理人 `handler`、振幅 `amplitude`、日差 `dailyRateSeconds`；登记后钟表进入 `service-locked`（保养封锁）。
4. 与最新保养关联、且在保养之后达标的复测累计 **两次**，封锁解除，钟表回到 `in-service`。
5. 更换游丝后，该钟表此前所有调校与复测结论标记为 `superseded` 失效，状态按新件重新计算，需要重新完成两次关联复测。
6. `needs-service` / `service-locked` 的钟表不会出现在合格列表中（`GET /clocks?qualified=true`）。

列表、历史、最新复测三个接口返回同一份状态判定结果（`status`、`qualified`、`wearNeedsService`、`maintenanceCleared`、`latestMaintenance`、`latestRetest` 等字段一致）。

## 闭环示例

```bash
# 1. 登记（间隙0.06mm => 待保养）
curl -X POST http://127.0.0.1:3021/clocks -H 'Content-Type: application/json' \
  -d '{"code":"CLK-X1","escapementType":"杠杆式","balanceFrequency":"21600vph","escapementWearLevel":2,"pivotClearanceMm":0.06,"newHairspringFrequency":"21600vph"}'

# 2. 频率不符 => 409，不落库
curl -i -X POST http://127.0.0.1:3021/clocks -H 'Content-Type: application/json' \
  -d '{"code":"CLK-X2","escapementType":"杠杆式","balanceFrequency":"21600vph","escapementWearLevel":1,"pivotClearanceMm":0.01,"newHairspringFrequency":"28800vph"}'

# 3. 登记保养（处理人/振幅/日差）
curl -X POST http://127.0.0.1:3021/clocks/<id>/maintenances -H 'Content-Type: application/json' \
  -d '{"handler":"王师傅","amplitude":270,"dailyRateSeconds":8}'

# 4. 两次关联复测达标（自动关联最新保养）
curl -X POST http://127.0.0.1:3021/clocks/<id>/retests -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":5,"amplitude":268}'
curl -X POST http://127.0.0.1:3021/clocks/<id>/retests -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":-3,"amplitude":271}'
```

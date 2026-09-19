# 机械钟表擒纵调校API

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、磨损准入、保养记录、调校记录和复测记录。

## 结构

- `server.js`：进程启动入口
- `src/router.js`：请求入口（路由、入参校验、响应）
- `src/domain.js`：状态判定（准入决策、封锁/解除、结论失效，纯函数）
- `src/store.js`：持久化（`data/db.json`，可用 `DB_FILE` 环境变量覆盖）
- `src/http.js`：HTTP 工具

## 启动

```bash
PORT=3021 node server.js
```

## 主要接口

- `GET /health`
- `GET /clocks?qualified=&status=`（`status` 可取 `active` / `pending_maintenance`）
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`（含准入、保养、调校、复测全量历史与失效标记）
- `POST /clocks/:id/admissions`（擒纵磨损准入登记）
- `POST /clocks/:id/maintenances`（保养登记）
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/retests`（自动关联当前保养与最新有效调校）
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=&maintenanceId=`
- `GET /admissions?clockId=`
- `GET /maintenances?clockId=`

## 擒纵磨损准入规则

- 准入登记磨损等级（1–3）、轴尖间隙（毫米）和新游丝频率。
- 磨损等级达到三级，或轴尖间隙超过 `0.04` 毫米：只能待保养，钟表进入 `pending_maintenance` 封锁。
- 新游丝频率与机芯 `balanceFrequency` 不符：返回 `409` 且不落库。
- 待保养钟表永远不合格，不得进入合格列表（`GET /clocks?qualified=true` 自动排除）。

## 保养与解除封锁

- 保养必须记录处理人 `handler`、振幅 `amplitude`、日差 `dailyRateSeconds`。
- 保养后需两次关联复测达标（`qualified=true` 且关联到当前保养记录）才解除封锁。
- 保养时 `replacedHairspring: true` 表示更换游丝：旧调校与旧复测结论全部失效（保留 `invalidatedAt` 标记），按新游丝重新计算；新游丝频率不符同样返回 `409` 且不落库。

## 闭环示例

```bash
# 磨损准入：三级磨损 -> 待保养
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/admissions \
  -H 'Content-Type: application/json' \
  -d '{"wearLevel":3,"pivotClearanceMm":0.02,"newHairspringFrequency":"18000vph"}'

# 保养登记
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/maintenances \
  -H 'Content-Type: application/json' \
  -d '{"handler":"王师傅","amplitude":268,"dailyRateSeconds":4}'

# 两次关联复测达标后解除封锁
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":3,"amplitude":265}'
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":-2,"amplitude":266}'

curl http://127.0.0.1:3021/clocks?qualified=true
```

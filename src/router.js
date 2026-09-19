// 请求入口：路由匹配、入参校验、响应输出；状态判定交给domain，持久化交给store
const { send, parseBody } = require("./http");
const store = require("./store");
const domain = require("./domain");

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/admissions",
  "POST /clocks/:id/maintenances",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments",
  "GET /retests",
  "GET /admissions",
  "GET /maintenances"
];

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function toFiniteNumber(value, field) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    const error = new Error(`${field}必须是数字`);
    error.status = 400;
    throw error;
  }
  return num;
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) {
    const error = new Error("钟表不存在");
    error.status = 404;
    throw error;
  }
  return clock;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await store.readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const qualified = url.searchParams.get("qualified");
    const status = url.searchParams.get("status");
    let data = db.clocks.map((clock) => domain.projectClock(db, clock));
    if (status !== null) {
      data = data.filter((clock) => clock.status === status);
    }
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency"]);
    const clock = {
      id: makeId("clock"),
      code: body.code,
      escapementType: body.escapementType,
      balanceFrequency: body.balanceFrequency,
      hairspringFrequency: body.hairspringFrequency || body.balanceFrequency,
      targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
      status: "active",
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.clocks.push(clock);
    await store.writeDb(db);
    return send(res, 201, { data: domain.projectClock(db, clock) });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const data = db.clocks.map((clock) => domain.projectClock(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const clock = findClock(db, historyMatch[1]);
    const data = {
      clock: domain.projectClock(db, clock),
      admissions: db.admissions.filter((item) => item.clockId === clock.id),
      maintenances: db.maintenances.filter((item) => item.clockId === clock.id),
      adjustments: db.adjustments.filter((item) => item.clockId === clock.id),
      retests: db.retests.filter((item) => item.clockId === clock.id),
      latestRetest: domain.latestRetest(db, clock.id)
    };
    return send(res, 200, { data });
  }

  // 擒纵磨损准入：登记磨损等级、轴尖间隙、新游丝频率
  const admissionMatch = pathname.match(/^\/clocks\/([^/]+)\/admissions$/);
  if (admissionMatch && req.method === "POST") {
    const clock = findClock(db, admissionMatch[1]);
    const body = await parseBody(req);
    required(body, ["wearLevel", "pivotClearanceMm", "newHairspringFrequency"]);
    const wearLevel = Number(body.wearLevel);
    if (!Number.isInteger(wearLevel) || wearLevel < 1 || wearLevel > domain.MAX_WEAR_LEVEL) {
      return send(res, 400, { error: `磨损等级必须是1到${domain.MAX_WEAR_LEVEL}的整数` });
    }
    const pivotClearanceMm = Number(body.pivotClearanceMm);
    if (!Number.isFinite(pivotClearanceMm) || pivotClearanceMm < 0) {
      return send(res, 400, { error: "轴尖间隙必须是非负数字（单位：毫米）" });
    }
    // 新游丝频率与机芯不符：409且不落库
    if (!domain.isFrequencyCompatible(clock.balanceFrequency, body.newHairspringFrequency)) {
      return send(res, 409, {
        error: "新游丝频率与机芯不符",
        movementFrequency: clock.balanceFrequency,
        newHairspringFrequency: body.newHairspringFrequency
      });
    }
    const decision = domain.decideAdmission({ wearLevel, pivotClearanceMm });
    const now = new Date().toISOString();
    const admission = {
      id: makeId("admission"),
      clockId: clock.id,
      wearLevel,
      pivotClearanceMm,
      newHairspringFrequency: String(body.newHairspringFrequency).trim(),
      decision: decision.decision,
      reasons: decision.reasons,
      note: body.note || "",
      createdAt: now
    };
    db.admissions.push(admission);
    if (!decision.admitted) {
      clock.status = "pending_maintenance";
      clock.maintenanceSince = clock.maintenanceSince || now;
    }
    await store.writeDb(db);
    return send(res, 201, { data: admission, clock: domain.projectClock(db, clock) });
  }

  // 保养登记：必须记录处理人、振幅、日差；更换游丝则旧结论失效
  const maintenanceMatch = pathname.match(/^\/clocks\/([^/]+)\/maintenances$/);
  if (maintenanceMatch && req.method === "POST") {
    const clock = findClock(db, maintenanceMatch[1]);
    const body = await parseBody(req);
    required(body, ["handler", "amplitude", "dailyRateSeconds"]);
    const amplitude = toFiniteNumber(body.amplitude, "振幅");
    const dailyRateSeconds = toFiniteNumber(body.dailyRateSeconds, "日差");
    const replacedHairspring = Boolean(body.replacedHairspring);
    let newHairspringFrequency = null;
    if (replacedHairspring) {
      newHairspringFrequency =
        body.newHairspringFrequency || domain.latestAdmission(db, clock.id)?.newHairspringFrequency || null;
      if (!newHairspringFrequency) {
        return send(res, 400, { error: "更换游丝必须提供新游丝频率（可先在磨损准入中登记）" });
      }
      if (!domain.isFrequencyCompatible(clock.balanceFrequency, newHairspringFrequency)) {
        return send(res, 409, {
          error: "新游丝频率与机芯不符",
          movementFrequency: clock.balanceFrequency,
          newHairspringFrequency
        });
      }
    }
    const now = new Date().toISOString();
    const maintenance = {
      id: makeId("maintenance"),
      clockId: clock.id,
      handler: body.handler,
      amplitude,
      dailyRateSeconds,
      replacedHairspring,
      newHairspringFrequency: newHairspringFrequency ? String(newHairspringFrequency).trim() : null,
      note: body.note || "",
      createdAt: now
    };
    db.maintenances.push(maintenance);
    let invalidated = { adjustments: 0, retests: 0 };
    if (replacedHairspring) {
      clock.hairspringFrequency = maintenance.newHairspringFrequency;
      invalidated = domain.invalidatePriorConclusions(db, clock.id, maintenance.id, now);
    }
    await store.writeDb(db);
    return send(res, 201, { data: maintenance, invalidated, clock: domain.projectClock(db, clock) });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clock = findClock(db, adjustmentMatch[1]);
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const adjustment = {
      id: makeId("adjustment"),
      clockId: clock.id,
      currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
      direction: body.direction,
      amount: body.amount,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.adjustments.push(adjustment);
    await store.writeDb(db);
    return send(res, 201, { data: adjustment });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const clock = findClock(db, retestMatch[1]);
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);
    const adjustmentId = body.adjustmentId || domain.latestAdjustment(db, clock.id)?.id || null;
    const maintenanceId = body.maintenanceId || domain.currentMaintenance(db, clock)?.id || null;
    const qualified = body.qualified !== undefined
      ? Boolean(body.qualified)
      : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
    const retest = {
      id: makeId("retest"),
      clockId: clock.id,
      adjustmentId,
      maintenanceId,
      testedAt: body.testedAt || new Date().toISOString(),
      dailyRateSeconds: Number(body.dailyRateSeconds),
      amplitude: Number(body.amplitude),
      qualified,
      note: body.note || ""
    };
    db.retests.push(retest);
    await store.writeDb(db);
    return send(res, 201, { data: retest, clock: domain.projectClock(db, clock) });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    findClock(db, latestMatch[1]);
    return send(res, 200, { data: domain.latestRetest(db, latestMatch[1]) });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const maintenanceId = url.searchParams.get("maintenanceId");
    const data = db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      const matchMaintenance = !maintenanceId || item.maintenanceId === maintenanceId;
      return matchClock && matchQualified && matchMaintenance;
    });
    return send(res, 200, { data });
  }

  if (req.method === "GET" && pathname === "/admissions") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.admissions.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/maintenances") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.maintenances.filter((item) => !clockId || item.clockId === clockId) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

module.exports = { handle, routes };

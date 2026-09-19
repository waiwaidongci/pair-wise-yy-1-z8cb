// 状态判定层：磨损准入、频率校验、保养封锁/解除、游丝换新失效重算
// 全部为纯规则函数，不接触 HTTP 与文件系统。

const WEAR_SERVICE_LEVEL = 3; // 三级磨损只能待保养
const MAX_PIVOT_CLEARANCE_MM = 0.04; // 轴尖间隙超过 0.04 毫米只能待保养
const REQUIRED_LINKED_RETESTS = 2; // 两次关联复测达标才解除封锁

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function requireFields(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw httpError(400, `缺少字段：${missing.join(", ")}`);
}

function toNumber(value, field) {
  const num = Number(value);
  if (value === "" || value === undefined || Number.isNaN(num)) {
    throw httpError(400, `字段 ${field} 必须是数字`);
  }
  return num;
}

function normalizeFrequency(value) {
  return String(value).trim();
}

// 磨损准入判定：三级磨损或间隙超过 0.04mm 只能待保养
function wearNeedsService(clock) {
  return (
    Number(clock.escapementWearLevel) >= WEAR_SERVICE_LEVEL ||
    Number(clock.pivotClearanceMm) > MAX_PIVOT_CLEARANCE_MM
  );
}

// 新游丝频率必须与机芯频率一致
function frequencyMatchesMovement(clock, newFrequency) {
  return normalizeFrequency(newFrequency) === normalizeFrequency(clock.balanceFrequency);
}

function buildClock(body) {
  requireFields(body, [
    "code",
    "escapementType",
    "balanceFrequency",
    "escapementWearLevel",
    "pivotClearanceMm",
    "newHairspringFrequency"
  ]);

  const wearLevel = toNumber(body.escapementWearLevel, "escapementWearLevel");
  if (!Number.isInteger(wearLevel) || wearLevel < 1 || wearLevel > 3) {
    throw httpError(400, "擒纵磨损等级必须是 1、2 或 3");
  }
  const clearance = toNumber(body.pivotClearanceMm, "pivotClearanceMm");
  if (clearance < 0) throw httpError(400, "轴尖间隙不能为负数");

  const balanceFrequency = normalizeFrequency(body.balanceFrequency);
  const newHairspringFrequency = normalizeFrequency(body.newHairspringFrequency);
  // 409 冲突：新游丝与机芯不符，调用方不得落库
  if (newHairspringFrequency !== balanceFrequency) {
    throw httpError(409, "新游丝频率与机芯不符，登记被拒绝（数据未落库）");
  }

  return {
    id: makeId("clock"),
    code: body.code,
    escapementType: body.escapementType,
    balanceFrequency,
    targetDailyRateSeconds: body.targetDailyRateSeconds === undefined ? 30 : toNumber(body.targetDailyRateSeconds, "targetDailyRateSeconds"),
    escapementWearLevel: wearLevel,
    pivotClearanceMm: clearance,
    newHairspringFrequency,
    note: body.note || "",
    createdAt: new Date().toISOString()
  };
}

function buildMaintenance(clock, body) {
  requireFields(body, ["handler", "amplitude", "dailyRateSeconds"]);
  return {
    id: makeId("maintenance"),
    clockId: clock.id,
    handler: body.handler,
    amplitude: toNumber(body.amplitude, "amplitude"),
    dailyRateSeconds: toNumber(body.dailyRateSeconds, "dailyRateSeconds"),
    performedAt: body.performedAt || new Date().toISOString(),
    note: body.note || ""
  };
}

function buildAdjustment(clock, body) {
  requireFields(body, ["currentDailyRateSeconds", "direction", "amount"]);
  return {
    id: makeId("adjustment"),
    clockId: clock.id,
    currentDailyRateSeconds: toNumber(body.currentDailyRateSeconds, "currentDailyRateSeconds"),
    direction: body.direction,
    amount: body.amount,
    note: body.note || "",
    superseded: false,
    createdAt: new Date().toISOString()
  };
}

function buildRetest(clock, body, linkage) {
  requireFields(body, ["dailyRateSeconds", "amplitude"]);
  const dailyRateSeconds = toNumber(body.dailyRateSeconds, "dailyRateSeconds");
  const amplitude = toNumber(body.amplitude, "amplitude");
  const qualified = body.qualified !== undefined
    ? Boolean(body.qualified)
    : Math.abs(dailyRateSeconds) <= Number(clock.targetDailyRateSeconds);
  return {
    id: makeId("retest"),
    clockId: clock.id,
    adjustmentId: linkage.adjustmentId || null,
    maintenanceId: linkage.maintenanceId || null,
    testedAt: body.testedAt || new Date().toISOString(),
    dailyRateSeconds,
    amplitude,
    qualified,
    superseded: false,
    note: body.note || ""
  };
}

function buildHairspringReplacement(clock, body) {
  requireFields(body, ["newHairspringFrequency"]);
  const newHairspringFrequency = normalizeFrequency(body.newHairspringFrequency);
  // 409 冲突：新游丝与机芯不符，调用方不得落库
  if (!frequencyMatchesMovement(clock, newHairspringFrequency)) {
    throw httpError(
      409,
      `新游丝频率 ${newHairspringFrequency} 与机芯频率 ${normalizeFrequency(clock.balanceFrequency)} 不符，更换被拒绝（数据未落库）`
    );
  }
  return {
    id: makeId("hairspring"),
    clockId: clock.id,
    newHairspringFrequency,
    note: body.note || "",
    replacedAt: body.replacedAt || new Date().toISOString()
  };
}

// ---- 集合查询 ----

function activeAdjustments(db, clockId) {
  return db.adjustments
    .filter((item) => item.clockId === clockId && !item.superseded)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function activeRetests(db, clockId) {
  return db.retests
    .filter((item) => item.clockId === clockId && !item.superseded)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt));
}

function latestMaintenance(db, clockId) {
  return db.maintenances
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.performedAt) - new Date(a.performedAt))[0] || null;
}

function latestHairspringReplacement(db, clockId) {
  return db.hairspringReplacements
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.replacedAt) - new Date(a.replacedAt))[0] || null;
}

// 两次关联复测达标才解除封锁：最近两次关联复测必须均达标
function maintenanceCleared(db, maintenance) {
  if (!maintenance) return false;
  const linked = activeRetests(db, maintenance.clockId).filter(
    (item) =>
      item.maintenanceId === maintenance.id &&
      new Date(item.testedAt) >= new Date(maintenance.performedAt)
  );
  return linked.length >= REQUIRED_LINKED_RETESTS
    && linked.slice(0, REQUIRED_LINKED_RETESTS).every((item) => item.qualified);
}

// 统一状态判定：列表 / 历史 / 最新复测接口共用
function evaluateClock(db, clock) {
  const wearBlocked = wearNeedsService(clock);
  const maintenance = latestMaintenance(db, clock.id);
  const latestRetest = activeRetests(db, clock.id)[0] || null;
  const cleared = maintenanceCleared(db, maintenance);

  let status;
  if (!maintenance) {
    // 无保养记录：磨损/间隙超标只能待保养
    status = wearBlocked ? "needs-service" : "in-service";
  } else if (!cleared) {
    // 已登记保养但未完成两次关联复测：封锁
    status = "service-locked";
  } else {
    // 保养已闭环（磨损问题在保养中处理），复测达标后恢复在服
    status = "in-service";
  }

  // 待保养 / 封锁中的钟表不得进入合格列表
  const qualified = status === "in-service" && Boolean(latestRetest && latestRetest.qualified);

  return { status, wearBlocked, maintenance, cleared, latestRetest, qualified };
}

function clockSummary(db, clock) {
  const state = evaluateClock(db, clock);
  return {
    ...clock,
    status: state.status,
    wearNeedsService: state.wearBlocked,
    qualified: state.qualified,
    latestMaintenance: state.maintenance,
    maintenanceCleared: state.cleared,
    latestHairspringReplacement: latestHairspringReplacement(db, clock.id),
    latestAdjustment: activeAdjustments(db, clock.id)[0] || null,
    latestRetest: state.latestRetest
  };
}

module.exports = {
  WEAR_SERVICE_LEVEL,
  MAX_PIVOT_CLEARANCE_MM,
  REQUIRED_LINKED_RETESTS,
  httpError,
  wearNeedsService,
  frequencyMatchesMovement,
  buildClock,
  buildMaintenance,
  buildAdjustment,
  buildRetest,
  buildHairspringReplacement,
  activeAdjustments,
  activeRetests,
  latestMaintenance,
  latestHairspringReplacement,
  maintenanceCleared,
  evaluateClock,
  clockSummary
};

// 状态判定：磨损准入、保养封锁/解除、游丝更换失效，全部为纯函数，不接触HTTP与持久化

const MAX_WEAR_LEVEL = 3; // 磨损等级达到三级即只能待保养
const MAX_PIVOT_CLEARANCE_MM = 0.04; // 轴尖间隙超过0.04毫米即只能待保养
const UNBLOCK_QUALIFIED_RETESTS = 2; // 两次关联复测达标才解除封锁

function normalizeFrequency(value) {
  return String(value ?? "").trim().toLowerCase();
}

// 新游丝频率必须与机芯摆频一致
function isFrequencyCompatible(movementFrequency, hairspringFrequency) {
  const movement = normalizeFrequency(movementFrequency);
  const hairspring = normalizeFrequency(hairspringFrequency);
  return movement !== "" && movement === hairspring;
}

// 准入判定：三级磨损或轴尖间隙超差 -> 只能待保养
function decideAdmission({ wearLevel, pivotClearanceMm }) {
  const reasons = [];
  if (wearLevel >= MAX_WEAR_LEVEL) reasons.push(`磨损等级达到${MAX_WEAR_LEVEL}级`);
  if (pivotClearanceMm > MAX_PIVOT_CLEARANCE_MM) reasons.push(`轴尖间隙超过${MAX_PIVOT_CLEARANCE_MM}毫米`);
  return {
    admitted: reasons.length === 0,
    decision: reasons.length === 0 ? "admitted" : "maintenance_required",
    reasons
  };
}

function latestBy(items, field) {
  return items.slice().sort((a, b) => new Date(b[field]) - new Date(a[field]))[0] || null;
}

// 已失效（更换游丝前）的调校/复测结论不参与判定
function latestAdjustment(db, clockId) {
  return latestBy(db.adjustments.filter((item) => item.clockId === clockId && !item.invalidatedAt), "createdAt");
}

function latestRetest(db, clockId) {
  return latestBy(db.retests.filter((item) => item.clockId === clockId && !item.invalidatedAt), "testedAt");
}

function latestAdmission(db, clockId) {
  return latestBy(db.admissions.filter((item) => item.clockId === clockId), "createdAt");
}

function latestBlockingAdmission(db, clockId) {
  return latestBy(
    db.admissions.filter((item) => item.clockId === clockId && item.decision === "maintenance_required"),
    "createdAt"
  );
}

// 针对当前封锁的保养记录：必须不早于最近一次触发待保养的准入登记
function currentMaintenance(db, clock) {
  const blocking = latestBlockingAdmission(db, clock.id);
  const since = blocking?.createdAt || clock.maintenanceSince || null;
  const maintenances = db.maintenances.filter((item) => item.clockId === clock.id);
  if (!since) return latestBy(maintenances, "createdAt");
  return latestBy(maintenances.filter((item) => new Date(item.createdAt) >= new Date(since)), "createdAt");
}

// 解除封锁进度：关联到当前保养记录的达标复测次数
function maintenanceProgress(db, clock) {
  const maintenance = currentMaintenance(db, clock);
  const qualifiedRetestCount = maintenance
    ? db.retests.filter((item) =>
        item.clockId === clock.id &&
        item.maintenanceId === maintenance.id &&
        item.qualified === true &&
        !item.invalidatedAt
      ).length
    : 0;
  return {
    latestMaintenance: maintenance,
    requiredQualifiedRetests: UNBLOCK_QUALIFIED_RETESTS,
    qualifiedRetestCount,
    remainingQualifiedRetests: Math.max(0, UNBLOCK_QUALIFIED_RETESTS - qualifiedRetestCount)
  };
}

function resolveStatus(db, clock) {
  const progress = maintenanceProgress(db, clock);
  const stored = clock.status === "pending_maintenance" ? "pending_maintenance" : "active";
  if (stored !== "pending_maintenance") {
    return { status: "active", blocked: false, progress };
  }
  const unblocked = Boolean(progress.latestMaintenance) && progress.remainingQualifiedRetests === 0;
  return { status: unblocked ? "active" : "pending_maintenance", blocked: !unblocked, progress };
}

// 列表、历史、最新复测共用的钟表投影，保证各接口口径一致
function projectClock(db, clock) {
  const { status, blocked, progress } = resolveStatus(db, clock);
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  return {
    ...clock,
    status,
    maintenanceBlocked: blocked,
    maintenanceProgress: progress,
    latestAdjustment: adjustment,
    latestRetest: retest,
    // 待保养钟表永远不合格，不得进入合格列表
    qualified: !blocked && Boolean(retest && retest.qualified === true)
  };
}

// 更换游丝后，旧调校与复测结论全部失效，按新游丝重新计算
function invalidatePriorConclusions(db, clockId, maintenanceId, invalidatedAt) {
  const invalidReason = "更换游丝，旧调校结论失效，按新游丝重新计算";
  const invalidated = { adjustments: 0, retests: 0 };
  for (const item of db.adjustments) {
    if (item.clockId === clockId && !item.invalidatedAt) {
      item.invalidatedAt = invalidatedAt;
      item.invalidatedByMaintenanceId = maintenanceId;
      item.invalidReason = invalidReason;
      invalidated.adjustments += 1;
    }
  }
  for (const item of db.retests) {
    if (item.clockId === clockId && !item.invalidatedAt) {
      item.invalidatedAt = invalidatedAt;
      item.invalidatedByMaintenanceId = maintenanceId;
      item.invalidReason = invalidReason;
      invalidated.retests += 1;
    }
  }
  return invalidated;
}

module.exports = {
  MAX_WEAR_LEVEL,
  MAX_PIVOT_CLEARANCE_MM,
  UNBLOCK_QUALIFIED_RETESTS,
  isFrequencyCompatible,
  decideAdmission,
  latestAdjustment,
  latestRetest,
  latestAdmission,
  currentMaintenance,
  maintenanceProgress,
  resolveStatus,
  projectClock,
  invalidatePriorConclusions
};

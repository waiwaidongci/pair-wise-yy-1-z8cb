const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");

function seedData() {
  const now = new Date().toISOString();
  return {
    clocks: [
      {
        id: "clock_demo",
        code: "CLK-1890-07",
        escapementType: "瑞士杠杆式",
        balanceFrequency: "18000vph",
        targetDailyRateSeconds: 20,
        escapementWearLevel: 2,
        pivotClearanceMm: 0.018,
        newHairspringFrequency: "18000vph",
        note: "怀表机芯，走时偏快",
        createdAt: now
      }
    ],
    adjustments: [
      {
        id: "adjustment_demo",
        clockId: "clock_demo",
        currentDailyRateSeconds: 68,
        direction: "慢针方向",
        amount: "游丝快慢针向慢侧微调0.4格",
        note: "初次调校，先保守处理",
        superseded: false,
        createdAt: now
      }
    ],
    retests: [
      {
        id: "retest_demo",
        clockId: "clock_demo",
        adjustmentId: "adjustment_demo",
        maintenanceId: null,
        testedAt: now,
        dailyRateSeconds: 31,
        amplitude: 248,
        qualified: false,
        superseded: false,
        note: "仍偏快，振幅尚可"
      }
    ],
    maintenances: [],
    hairspringReplacements: []
  };
}

// 旧数据补齐新字段，不改变既有业务结论
function migrate(db) {
  let changed = false;
  for (const key of ["clocks", "adjustments", "retests", "maintenances", "hairspringReplacements"]) {
    if (!Array.isArray(db[key])) {
      db[key] = key === "clocks" && db.clocks ? db.clocks : [];
      changed = true;
    }
  }
  for (const clock of db.clocks) {
    if (clock.escapementWearLevel === undefined) {
      clock.escapementWearLevel = 1;
      changed = true;
    }
    if (clock.pivotClearanceMm === undefined) {
      clock.pivotClearanceMm = 0.02;
      changed = true;
    }
    if (clock.newHairspringFrequency === undefined) {
      clock.newHairspringFrequency = clock.balanceFrequency;
      changed = true;
    }
  }
  for (const adjustment of db.adjustments) {
    if (adjustment.superseded === undefined) {
      adjustment.superseded = false;
      changed = true;
    }
  }
  for (const retest of db.retests) {
    if (retest.superseded === undefined) {
      retest.superseded = false;
      changed = true;
    }
    if (retest.maintenanceId === undefined) {
      retest.maintenanceId = null;
      changed = true;
    }
  }
  return changed;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(seedData(), null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  if (migrate(db)) await writeFile(DB_FILE, JSON.stringify(db, null, 2));
  return db;
}

async function writeDb(db) {
  await writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

module.exports = { DB_FILE, readDb, writeDb, seedData, migrate };

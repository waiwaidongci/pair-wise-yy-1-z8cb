const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "..", "data", "db.json");

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      hairspringFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      status: "active",
      note: "怀表机芯，走时偏快",
      createdAt: new Date().toISOString()
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
      createdAt: new Date().toISOString()
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      maintenanceId: null,
      testedAt: new Date().toISOString(),
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ],
  admissions: [],
  maintenances: []
};

function normalize(db) {
  return {
    clocks: Array.isArray(db.clocks) ? db.clocks : [],
    adjustments: Array.isArray(db.adjustments) ? db.adjustments : [],
    retests: Array.isArray(db.retests) ? db.retests : [],
    admissions: Array.isArray(db.admissions) ? db.admissions : [],
    maintenances: Array.isArray(db.maintenances) ? db.maintenances : []
  };
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  return normalize(JSON.parse(await readFile(DB_FILE, "utf8")));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(normalize(data), null, 2));
}

module.exports = { DB_FILE, readDb, writeDb };

const http = require("http");
const { readDb, writeDb } = require("./lib/store");
const domain = require("./lib/domain");

const PORT = Number(process.env.PORT || 3021);

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/maintenances",
  "POST /clocks/:id/retests",
  "POST /clocks/:id/hairspring-replacements",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments",
  "GET /maintenances",
  "GET /hairspring-replacements",
  "GET /retests"
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw domain.httpError(400, "请求体必须是合法JSON");
  }
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) throw domain.httpError(404, "钟表不存在");
  return clock;
}

function assertInService(db, clock, action) {
  const state = domain.evaluateClock(db, clock);
  if (state.status === "needs-service") {
    throw domain.httpError(403, "该钟表已判定待保养，无法" + action + "，请先登记保养");
  }
  if (state.status === "service-locked") {
    throw domain.httpError(403, "该钟表处于保养封锁中，尚未完成两次关联复测，无法" + action);
  }
}

// 复测与保养/调校的关联规则
function resolveRetestLinkage(db, clock, body) {
  const state = domain.evaluateClock(db, clock);

  if (state.status === "needs-service") {
    throw domain.httpError(403, "该钟表待保养，无法登记复测，请先登记保养");
  }

  if (state.status === "service-locked") {
    const expectedId = state.maintenance.id;
    if (body.maintenanceId && body.maintenanceId !== expectedId) {
      throw domain.httpError(409, "复测必须关联到最新一次保养记录");
    }
    return { maintenanceId: expectedId, adjustmentId: null };
  }

  if (body.maintenanceId) {
    throw domain.httpError(409, "当前钟表不在保养封锁状态，复测不应关联保养记录");
  }
  const adjustmentId = body.adjustmentId || domain.activeAdjustments(db, clock.id)[0]?.id || null;
  return { maintenanceId: null, adjustmentId };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const qualified = url.searchParams.get("qualified");
    let data = db.clocks.map((clock) => domain.clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    const clock = domain.buildClock(body); // 频率不符抛 409，此处尚未落库
    db.clocks.push(clock);
    await writeDb(db);
    return send(res, 201, { data: domain.clockSummary(db, clock) });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const data = db.clocks
      .map((clock) => domain.clockSummary(db, clock))
      .filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const clock = findClock(db, historyMatch[1]);
    const summary = domain.clockSummary(db, clock);
    const data = {
      clock: summary,
      adjustments: db.adjustments.filter((item) => item.clockId === clock.id),
      maintenances: db.maintenances.filter((item) => item.clockId === clock.id),
      hairspringReplacements: db.hairspringReplacements.filter((item) => item.clockId === clock.id),
      retests: db.retests.filter((item) => item.clockId === clock.id),
      latestRetest: summary.latestRetest
    };
    return send(res, 200, { data });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clock = findClock(db, adjustmentMatch[1]);
    assertInService(db, clock, "登记调校");
    const body = await parseBody(req);
    const adjustment = domain.buildAdjustment(clock, body);
    db.adjustments.push(adjustment);
    await writeDb(db);
    return send(res, 201, { data: adjustment });
  }

  const maintenanceMatch = pathname.match(/^\/clocks\/([^/]+)\/maintenances$/);
  if (maintenanceMatch && req.method === "POST") {
    const clock = findClock(db, maintenanceMatch[1]);
    const body = await parseBody(req);
    const maintenance = domain.buildMaintenance(clock, body); // 处理人、振幅、日差
    db.maintenances.push(maintenance);
    await writeDb(db);
    return send(res, 201, { data: maintenance, clock: domain.clockSummary(db, clock) });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const clock = findClock(db, retestMatch[1]);
    const body = await parseBody(req);
    const linkage = resolveRetestLinkage(db, clock, body);
    const retest = domain.buildRetest(clock, body, linkage);
    db.retests.push(retest);
    await writeDb(db);
    return send(res, 201, { data: retest, clock: domain.clockSummary(db, clock) });
  }

  const hairspringMatch = pathname.match(/^\/clocks\/([^/]+)\/hairspring-replacements$/);
  if (hairspringMatch && req.method === "POST") {
    const clock = findClock(db, hairspringMatch[1]);
    const body = await parseBody(req);
    const replacement = domain.buildHairspringReplacement(clock, body); // 不符抛 409，不落库

    // 更换游丝：旧调校结论失效，按新件重算
    for (const adjustment of db.adjustments) {
      if (adjustment.clockId === clock.id) adjustment.superseded = true;
    }
    for (const retest of db.retests) {
      if (retest.clockId === clock.id) retest.superseded = true;
    }
    clock.newHairspringFrequency = replacement.newHairspringFrequency;
    clock.balanceFrequency = replacement.newHairspringFrequency;

    db.hairspringReplacements.push(replacement);
    await writeDb(db);
    return send(res, 201, { data: replacement, clock: domain.clockSummary(db, clock) });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    const clock = findClock(db, latestMatch[1]);
    const summary = domain.clockSummary(db, clock);
    // 与列表/历史一致：统一状态字段，复测仅取换新后仍有效的最新一条
    return send(res, 200, { data: { retest: summary.latestRetest, clock: summary } });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/maintenances") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.maintenances.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/hairspring-replacements") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.hairspringReplacements.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      return matchClock && matchQualified;
    });
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
});

module.exports = { server };

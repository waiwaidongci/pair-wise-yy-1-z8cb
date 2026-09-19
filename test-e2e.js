const BASE = "http://127.0.0.1:3021";
let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("PASS", name);
  } else {
    fail++;
    console.log("FAIL", name, extra || "");
  }
}

async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

(async () => {
  // 1. 正常登记（一级磨损、间隙正常）
  let r = await req("POST", "/clocks", {
    code: "CLK-T1", escapementType: "杠杆式", balanceFrequency: "21600vph",
    escapementWearLevel: 1, pivotClearanceMm: 0.02, newHairspringFrequency: "21600vph"
  });
  check("正常登记 201", r.status === 201, r.status);
  const goodClock = r.json.data;
  check("正常钟表 in-service", goodClock.status === "in-service", goodClock.status);

  // 2. 频率不符 => 409 不落库
  r = await req("POST", "/clocks", {
    code: "CLK-T2", escapementType: "杠杆式", balanceFrequency: "21600vph",
    escapementWearLevel: 1, pivotClearanceMm: 0.02, newHairspringFrequency: "28800vph"
  });
  check("频率不符 409", r.status === 409, r.status);
  r = await req("GET", "/clocks");
  check("409 后不落库", !r.json.data.some((c) => c.code === "CLK-T2"));

  // 3. 非法磨损等级
  r = await req("POST", "/clocks", {
    code: "CLK-T3", escapementType: "杠杆式", balanceFrequency: "21600vph",
    escapementWearLevel: 4, pivotClearanceMm: 0.02, newHairspringFrequency: "21600vph"
  });
  check("磨损等级4 => 400", r.status === 400, r.status);

  // 4. 三级磨损 => needs-service
  r = await req("POST", "/clocks", {
    code: "CLK-W3", escapementType: "杠杆式", balanceFrequency: "21600vph",
    escapementWearLevel: 3, pivotClearanceMm: 0.01, newHairspringFrequency: "21600vph"
  });
  const wearClock = r.json.data;
  check("三级磨损 needs-service", r.status === 201 && wearClock.status === "needs-service", r.status + " " + wearClock.status);

  // 待保养钟表不能登记调校/复测
  r = await req("POST", `/clocks/${wearClock.id}/adjustments`, { currentDailyRateSeconds: 30, direction: "慢", amount: "x" });
  check("待保养禁调校 403", r.status === 403, r.status);
  r = await req("POST", `/clocks/${wearClock.id}/retests`, { dailyRateSeconds: 1, amplitude: 270 });
  check("待保养禁复测 403", r.status === 403, r.status);

  // 5. 间隙正好 0.04 => 不超标；0.041 => 待保养
  r = await req("POST", "/clocks", {
    code: "CLK-C04", escapementType: "杠杆式", balanceFrequency: "18000vph",
    escapementWearLevel: 1, pivotClearanceMm: 0.04, newHairspringFrequency: "18000vph"
  });
  check("间隙0.04 可服务", r.json.data.status === "in-service", r.json.data.status);
  r = await req("POST", "/clocks", {
    code: "CLK-C041", escapementType: "杠杆式", balanceFrequency: "18000vph",
    escapementWearLevel: 2, pivotClearanceMm: 0.041, newHairspringFrequency: "18000vph"
  });
  const gapClock = r.json.data;
  check("间隙0.041 待保养", gapClock.status === "needs-service", gapClock.status);

  // 6. 待保养钟表不得进入合格列表
  r = await req("GET", "/clocks?qualified=true");
  check("合格列表无待保养", !r.json.data.some((c) => c.id === gapClock.id || c.id === wearClock.id));

  // 7. 保养闭环：登记保养（缺处理人 => 400）
  r = await req("POST", `/clocks/${gapClock.id}/maintenances`, { amplitude: 270, dailyRateSeconds: 9 });
  check("保养缺处理人 400", r.status === 400, r.status);
  r = await req("POST", `/clocks/${gapClock.id}/maintenances`, { handler: "王师傅", amplitude: 270, dailyRateSeconds: 9 });
  const maint = r.json.data;
  check("登记保养 201 并封锁", r.status === 201 && r.json.clock.status === "service-locked", r.status);
  check("保养记录字段", maint.handler === "王师傅" && maint.amplitude === 270 && maint.dailyRateSeconds === 9);

  // 封锁中不能调校
  r = await req("POST", `/clocks/${gapClock.id}/adjustments`, { currentDailyRateSeconds: 30, direction: "慢", amount: "x" });
  check("封锁中禁调校 403", r.status === 403, r.status);

  // 第一次关联复测达标
  r = await req("POST", `/clocks/${gapClock.id}/retests`, { dailyRateSeconds: 5, amplitude: 268 });
  check("复测1 关联保养", r.status === 201 && r.json.data.maintenanceId === maint.id, r.status);
  check("一次复测仍封锁", r.json.clock.status === "service-locked", r.json.clock.status);

  // 第二次达标 => 解除
  r = await req("POST", `/clocks/${gapClock.id}/retests`, { dailyRateSeconds: -3, amplitude: 271 });
  check("两次复测解除封锁", r.json.clock.status === "in-service" && r.json.clock.qualified === true, JSON.stringify(r.json.clock.status));

  // 8. 不达标复测不算数：另一个待保养表，连续两次中夹一次不合格
  r = await req("POST", `/clocks/${wearClock.id}/maintenances`, { handler: "李师傅", amplitude: 260, dailyRateSeconds: 40 });
  check("磨损表登记保养", r.status === 201);
  r = await req("POST", `/clocks/${wearClock.id}/retests`, { dailyRateSeconds: 5, amplitude: 262 });
  r = await req("POST", `/clocks/${wearClock.id}/retests`, { dailyRateSeconds: 99, amplitude: 262 });
  r = await req("POST", `/clocks/${wearClock.id}/retests`, { dailyRateSeconds: 2, amplitude: 265 });
  check("两次达标才解除（中间夹不合格不算）", r.json.clock.status === "service-locked", r.json.clock.status);
  r = await req("POST", `/clocks/${wearClock.id}/retests`, { dailyRateSeconds: 1, amplitude: 266 });
  check("补足第二次后解除", r.json.clock.status === "in-service", r.json.clock.status);

  // 9. 更换游丝：频率不符 409 不落库
  r = await req("POST", `/clocks/${gapClock.id}/hairspring-replacements`, { newHairspringFrequency: "28800vph" });
  check("换游丝频率不符 409", r.status === 409, r.status);

  // 符合机芯的更换 => 旧结论失效重算（此表间隙0.041，换新后仍需保养）
  r = await req("POST", `/clocks/${gapClock.id}/hairspring-replacements`, { newHairspringFrequency: "18000vph" });
  check("换游丝成功", r.status === 201, r.status);
  check("换后旧复测失效", r.json.clock.latestRetest === null && r.json.clock.qualified === false);
  check("换后旧调校结论失效", r.json.clock.latestAdjustment === null);
  check("换新使保养闭环回退为封锁", r.json.clock.status === "service-locked", r.json.clock.status);

  // 历史接口：旧记录保留但标记 superseded
  r = await req("GET", `/clocks/${gapClock.id}/history`);
  const hist = r.json.data;
  check("历史保留旧记录且标记失效", hist.retests.length === 2 && hist.retests.every((x) => x.superseded === true));
  check("历史含保养与更换记录", hist.maintenances.length === 1 && hist.hairspringReplacements.length === 1);

  // 最新复测接口结构与列表一致
  r = await req("GET", `/clocks/${gapClock.id}/latest-retest`);
  check("最新复测接口含 clock 统一状态", r.status === 200 && r.json.data.retest === null && r.json.data.clock.status === "service-locked");

  // 正常在服表：更换游丝后不再合格，需要重新复测
  r = await req("POST", `/clocks/${goodClock.id}/adjustments`, { currentDailyRateSeconds: 50, direction: "慢针", amount: "微调" });
  const adj = r.json.data;
  r = await req("POST", `/clocks/${goodClock.id}/retests`, { dailyRateSeconds: 2, amplitude: 275 });
  check("在服表复测关联调校", r.json.data.adjustmentId === adj.id);
  check("复测达标即合格", r.json.clock.qualified === true);
  r = await req("POST", `/clocks/${goodClock.id}/hairspring-replacements`, { newHairspringFrequency: "21600vph" });
  check("在服表换新成功", r.status === 201 && r.json.clock.qualified === false && r.json.clock.latestRetest === null);
  r = await req("GET", `/clocks/${goodClock.id}/latest-retest`);
  check("换新后最新复测为null但钟表在服", r.json.data.retest === null && r.json.data.clock.status === "in-service");

  // 合格列表与列表一致性
  r = await req("GET", "/clocks?qualified=true");
  check("换新后不进合格列表", !r.json.data.some((c) => c.id === goodClock.id));
  r = await req("POST", `/clocks/${goodClock.id}/adjustments`, { currentDailyRateSeconds: 40, direction: "慢针", amount: "再调" });
  const adj2 = r.json.data;
  r = await req("POST", `/clocks/${goodClock.id}/retests`, { dailyRateSeconds: 1, amplitude: 280 });
  check("换新后新复测关联新调校", r.json.data.adjustmentId === adj2.id && r.json.clock.qualified === true);
  r = await req("GET", "/clocks?qualified=true");
  check("重新达标后进入合格列表", r.json.data.some((c) => c.id === goodClock.id && c.status === "in-service"));

  // 404
  r = await req("GET", "/clocks/no-such/history");
  check("不存在 404", r.status === 404);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

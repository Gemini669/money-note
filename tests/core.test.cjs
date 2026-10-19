const { test } = require("node:test");
const assert = require("node:assert/strict");
const M = require("../js/core.js");

function record(overrides = {}) {
  return {
    id: "test-1",
    type: "expense",
    amountCents: 1234,
    date: "2026-10-19",
    category: "餐饮",
    note: "",
    createdAt: "2026-10-19T01:00:00.000Z",
    updatedAt: "2026-10-19T01:00:00.000Z",
    ...overrides,
  };
}
function backup(items) {
  return JSON.stringify({
    format: "moneynote",
    version: 1,
    exportedAt: "2026-10-19T02:00:00.000Z",
    transactions: items,
  });
}

test("金额精确转换成整数分，0.1 + 0.2 = 0.3", () => {
  assert.equal(M.parseAmount("0.10") + M.parseAmount("0.20"), 30);
  assert.equal(M.parseAmount(" 12.3 "), 1230);
  assert.equal(M.parseAmount("999999999.99"), M.MAX_AMOUNT_CENTS);
  assert.equal(M.parseAmount("0001.01"), 101);
  assert.equal(M.formatMoney(30), "¥0.30");
});

test("拒绝空值、负数、零、指数、NaN、无穷、多余小数和超限金额", () => {
  for (const amount of [
    "",
    " ",
    "-1",
    "0",
    "0.00",
    "NaN",
    "Infinity",
    "1e3",
    "+1",
    "1.001",
    "1000000000",
    "1,000",
    ".",
    "0x10",
    null,
    NaN,
    Infinity,
    1,
  ]) {
    assert.throws(() => M.parseAmount(amount), undefined, String(amount));
  }
});

test("校验真实日历日期和闰年，不受时区影响", () => {
  for (const date of ["2024-02-29", "2000-02-29", "1900-01-01", "9999-12-31"])
    assert.equal(M.validDate(date), true, date);
  for (const date of [
    "1900-02-29",
    "2026-02-29",
    "2026-04-31",
    "2026-13-01",
    "2026-00-01",
    "2026-01-00",
    "1899-12-31",
    "2026-1-1",
    "",
    null,
  ])
    assert.equal(M.validDate(date), false, date);
  assert.equal(M.localDate(new Date(2026, 0, 2, 0, 1)), "2026-01-02");
});

test("JSON 导出导入无损，保留中文、换行及不可信文本", () => {
  const items = [record({ note: "<img src=x onerror=alert(1)>\n咖啡☕" })];
  assert.deepEqual(M.parseBackup(M.makeBackup(items)), items);
  assert.deepEqual(M.parseBackup(M.makeBackup([])), []);
});

test("严格拒绝损坏格式、错误版本、缺失和额外字段", () => {
  for (const text of [
    "",
    "{",
    "null",
    "[]",
    "{}",
    '{"format":"moneynote","version":2}',
    JSON.stringify({
      format: "moneynote",
      version: 1,
      exportedAt: "yesterday",
      transactions: [],
    }),
    JSON.stringify({
      format: "moneynote",
      version: 1,
      exportedAt: "2026-10-19T02:00:00.000Z",
      transactions: [],
      extra: true,
    }),
  ])
    assert.throws(() => M.parseBackup(text));
  assert.throws(() => M.parseBackup(backup([{ ...record(), extra: "x" }])));
  const missing = record();
  delete missing.note;
  assert.throws(() => M.parseBackup(backup([missing])));
  assert.throws(() => M.parseBackup(backup(null)));
});

test("严格拒绝每一项无效账目，不部分接受", () => {
  const invalid = [
    { amountCents: 0 },
    { amountCents: -1 },
    { amountCents: 1.5 },
    { amountCents: "100" },
    { amountCents: Number.MAX_SAFE_INTEGER + 1 },
    { amountCents: M.MAX_AMOUNT_CENTS + 1 },
    { amountCents: null },
    { date: "2026-02-30" },
    { date: "2026-1-01" },
    { type: "transfer" },
    { type: "income", category: "餐饮" },
    { category: "__proto__" },
    { note: 123 },
    { note: "字".repeat(201) },
    { id: "" },
    { id: "<script>" },
    { createdAt: "2026-02-30T01:00:00.000Z" },
    { updatedAt: "2026-10-18T01:00:00.000Z" },
    { updatedAt: "" },
  ];
  for (const overrides of invalid)
    assert.throws(
      () =>
        M.parseBackup(
          backup([
            record({ id: "valid" }),
            record({ id: "invalid", ...overrides }),
          ]),
        ),
      undefined,
      JSON.stringify(overrides),
    );
  assert.throws(() => M.parseBackup(backup([record(), record()])), /重复/);
});

test("限制文件大小和账目数以保护浏览器", () => {
  assert.throws(() => M.parseBackup(" ".repeat(M.MAX_FILE_BYTES + 1)), /10 MB/);
  assert.throws(
    () => M.validateRecords(Array(M.MAX_RECORDS + 1).fill(record())),
    /最多支持/,
  );
});

test("整月统计、结余、分类占比的数据基础及负结余", () => {
  const items = [
    record({ id: "a", amountCents: 10 }),
    record({ id: "b", amountCents: 20 }),
    record({ id: "c", type: "income", category: "工资", amountCents: 100 }),
    record({ id: "d", date: "2026-09-30", amountCents: 200 }),
  ];
  const stats = M.summarize(items, "2026-10");
  assert.deepEqual(
    {
      income: stats.income,
      expense: stats.expense,
      balance: stats.balance,
      count: stats.count,
    },
    { income: 100, expense: 30, balance: 70, count: 3 },
  );
  assert.equal(stats.categories["餐饮"], 30);
  assert.equal(M.summarize(items, "2026-09").balance, -200);
  assert.equal(M.summarize(items, "2025-01").count, 0);
  assert.equal(M.summarize(items).expense, 230);
});

test("月、类别、搜索组合筛选，区分两种其他，顺序稳定且不修改原数据", () => {
  const items = [
    record({ id: "a", date: "2026-10-01", category: "其他", note: "ABC 午餐" }),
    record({ id: "b", date: "2026-10-02", type: "income", category: "其他" }),
    record({ id: "c", date: "2026-09-01" }),
  ];
  assert.deepEqual(
    M.filterRecords(items, { month: "2026-10" }).map((r) => r.id),
    ["b", "a"],
  );
  assert.deepEqual(
    M.filterRecords(items, { category: "expense:其他" }).map((r) => r.id),
    ["a"],
  );
  assert.deepEqual(
    M.filterRecords(items, {
      month: "2026-10",
      category: "expense:其他",
      keyword: "abc",
    }).map((r) => r.id),
    ["a"],
  );
  assert.equal(M.filterRecords(items, { keyword: "不存在" }).length, 0);
  assert.equal(M.filterRecords(items, { keyword: "12.34" }).length, 3);
  assert.equal(items[0].id, "a");
});

test("最大账目数和金额的汇总保持安全整数", () => {
  const items = Array.from({ length: M.MAX_RECORDS }, (_, id) =>
    record({ id: String(id), amountCents: M.MAX_AMOUNT_CENTS }),
  );
  const stats = M.summarize(M.validateRecords(items));
  assert.equal(stats.expense, M.MAX_RECORDS * M.MAX_AMOUNT_CENTS);
  assert.ok(Number.isSafeInteger(stats.expense));
  assert.doesNotThrow(() => M.formatMoney(stats.expense));
});

test("保存时也限制序列化大小，避免生成自身无法恢复的备份", () => {
  const items = Array.from({ length: M.MAX_RECORDS }, (_, id) =>
    record({ id: String(id), note: "\u0000".repeat(200) }),
  );
  assert.throws(() => M.makeBackup(items), /10 MB/);
});

test("CSV 带 BOM、转义逗号双引号换行，并中和公式注入", () => {
  const csv = M.toCSV([
    record({ id: "a", note: '他说"你好",\n午餐' }),
    record({ id: "b", note: ' =HYPERLINK("https://example.test")' }),
    record({ id: "c", note: "\t@SUM(1)" }),
    record({ id: "d", note: "+1+1" }),
  ]);
  assert.ok(csv.startsWith('\uFEFF"日期"'));
  assert.ok(csv.includes('"他说""你好"",\n午餐"'));
  assert.ok(csv.includes('"\' =HYPERLINK(""https://example.test"")"'));
  assert.ok(csv.includes('"\'\t@SUM(1)"'));
  assert.ok(csv.includes('"\'+1+1"'));
  assert.ok(csv.includes('"12.34"'));
});

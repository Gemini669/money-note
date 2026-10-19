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

test("年度空账本保留12个月及全部分类，金额和占比均为零", () => {
  const data = M.summarizeYear([], 2026);
  assert.equal(data.count, 0);
  for (const key of [
    "income",
    "expense",
    "balance",
    "averageIncome",
    "averageExpense",
    "incomeCount",
    "expenseCount",
  ])
    assert.equal(data[key], 0);
  assert.equal(data.months.length, 12);
  assert.deepEqual(
    data.months.map((m) => m.key),
    Array.from(
      { length: 12 },
      (_, i) => `2026-${String(i + 1).padStart(2, "0")}`,
    ),
  );
  assert.ok(
    data.months.every(
      (m) => m.income === 0 && m.expense === 0 && m.balance === 0,
    ),
  );
  assert.equal(data.expenseCategories.length, 8);
  assert.equal(data.incomeCategories.length, 4);
  assert.ok(
    [...data.expenseCategories, ...data.incomeCategories].every(
      (c) => c.share === 0 && c.amountCents === 0,
    ),
  );
});

test("年度只收入：笔数和按全年12个月计算的月均值正确", () => {
  const data = M.summarizeYear(
    [
      record({
        type: "income",
        category: "工资",
        amountCents: 12000,
        date: "2026-01-01",
      }),
    ],
    "2026",
  );
  assert.equal(data.income, 12000);
  assert.equal(data.balance, 12000);
  assert.equal(data.incomeCount, 1);
  assert.equal(data.expenseCount, 0);
  assert.equal(data.averageIncome, 1000);
  assert.equal(data.averageExpense, 0);
  assert.equal(data.incomeCategories[0].share, 1);
  assert.ok(data.expenseCategories.every((c) => c.share === 0));
});

test("年度只支出：负结余不会归零，最高月份包含无记录的零结余月", () => {
  const data = M.summarizeYear(
    [record({ amountCents: 1200, date: "2026-01-01" })],
    2026,
  );
  assert.equal(data.balance, -1200);
  assert.equal(data.months[0].balance, -1200);
  assert.equal(data.expenseCount, 1);
  assert.equal(data.averageExpense, 100);
  assert.equal(data.highestBalance, 0);
  assert.deepEqual(data.highestMonths, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(data.lowestMonths, [1]);
});

test("年度筛选以交易日期为准，正确包含年初年末及闰日", () => {
  const records = [
    record({ id: "a", date: "2025-12-31" }),
    record({ id: "b", date: "2026-01-01" }),
    record({ id: "c", date: "2026-12-31" }),
    record({ id: "d", date: "2027-01-01" }),
    record({ id: "e", date: "2024-02-29" }),
  ];
  assert.deepEqual(
    M.filterByYear(records, 2026).map((r) => r.id),
    ["b", "c"],
  );
  assert.equal(M.summarizeYear(records, 2026).expense, 2468);
  assert.equal(M.summarizeYear(records, 2024).months[1].expense, 1234);
  assert.equal(M.summarizeYear(records, 2025).count, 1);
});

test("年度12个月部分有记录时补零，笔数、月均取整、极值正确", () => {
  const records = [
    record({
      id: "a",
      date: "2026-01-01",
      type: "income",
      category: "工资",
      amountCents: 1200,
    }),
    record({ id: "b", date: "2026-01-31", amountCents: 200 }),
    record({ id: "c", date: "2026-02-01", amountCents: 600 }),
  ];
  const data = M.summarizeYear(records, 2026);
  assert.equal(data.income, 1200);
  assert.equal(data.expense, 800);
  assert.equal(data.balance, 400);
  assert.equal(data.averageIncome, 100);
  assert.equal(data.averageExpense, 67);
  assert.deepEqual(data.highestMonths, [1]);
  assert.deepEqual(data.lowestMonths, [2]);
  assert.equal(data.highestBalance, 1000);
  assert.equal(data.lowestBalance, -600);
  assert.equal(data.months[0].incomeCount, 1);
  assert.equal(data.months[0].expenseCount, 1);
  assert.ok(
    data.months
      .slice(2)
      .every((m) => m.income === 0 && m.expense === 0 && m.balance === 0),
  );
  assert.deepEqual(M.monthlySeries(records, 2026), data.months);
});

test("年度分类金额、笔数、比例、排行和合计正确，收入其他与支出其他独立", () => {
  const records = [
    record({ id: "a", category: "餐饮", amountCents: 100 }),
    record({ id: "b", category: "交通", amountCents: 300 }),
    record({ id: "c", category: "餐饮", amountCents: 100 }),
    record({ id: "d", category: "其他", amountCents: 100 }),
    record({ id: "e", type: "income", category: "工资", amountCents: 100 }),
    record({ id: "f", type: "income", category: "其他", amountCents: 300 }),
  ];
  const data = M.summarizeYear(records, 2026);
  assert.deepEqual(
    data.expenseCategories.slice(0, 3).map((c) => c.category),
    ["交通", "餐饮", "其他"],
  );
  assert.equal(data.expenseCategories[0].share, 0.5);
  assert.equal(data.expenseCategories[1].count, 2);
  assert.equal(data.incomeCategories[0].category, "其他");
  assert.equal(data.incomeCategories[0].share, 0.75);
  for (const [categories, total] of [
    [data.expenseCategories, data.expense],
    [data.incomeCategories, data.income],
  ]) {
    assert.equal(
      categories.reduce((sum, c) => sum + c.amountCents, 0),
      total,
    );
    assert.ok(
      Math.abs(categories.reduce((sum, c) => sum + c.share, 0) - 1) < 1e-12,
    );
  }
  assert.deepEqual(
    M.summarizeYearCategories(records, 2026, "income"),
    data.incomeCategories,
  );
});

test("年度金额精度及月均按分四舍五入，保留小额交易", () => {
  const data = M.summarizeYear(
    [
      record({ id: "a", amountCents: M.parseAmount("0.10") }),
      record({ id: "b", amountCents: M.parseAmount("0.20") }),
    ],
    2026,
  );
  assert.equal(data.expense, 30);
  assert.equal(data.balance, -30);
  assert.equal(data.averageExpense, 3);
  assert.equal(M.formatMoney(data.expense), "¥0.30");
  assert.equal(
    M.summarizeYear([record({ amountCents: 5 })], 2026).averageExpense,
    0,
  );
  assert.equal(
    M.summarizeYear([record({ amountCents: 6 })], 2026).averageExpense,
    1,
  );
});

test("年度大额边界与10000条汇总仍是安全整数，月均与BigInt参考值一致", () => {
  const records = Array.from({ length: M.MAX_RECORDS }, (_, i) =>
    record({ id: String(i), amountCents: M.MAX_AMOUNT_CENTS }),
  );
  const data = M.summarizeYear(records, 2026);
  const total = BigInt(M.MAX_RECORDS) * BigInt(M.MAX_AMOUNT_CENTS);
  assert.equal(data.expense, Number(total));
  assert.ok(Number.isSafeInteger(data.expense));
  assert.equal(data.balance, -Number(total));
  assert.equal(data.averageExpense, Number((total + 6n) / 12n));
  assert.equal(data.expenseCategories[0].amountCents, Number(total));
});

test("年度分析是纯读取，不改变冻结的原账目或V1备份", () => {
  const records = Object.freeze([
    Object.freeze(record()),
    Object.freeze(record({ id: "b", date: "2025-01-01" })),
  ]);
  const before = M.makeBackup(records, "2026-10-19T02:00:00.000Z");
  M.filterByYear(records, 2026);
  M.monthlySeries(records, 2026);
  M.summarizeYearCategories(records, 2026, "expense");
  M.summarizeYear(records, 2026);
  assert.equal(M.makeBackup(records, "2026-10-19T02:00:00.000Z"), before);
});

test("年度分析兼容固定V1 JSON，存储键和备份结构版本不变", () => {
  const text =
    '{"format":"moneynote","version":1,"exportedAt":"2026-10-19T02:00:00.000Z","transactions":[{"id":"v1","date":"2025-12-31","type":"income","amountCents":12345,"category":"奖金","note":"隔离的兼容性测试","createdAt":"2026-10-19T01:00:00.000Z","updatedAt":"2026-10-19T01:00:00.000Z"}]}';
  const records = M.parseBackup(text);
  assert.equal(M.STORAGE_KEY, "moneynote.data.v1");
  assert.equal(M.summarizeYear(records, 2025).income, 12345);
  assert.equal(M.summarizeYear(records, 2026).count, 0);
  const exported = JSON.parse(M.makeBackup(records));
  assert.equal(exported.format, "moneynote");
  assert.equal(exported.version, 1);
  assert.deepEqual(Object.keys(exported), [
    "format",
    "version",
    "exportedAt",
    "transactions",
  ]);
  assert.deepEqual(exported.transactions, JSON.parse(text).transactions);
});

test("年度年份和分类类型边界严格验证", () => {
  for (const year of [
    "",
    null,
    undefined,
    1899,
    10000,
    2026.5,
    "2e3",
    "02026",
    " 2026",
    "NaN",
    Infinity,
  ])
    assert.throws(() => M.summarizeYear([], year));
  for (const year of [1900, 9999, "2026"])
    assert.equal(M.monthlySeries([], year).length, 12);
  assert.throws(() => M.summarizeYearCategories([], 2026, "transfer"));
});

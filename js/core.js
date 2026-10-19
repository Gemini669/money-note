/* MoneyNote 的纯数据逻辑；浏览器和 Node.js 测试共用。无网络依赖。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MoneyNote = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const STORAGE_KEY = "moneynote.data.v1";
  const MAX_AMOUNT_CENTS = 99999999999;
  const MAX_RECORDS = 10000;
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const CATEGORIES = Object.freeze({
    expense: Object.freeze([
      "餐饮",
      "交通",
      "购物",
      "住房",
      "医疗",
      "教育",
      "娱乐",
      "其他",
    ]),
    income: Object.freeze(["工资", "奖金", "投资", "其他"]),
  });
  const COLORS = Object.freeze([
    "#3679f5",
    "#65b6ff",
    "#8b7ae6",
    "#42b5a5",
    "#f2ac56",
    "#e280a5",
    "#8998b7",
    "#c0cbdc",
  ]);
  const moneyFormatter = new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
  });

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function parseAmount(value) {
    assert(
      typeof value === "string" && /^\d{1,9}(\.\d{1,2})?$/.test(value.trim()),
      "请输入有效金额，最多 9 位整数和 2 位小数。",
    );
    const [whole, fraction = ""] = value.trim().split(".");
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    assert(
      Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_AMOUNT_CENTS,
      "金额须大于 0，且不超过 999,999,999.99 元。",
    );
    return cents;
  }

  function validDate(date) {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date))
      return false;
    const [year, month, day] = date.split("-").map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return (
      year >= 1900 &&
      year <= 9999 &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= days[month - 1]
    );
  }

  function localDate(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function validTimestamp(value) {
    return (
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value
    );
  }

  function exactKeys(object, keys) {
    return (
      object !== null &&
      typeof object === "object" &&
      !Array.isArray(object) &&
      Object.keys(object).length === keys.length &&
      keys.every((key) => Object.hasOwn(object, key))
    );
  }

  function validateRecords(records) {
    assert(Array.isArray(records), "transactions 必须是数组。");
    assert(records.length <= MAX_RECORDS, `最多支持 ${MAX_RECORDS} 条账目。`);
    const ids = new Set();
    return records.map((item, index) => {
      const label = `第 ${index + 1} 条账目：`;
      assert(
        exactKeys(item, [
          "id",
          "date",
          "type",
          "amountCents",
          "category",
          "note",
          "createdAt",
          "updatedAt",
        ]),
        `${label}字段不完整或含有未知字段。`,
      );
      assert(
        typeof item.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(item.id),
        `${label}编号无效。`,
      );
      assert(!ids.has(item.id), `${label}编号重复。`);
      ids.add(item.id);
      assert(validDate(item.date), `${label}日期无效。`);
      assert(
        item.type === "income" || item.type === "expense",
        `${label}收支类型无效。`,
      );
      assert(
        Number.isSafeInteger(item.amountCents) &&
          item.amountCents > 0 &&
          item.amountCents <= MAX_AMOUNT_CENTS,
        `${label}金额必须是有效的正整数分。`,
      );
      assert(
        CATEGORIES[item.type].includes(item.category),
        `${label}分类与收支类型不匹配。`,
      );
      assert(
        typeof item.note === "string" && item.note.length <= 200,
        `${label}备注必须是 200 字以内的文本。`,
      );
      assert(
        validTimestamp(item.createdAt) && validTimestamp(item.updatedAt),
        `${label}时间戳无效。`,
      );
      assert(
        item.updatedAt >= item.createdAt,
        `${label}修改时间不能早于创建时间。`,
      );
      return {
        id: item.id,
        date: item.date,
        type: item.type,
        amountCents: item.amountCents,
        category: item.category,
        note: item.note,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
    });
  }

  function parseBackup(text) {
    assert(
      typeof text === "string" &&
        new TextEncoder().encode(text).length <= MAX_FILE_BYTES,
      "备份文件不能超过 10 MB。",
    );
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("不是有效的 JSON 文件。");
    }
    assert(
      exactKeys(data, ["format", "version", "exportedAt", "transactions"]),
      "备份结构无效，请使用 MoneyNote 导出的 JSON 文件。",
    );
    assert(
      data.format === "moneynote" && data.version === 1,
      "备份格式或版本不受支持。",
    );
    assert(validTimestamp(data.exportedAt), "备份导出时间无效。");
    return validateRecords(data.transactions);
  }

  function makeBackup(records, time = new Date().toISOString()) {
    assert(validTimestamp(time), "导出时间无效。");
    const json = JSON.stringify(
      {
        format: "moneynote",
        version: 1,
        exportedAt: time,
        transactions: validateRecords(records),
      },
      null,
      2,
    );
    assert(
      new TextEncoder().encode(json).length <= MAX_FILE_BYTES,
      "账本超过 10 MB，未保存。请先导出备份并整理账目。",
    );
    return json;
  }

  function summarize(records, month) {
    const categories = Object.fromEntries(
      CATEGORIES.expense.map((category) => [category, 0]),
    );
    let income = 0;
    let expense = 0;
    let count = 0;
    for (const item of records) {
      if (month && item.date.slice(0, 7) !== month) continue;
      count++;
      if (item.type === "income") income += item.amountCents;
      else {
        expense += item.amountCents;
        categories[item.category] += item.amountCents;
      }
    }
    return { income, expense, balance: income - expense, categories, count };
  }

  // 年度分析仅以交易日期筛选；不会修改记录、备份或本地存储。
  function yearKey(year) {
    const key = String(year);
    assert(
      /^\d{4}$/.test(key) && Number(key) >= 1900 && Number(key) <= 9999,
      "请选择 1900 年至 9999 年之间的年份。",
    );
    return key;
  }

  function filterByYear(records, year) {
    const prefix = `${yearKey(year)}-`;
    return records.filter((item) => item.date.startsWith(prefix));
  }

  function monthlySeries(records, year) {
    const key = yearKey(year);
    const months = Array.from({ length: 12 }, (_, index) => ({
      month: index + 1,
      key: `${key}-${String(index + 1).padStart(2, "0")}`,
      income: 0,
      expense: 0,
      balance: 0,
      incomeCount: 0,
      expenseCount: 0,
    }));
    for (const item of filterByYear(records, key)) {
      const month = months[Number(item.date.slice(5, 7)) - 1];
      month[item.type] += item.amountCents;
      month[`${item.type}Count`]++;
    }
    for (const month of months) month.balance = month.income - month.expense;
    return months;
  }

  function summarizeYearCategories(records, year, type) {
    assert(type === "expense" || type === "income", "分类统计类型无效。");
    const categories = CATEGORIES[type].map((category) => ({
      category,
      amountCents: 0,
      count: 0,
      share: 0,
    }));
    let total = 0;
    for (const item of filterByYear(records, year)) {
      if (item.type !== type) continue;
      const category = categories.find((row) => row.category === item.category);
      category.amountCents += item.amountCents;
      category.count++;
      total += item.amountCents;
    }
    for (const category of categories)
      category.share = total ? category.amountCents / total : 0;
    // 金额相同时维持现有分类顺序，零值分类也保留在数据模型中。
    return categories.sort((a, b) => b.amountCents - a.amountCents);
  }

  function summarizeYear(records, year) {
    const key = yearKey(year);
    const months = monthlySeries(records, key);
    const totals = months.reduce(
      (sum, month) => ({
        income: sum.income + month.income,
        expense: sum.expense + month.expense,
        incomeCount: sum.incomeCount + month.incomeCount,
        expenseCount: sum.expenseCount + month.expenseCount,
      }),
      { income: 0, expense: 0, incomeCount: 0, expenseCount: 0 },
    );
    const highestBalance = Math.max(...months.map((month) => month.balance));
    const lowestBalance = Math.min(...months.map((month) => month.balance));
    return {
      year: Number(key),
      ...totals,
      balance: totals.income - totals.expense,
      count: totals.incomeCount + totals.expenseCount,
      // 全部汇总为整数分；均值按 12 个月四舍五入到分，包含零记录月份。
      averageIncome: Math.floor((totals.income + 6) / 12),
      averageExpense: Math.floor((totals.expense + 6) / 12),
      months,
      expenseCategories: summarizeYearCategories(records, key, "expense"),
      incomeCategories: summarizeYearCategories(records, key, "income"),
      highestBalance,
      lowestBalance,
      highestMonths: months
        .filter((month) => month.balance === highestBalance)
        .map((month) => month.month),
      lowestMonths: months
        .filter((month) => month.balance === lowestBalance)
        .map((month) => month.month),
    };
  }

  function filterRecords(
    records,
    { month = "", category = "", keyword = "", type = "" } = {},
  ) {
    const query = keyword.trim().toLocaleLowerCase("zh-CN");
    return records
      .filter(
        (item) =>
          (!month || item.date.startsWith(`${month}-`)) &&
          (!category || `${item.type}:${item.category}` === category) &&
          (!type || item.type === type) &&
          (!query ||
            `${item.note} ${item.category} ${item.date} ${item.amountCents / 100}`
              .toLocaleLowerCase("zh-CN")
              .includes(query)),
      )
      .sort(
        (a, b) =>
          b.date.localeCompare(a.date) ||
          b.createdAt.localeCompare(a.createdAt) ||
          a.id.localeCompare(b.id),
      );
  }

  function formatMoney(cents) {
    assert(Number.isSafeInteger(cents), "金额超出安全范围。");
    // 单条金额和汇总均先用整数分计算，最后一步才格式化为人民币。
    return moneyFormatter.format(cents / 100);
  }

  function csvCell(value) {
    let text = String(value);
    // 中和电子表格公式，包括以空白或控制字符开头的公式。
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text))
      text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }

  function toCSV(records) {
    const rows = [["日期", "类型", "分类", "金额（元）", "备注"]];
    for (const item of filterRecords(validateRecords(records))) {
      const amount = `${Math.floor(item.amountCents / 100)}.${String(item.amountCents % 100).padStart(2, "0")}`;
      rows.push([
        item.date,
        item.type === "income" ? "收入" : "支出",
        item.category,
        amount,
        item.note,
      ]);
    }
    return (
      "\uFEFF" +
      rows.map((row) => row.map(csvCell).join(",")).join("\r\n") +
      "\r\n"
    );
  }

  return Object.freeze({
    STORAGE_KEY,
    MAX_AMOUNT_CENTS,
    MAX_RECORDS,
    MAX_FILE_BYTES,
    CATEGORIES,
    COLORS,
    parseAmount,
    validDate,
    localDate,
    validateRecords,
    parseBackup,
    makeBackup,
    summarize,
    filterByYear,
    monthlySeries,
    summarizeYearCategories,
    summarizeYear,
    filterRecords,
    formatMoney,
    toCSV,
  });
});

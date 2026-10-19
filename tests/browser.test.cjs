// 仅测试使用 Node.js 和 Playwright；应用本身不需要 Node.js、安装或构建。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
const M = require("../js/core.js");
const root = path.resolve(__dirname, "..");
let server, browser, base;
const time = "2026-10-19T01:00:00.000Z";
function entry(overrides = {}) {
  return {
    id: "test-1",
    date: "2026-10-19",
    type: "expense",
    category: "餐饮",
    amountCents: 1234,
    note: "午餐",
    createdAt: time,
    updatedAt: time,
    ...overrides,
  };
}
async function values(page) {
  return page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("moneynote.data.v1"))?.transactions ?? [],
  );
}
async function amountText(page, id) {
  return page.locator(`#${id}`).textContent();
}
async function openPage(options = {}, seed = null) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  if (seed !== null)
    await context.addInitScript(
      ({ seed, key }) => {
        if (sessionStorage.getItem("seeded") !== "yes") {
          localStorage.setItem(key, seed);
          sessionStorage.setItem("seeded", "yes");
        }
      },
      { seed, key: M.STORAGE_KEY },
    );
  await page.goto(base);
  await page.locator("#month").fill("2026-10");
  await page.locator("#month").dispatchEvent("change");
  return { context, page };
}
async function add(
  page,
  {
    amount = "12.34",
    type = "expense",
    category = "餐饮",
    date = "2026-10-19",
    note = "午餐",
  } = {},
) {
  // 手机按钮可见时从底部操作，桌面从顶部操作。
  const button = (await page.locator("#add-top").isVisible())
    ? "#add-top"
    : "#add-mobile";
  await page.locator(button).click();
  await page.locator(`input[name="type"][value="${type}"]`).check();
  await page.locator("#amount").fill(amount);
  await page.locator("#date").fill(date);
  await page.locator("#category").selectOption(category);
  await page.locator("#note").fill(note);
  await page.locator("#save-entry").click();
}
async function importJSON(page, text, confirm = true) {
  let confirmation;
  const handler = async (dialog) => {
    confirmation = dialog.message();
    await (confirm ? dialog.accept() : dialog.dismiss());
  };
  page.once("dialog", handler);
  await page.locator("#import-file").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(text),
  });
  await page.waitForFunction(
    () => !document.getElementById("import-json").disabled,
  );
  page.removeListener("dialog", handler);
  return confirmation;
}

before(async () => {
  server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(
        new URL(req.url, "http://test").pathname,
      );
      if (!pathname.startsWith("/money-note/")) {
        res.writeHead(404);
        res.end();
        return;
      }
      const filename = path.resolve(
        root,
        pathname.slice("/money-note/".length) || "index.html",
      );
      if (!filename.startsWith(root + path.sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const types = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
      };
      const body = await fs.readFile(filename);
      res.writeHead(200, {
        "Content-Type":
          types[path.extname(filename)] || "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/money-note/`;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: process.env.CHROMIUM_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
  });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

test("项目子路径加载、空态、无第三方请求和脚本错误", async () => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors = [],
    requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(base);
  assert.equal(await page.title(), "小账本 MoneyNote V2.0 · 把生活记清楚");
  assert.ok(await page.locator("#list-empty").isVisible());
  assert.equal(await amountText(page, "income-total"), "¥0.00");
  assert.equal(await page.locator(".transaction-row").count(), 0);
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  assert.deepEqual(errors, []);
  assert.ok(requests.length >= 4);
  assert.ok(requests.every((url) => url.startsWith(base)));
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await context.close();
});

test("新增收支、整数分统计、图表和刷新保留", async () => {
  const { context, page } = await openPage();
  await add(page, { amount: "0.10", note: "第一笔" });
  await add(page, { amount: "0.20", category: "交通", note: "第二笔" });
  await add(page, {
    amount: "100",
    type: "income",
    category: "工资",
    note: "工资到账",
  });
  assert.equal((await values(page)).length, 3);
  assert.equal(await amountText(page, "expense-total"), "¥0.30");
  assert.equal(await amountText(page, "income-total"), "¥100.00");
  assert.equal(await amountText(page, "balance-total"), "¥99.70");
  assert.equal(await page.locator("#category-legend li").count(), 2);
  assert.match(
    await page.locator("#expense-chart").getAttribute("style"),
    /conic-gradient/,
  );
  await page.reload();
  await page.locator("#month").fill("2026-10");
  await page.locator("#month").dispatchEvent("change");
  assert.equal((await values(page)).length, 3);
  assert.equal(await amountText(page, "expense-total"), "¥0.30");
  await context.close();
});

test("编辑立即更新统计，删除有确认且取消不删除", async () => {
  const { context, page } = await openPage({}, M.makeBackup([entry()]));
  await page.getByRole("button", { name: /^编辑 / }).click();
  await page.locator("#amount").fill("22.34");
  await page.locator("#category").selectOption("购物");
  await page.locator("#note").fill("新的备注");
  await page.locator("#save-entry").click();
  assert.equal(await amountText(page, "expense-total"), "¥22.34");
  assert.equal((await values(page))[0].category, "购物");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: /^删除 / }).click();
  assert.equal((await values(page)).length, 1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /^删除 / }).click();
  assert.equal((await values(page)).length, 0);
  assert.equal(await amountText(page, "expense-total"), "¥0.00");
  assert.ok(await page.locator("#list-empty").isVisible());
  await context.close();
});

test("年月、分类、关键词筛选组合；筛选不改整月统计", async () => {
  const seed = [
    entry(),
    entry({
      id: "two",
      date: "2026-10-01",
      category: "交通",
      note: "地铁",
      amountCents: 300,
    }),
    entry({ id: "three", date: "2026-09-01", amountCents: 100 }),
  ];
  const { context, page } = await openPage({}, M.makeBackup(seed));
  assert.equal(await page.locator(".transaction-row").count(), 2);
  await page.locator("#category-filter").selectOption("expense:交通");
  await page.locator("#search").fill("地铁");
  assert.equal(await page.locator(".transaction-row").count(), 1);
  assert.equal(await amountText(page, "expense-total"), "¥15.34");
  await page.locator("#search").fill("没有这笔");
  assert.ok(await page.locator("#list-empty").isVisible());
  await page.locator("#clear-filters").click();
  await page.locator("#prev-month").click();
  assert.equal(await page.locator("#month").inputValue(), "2026-09");
  assert.equal(await page.locator(".transaction-row").count(), 1);
  assert.equal(await amountText(page, "expense-total"), "¥1.00");
  await context.close();
});

test("JSON/CSV 下载包含全部月份，JSON 可恢复；取消恢复保留原账目", async () => {
  const seed = [
    entry({ note: "=1+1" }),
    entry({ id: "other", date: "2026-09-01", note: '逗号,及"引号"' }),
  ];
  const { context, page } = await openPage({}, M.makeBackup(seed));
  const jsonPromise = page.waitForEvent("download");
  await page.locator("#export-json").click();
  const json = await jsonPromise;
  const exported = await fs.readFile(await json.path(), "utf8");
  assert.equal(M.parseBackup(exported).length, 2);
  const csvPromise = page.waitForEvent("download");
  await page.locator("#export-csv").click();
  const csv = await fs.readFile(await (await csvPromise).path(), "utf8");
  assert.ok(csv.includes("'=1+1"));
  assert.ok(csv.includes('逗号,及""引号""'));
  const canceled = await importJSON(page, M.makeBackup([]), false);
  assert.match(canceled, /0 笔/);
  assert.equal((await values(page)).length, 2);
  await importJSON(page, M.makeBackup([]));
  assert.equal((await values(page)).length, 0);
  await importJSON(page, exported);
  assert.deepEqual(await values(page), seed);
  await context.close();
});

test("无效导入不弹替换确认，数据原样保留；空备份明确确认", async () => {
  const { context, page } = await openPage({}, M.makeBackup([entry()]));
  const before = await page.evaluate(
    (key) => localStorage.getItem(key),
    M.STORAGE_KEY,
  );
  for (const invalid of [
    "{",
    "[]",
    M.makeBackup([entry()]).replace("1234", "-1"),
    M.makeBackup([entry(), entry({ id: "other" })]).replace(
      '"other"',
      '"test-1"',
    ),
  ]) {
    const confirmation = await importJSON(page, invalid);
    assert.equal(confirmation, undefined);
    assert.equal(
      await page.evaluate((key) => localStorage.getItem(key), M.STORAGE_KEY),
      before,
    );
    assert.match(await page.locator("#toast").textContent(), /导入未完成/);
  }
  await context.close();
});

test("用户 HTML 安全渲染为文本，金额错误不写入", async () => {
  const { context, page } = await openPage();
  await add(page, { note: '<img src=x onerror="window.injected=true">' });
  assert.match(await page.locator(".transaction-name").textContent(), /<img/);
  assert.equal(await page.locator(".transaction-row img").count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  for (const amount of ["-1", "0", "NaN", "Infinity", "1e3", "1.001", ""]) {
    await add(page, { amount });
    assert.ok(await page.locator("#form-error").isVisible());
    assert.equal((await values(page)).length, 1);
    await page.locator("#cancel-entry").click();
  }
  await context.close();
});

test("已有损坏数据保护、原始下载及导入恢复", async () => {
  const { context, page } = await openPage({}, "{broken data");
  assert.ok(await page.locator("#storage-warning").isVisible());
  assert.ok(await page.locator("#add-top").isDisabled());
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), M.STORAGE_KEY),
    "{broken data",
  );
  const promise = page.waitForEvent("download");
  await page.locator("#download-original").click();
  assert.equal(
    await fs.readFile(await (await promise).path(), "utf8"),
    "{broken data",
  );
  await importJSON(page, M.makeBackup([entry()]));
  assert.ok(await page.locator("#storage-warning").isHidden());
  assert.ok(await page.locator("#add-top").isEnabled());
  assert.equal((await values(page)).length, 1);
  await context.close();
});

test("存储配额失败不更新 UI 或覆盖已有账目", async () => {
  const { context, page } = await openPage({}, M.makeBackup([entry()]));
  await page.evaluate(() => {
    Storage.prototype.setItem = function () {
      throw new DOMException("Full", "QuotaExceededError");
    };
  });
  await add(page, { amount: "100" });
  assert.match(await page.locator("#form-error").textContent(), /空间不足/);
  assert.equal((await values(page)).length, 1);
  assert.equal(await amountText(page, "expense-total"), "¥12.34");
  await context.close();
});

test("浏览器禁用存储时给出明确保护提示", async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    Storage.prototype.getItem = function () {
      throw new DOMException("Storage disabled", "SecurityError");
    };
  });
  const page = await context.newPage();
  await page.goto(base);
  assert.ok(await page.locator("#storage-warning").isVisible());
  assert.ok(await page.locator("#add-top").isDisabled());
  assert.ok(await page.locator("#export-json").isDisabled());
  assert.match(
    await page.locator("#storage-message").textContent(),
    /不会自动覆盖/,
  );
  await context.close();
});

test("超大文件在读取前拒绝，键盘 Esc 取消新增不写入", async () => {
  const { context, page } = await openPage();
  await page.locator("#import-file").setInputFiles({
    name: "oversized.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(M.MAX_FILE_BYTES + 1, 32),
  });
  await page.waitForFunction(
    () => !document.getElementById("import-json").disabled,
  );
  assert.match(await page.locator("#toast").textContent(), /10 MB/);
  await page.locator("#add-top").click();
  assert.equal(await page.evaluate(() => document.activeElement.id), "amount");
  await page.keyboard.press("Escape");
  assert.ok(await page.locator("#entry-dialog").isHidden());
  assert.equal((await values(page)).length, 0);
  await context.close();
});

test("多标签页同步并阻止覆盖已经修改的账目", async () => {
  const { context, page } = await openPage({}, M.makeBackup([entry()]));
  const second = await context.newPage();
  await second.goto(base);
  await second.locator("#month").fill("2026-10");
  await second.locator("#month").dispatchEvent("change");
  await page.getByRole("button", { name: /^编辑 / }).click();
  await second.getByRole("button", { name: /^编辑 / }).click();
  await second.locator("#amount").fill("99");
  await second.locator("#save-entry").click();
  await page.waitForFunction(
    () => document.getElementById("expense-total").textContent === "¥99.00",
  );
  await page.locator("#amount").fill("1");
  await page.locator("#save-entry").click();
  assert.match(await page.locator("#form-error").textContent(), /其他窗口修改/);
  assert.equal((await values(page))[0].amountCents, 9900);
  await context.close();
});

test("分页和稳定排序，边界月份禁用越界按钮", async () => {
  const seed = Array.from({ length: 13 }, (_, i) =>
    entry({ id: `r${i}`, date: `2026-10-${String(i + 1).padStart(2, "0")}` }),
  );
  const { context, page } = await openPage({}, M.makeBackup(seed));
  assert.equal(await page.locator(".transaction-row").count(), 10);
  assert.match(
    await page.locator(".transaction-meta").first().textContent(),
    /2026-10-13/,
  );
  await page.locator("#next-page").click();
  assert.equal(await page.locator(".transaction-row").count(), 3);
  assert.ok(await page.locator("#next-page").isDisabled());
  await page.locator("#month").fill("1900-01");
  await page.locator("#month").dispatchEvent("change");
  assert.ok(await page.locator("#prev-month").isDisabled());
  await page.locator("#month").fill("9999-12");
  await page.locator("#month").dispatchEvent("change");
  assert.ok(await page.locator("#next-month").isDisabled());
  await context.close();
});

test("手机宽度 320/390/768，单手新增和编辑弹窗无横向溢出", async () => {
  for (const width of [320, 390, 768]) {
    const { context, page } = await openPage({
      viewport: { width, height: 844 },
      isMobile: width < 700,
      hasTouch: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      `${width}px 页面溢出`,
    );
    if (width < 700) assert.ok(await page.locator("#add-mobile").isVisible());
    await add(page, { amount: "999999999.99", note: "移动端记账" });
    assert.equal((await values(page)).length, 1);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      `${width}px 最大金额溢出`,
    );
    await page.getByRole("button", { name: /^编辑 / }).click();
    assert.equal(
      await page
        .locator("#entry-dialog")
        .evaluate((node) => node.scrollWidth > node.clientWidth),
      false,
      `${width}px 弹窗溢出`,
    );
    await page.locator("#cancel-entry").click();
    await context.close();
  }
});

const annualEntries = [
  entry({
    id: "salary",
    date: "2026-01-01",
    type: "income",
    category: "工资",
    amountCents: 120000,
  }),
  entry({ id: "food", date: "2026-01-31", amountCents: 30000 }),
  entry({
    id: "travel",
    date: "2026-02-01",
    category: "交通",
    amountCents: 60000,
  }),
  entry({
    id: "bonus",
    date: "2026-12-31",
    type: "income",
    category: "奖金",
    amountCents: 60000,
  }),
  entry({ id: "previous", date: "2025-12-31", amountCents: 9900 }),
];
async function visitAnnual(page, year = 2026) {
  await page.evaluate(() => {
    location.hash = "#annual-report";
  });
  await page.locator("#annual-title").waitFor({ state: "visible" });
  await page.locator("#annual-year").fill(String(year));
  await page.locator("#annual-year").dispatchEvent("change");
}
async function visitMonthly(page) {
  await page.evaluate(() => {
    location.hash = "#overview";
  });
  await page.locator("#monthly-view").waitFor({ state: "visible" });
}

test("年度桌面导航、默认年份与V1数据只读兼容，保留月度筛选状态", async () => {
  const raw = M.makeBackup(annualEntries);
  const { context, page } = await openPage(
    { viewport: { width: 1440, height: 1000 } },
    raw,
  );
  await page.locator("#search").fill("午餐");
  await page.locator('.sidebar a[href="#annual-report"]').click();
  assert.ok(await page.locator("#annual-report").isVisible());
  assert.ok(await page.locator("#monthly-view").isHidden());
  assert.equal(
    await page.locator("#annual-year").inputValue(),
    await page.evaluate(() => String(new Date().getFullYear())),
  );
  await page.locator("#annual-year").fill("2025");
  await page.locator("#annual-year").dispatchEvent("change");
  assert.equal(await amountText(page, "annual-expense"), "¥99.00");
  await page.locator('.sidebar a[href="#overview"]').click();
  assert.equal(await page.locator("#month").inputValue(), "2026-10");
  assert.equal(await page.locator("#search").inputValue(), "午餐");
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), M.STORAGE_KEY),
    raw,
  );
  assert.equal(await page.evaluate(() => localStorage.length), 1);
  await context.close();
});

test("年度汇总、12个月图表、负结余、极值、分类排行及精确辅助表格", async () => {
  const { context, page } = await openPage({}, M.makeBackup(annualEntries));
  await visitAnnual(page);
  assert.equal(await amountText(page, "annual-income"), "¥1,800.00");
  assert.equal(await amountText(page, "annual-expense"), "¥900.00");
  assert.equal(await amountText(page, "annual-balance"), "¥900.00");
  assert.equal(await amountText(page, "annual-income-count"), "2");
  assert.equal(await amountText(page, "annual-expense-count"), "2");
  assert.equal(await amountText(page, "annual-average-income"), "¥150.00");
  assert.equal(await amountText(page, "annual-average-expense"), "¥75.00");
  assert.equal(
    await page.locator('#annual-flow-chart rect[data-series="income"]').count(),
    12,
  );
  assert.equal(
    await page
      .locator('#annual-flow-chart rect[data-series="expense"]')
      .count(),
    12,
  );
  assert.equal(
    await page
      .locator("#annual-balance-chart circle[data-balance-cents]")
      .count(),
    12,
  );
  const negative = Number(
    await page
      .locator('#annual-balance-chart circle[data-balance-cents="-60000"]')
      .getAttribute("cy"),
  );
  const zero = Number(
    await page
      .locator("#annual-balance-chart .chart-zero-line")
      .getAttribute("y1"),
  );
  assert.ok(negative > zero, "负结余节点必须位于零线下方");
  assert.match(await amountText(page, "annual-highest"), /1月.*¥900.00/);
  assert.match(await amountText(page, "annual-lowest"), /2月.*-¥600.00/);
  assert.equal(
    await page
      .locator("#annual-expense-ranking li")
      .first()
      .getAttribute("data-category"),
    "交通",
  );
  assert.match(
    await page.locator("#annual-expense-ranking li").first().textContent(),
    /66.7%/,
  );
  assert.equal(
    await page
      .locator("#annual-income-ranking li")
      .first()
      .getAttribute("data-category"),
    "工资",
  );
  await page.locator("#annual-table-details summary").click();
  assert.equal(await page.locator("#annual-month-table tbody tr").count(), 12);
  assert.equal(
    await page
      .locator("#annual-month-table tbody tr")
      .nth(1)
      .locator("td")
      .nth(2)
      .textContent(),
    "-¥600.00",
  );
  assert.equal(
    await page
      .locator("#annual-month-table tbody tr")
      .nth(2)
      .locator("td")
      .first()
      .textContent(),
    "¥0.00",
  );
  assert.equal(await amountText(page, "annual-table-income"), "¥1,800.00");
  assert.match(
    await page.locator("#annual-month-table caption").textContent(),
    /2026年/,
  );
  await context.close();
});

test("年度图表点选及键盘聚焦提供准确金额，SVG有无障碍标题与说明", async () => {
  const { context, page } = await openPage({}, M.makeBackup(annualEntries));
  await visitAnnual(page);
  await page.locator('#annual-flow-chart .chart-month[data-month="2"]').click();
  assert.match(
    await amountText(page, "annual-flow-readout"),
    /2026年2月.*收入 ¥0.00.*支出 ¥600.00/,
  );
  await page
    .locator('#annual-balance-chart .chart-month[data-month="2"]')
    .focus();
  await page.keyboard.press("Enter");
  assert.match(
    await amountText(page, "annual-balance-readout"),
    /2月.*-¥600.00/,
  );
  for (const id of ["annual-flow-chart", "annual-balance-chart"]) {
    assert.equal(await page.locator(`#${id} title`).first().count(), 1);
    assert.ok((await page.locator(`#${id} desc`).textContent()).length > 20);
    assert.equal(
      await page.locator(`#${id} .chart-month[tabindex="0"]`).count(),
      12,
    );
    assert.ok(await page.locator(`#${id}`).getAttribute("aria-labelledby"));
  }
  await context.close();
});

test("年度空态、只有收入与只有支出，无收入占比不会显示NaN", async () => {
  for (const seed of [
    [],
    [entry({ type: "income", category: "工资", amountCents: 1200 })],
    [entry({ amountCents: 1200 })],
  ]) {
    const { context, page } = await openPage({}, M.makeBackup(seed));
    await visitAnnual(page);
    assert.equal(
      await page.locator("#annual-empty").isVisible(),
      seed.length === 0,
    );
    assert.equal(
      await page.locator("#annual-income-empty").isVisible(),
      !seed.some((r) => r.type === "income"),
    );
    assert.equal(
      await page.locator("#annual-expense-empty").isVisible(),
      !seed.some((r) => r.type === "expense"),
    );
    assert.ok(
      !(await page.locator("#annual-report").textContent()).includes("NaN"),
    );
    if (seed[0]?.type === "expense")
      assert.equal(await amountText(page, "annual-balance"), "-¥12.00");
    if (!seed.length) {
      const amounts = await page
        .locator("#annual-flow-chart rect[data-amount-cents]")
        .evaluateAll((nodes) =>
          nodes.map((node) => Number(node.dataset.amountCents)),
        );
      assert.ok(amounts.every((amount) => amount === 0));
      assert.match(await amountText(page, "annual-highest"), /暂无收支记录/);
    }
    await context.close();
  }
});

test("年份上下切换、有效边界、错误年份回退及月度页面保持可用", async () => {
  const { context, page } = await openPage({}, M.makeBackup(annualEntries));
  await visitAnnual(page);
  await page.locator("#prev-year").click();
  assert.equal(await page.locator("#annual-year").inputValue(), "2025");
  assert.equal(await amountText(page, "annual-expense"), "¥99.00");
  await page.locator("#next-year").click();
  assert.equal(await amountText(page, "annual-expense"), "¥900.00");
  for (const bad of ["1899", "10000", "2026.5", ""]) {
    await page.locator("#annual-year").fill(bad);
    await page.locator("#annual-year").dispatchEvent("change");
    assert.equal(await page.locator("#annual-year").inputValue(), "2026");
    assert.match(await page.locator("#toast").textContent(), /1900/);
  }
  for (const year of ["1900", "9999"]) {
    await page.locator("#annual-year").fill(year);
    await page.locator("#annual-year").dispatchEvent("change");
    assert.ok(
      await page
        .locator(year === "1900" ? "#prev-year" : "#next-year")
        .isDisabled(),
    );
  }
  await page.locator("#this-year").click();
  assert.equal(
    await page.locator("#annual-year").inputValue(),
    await page.evaluate(() => String(new Date().getFullYear())),
  );
  await visitMonthly(page);
  await add(page, { amount: "1" });
  assert.equal((await values(page)).length, 6);
  await context.close();
});

test("新增、编辑类型分类及跨年日期、删除后年度报表和图表即时更新", async () => {
  const { context, page } = await openPage();
  await add(page, { amount: "0.10", note: "年度联动测试" });
  await visitAnnual(page);
  assert.equal(await amountText(page, "annual-expense"), "¥0.10");
  assert.equal(
    await page
      .locator(
        '#annual-flow-chart .chart-month[data-month="10"] rect[data-series="expense"]',
      )
      .getAttribute("data-amount-cents"),
    "10",
  );
  await visitMonthly(page);
  await page.getByRole("button", { name: /^编辑 / }).click();
  await page.locator('input[name="type"][value="income"]').check();
  await page.locator("#category").selectOption("投资");
  await page.locator("#amount").fill("2.20");
  await page.locator("#date").fill("2025-03-01");
  await page.locator("#save-entry").click();
  await visitAnnual(page);
  assert.equal(await amountText(page, "annual-expense"), "¥0.00");
  await visitAnnual(page, 2025);
  assert.equal(await amountText(page, "annual-income"), "¥2.20");
  assert.equal(
    await page
      .locator("#annual-income-ranking li")
      .first()
      .getAttribute("data-category"),
    "投资",
  );
  assert.equal(
    await page
      .locator(
        '#annual-flow-chart .chart-month[data-month="3"] rect[data-series="income"]',
      )
      .getAttribute("data-amount-cents"),
    "220",
  );
  await visitMonthly(page);
  await page.locator("#month").fill("2025-03");
  await page.locator("#month").dispatchEvent("change");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: /^删除 / }).click();
  await visitAnnual(page, 2025);
  assert.equal(await amountText(page, "annual-income"), "¥0.00");
  assert.ok(await page.locator("#annual-empty").isVisible());
  assert.equal(await page.locator("#annual-income-ranking li").count(), 0);
  await context.close();
});

test("V1备份导入后年度统计正确，年度导出仍保留原V1结构", async () => {
  const { context, page } = await openPage();
  await visitAnnual(page);
  const raw = M.makeBackup(annualEntries);
  const confirmation = await importJSON(page, raw);
  assert.match(confirmation, /5 笔/);
  assert.equal(await amountText(page, "annual-expense"), "¥900.00");
  assert.equal(await amountText(page, "annual-income"), "¥1,800.00");
  const promise = page.waitForEvent("download");
  await page.locator("#export-json").click();
  const exported = JSON.parse(
    await fs.readFile(await (await promise).path(), "utf8"),
  );
  assert.equal(exported.format, "moneynote");
  assert.equal(exported.version, 1);
  assert.deepEqual(exported.transactions, annualEntries);
  const saved = await page.evaluate(
    (key) => localStorage.getItem(key),
    M.STORAGE_KEY,
  );
  await visitAnnual(page, 2025);
  await visitAnnual(page, 2026);
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), M.STORAGE_KEY),
    saved,
  );
  await context.close();
});

test("年度报告接收多标签页同步，损坏存储不展示假零值，恢复后重新分析", async () => {
  const { context, page } = await openPage({}, M.makeBackup([entry()]));
  await visitAnnual(page);
  const second = await context.newPage();
  await second.goto(base);
  await second.evaluate(({ key, text }) => localStorage.setItem(key, text), {
    key: M.STORAGE_KEY,
    text: M.makeBackup(annualEntries),
  });
  await page.waitForFunction(
    () => document.getElementById("annual-income").textContent === "¥1,800.00",
  );
  assert.equal(await amountText(page, "annual-expense"), "¥900.00");
  await second.evaluate(
    (key) => localStorage.setItem(key, "{broken"),
    M.STORAGE_KEY,
  );
  await page.locator("#annual-unavailable").waitFor({ state: "visible" });
  assert.ok(await page.locator("#annual-report-content").isHidden());
  assert.ok(await page.locator("#storage-warning").isVisible());
  await importJSON(page, M.makeBackup(annualEntries));
  assert.ok(await page.locator("#annual-unavailable").isHidden());
  assert.equal(await amountText(page, "annual-income"), "¥1,800.00");
  await context.close();
});

test("年度320/390/768及1440像素布局、最大金额、手机导航和横向图表浏览", async () => {
  const seed = [
    entry({ amountCents: M.MAX_AMOUNT_CENTS }),
    entry({
      id: "big-income",
      type: "income",
      category: "工资",
      amountCents: M.MAX_AMOUNT_CENTS,
      date: "2026-01-01",
    }),
  ];
  for (const width of [320, 390, 768, 1440]) {
    const { context, page } = await openPage(
      {
        viewport: { width, height: 900 },
        hasTouch: width < 1000,
        isMobile: width < 700,
      },
      M.makeBackup(seed),
    );
    if (width < 700)
      await page.locator('.view-tabs a[href="#annual-report"]').click();
    else await page.locator('.sidebar a[href="#annual-report"]').click();
    await page.locator("#annual-year").fill("2026");
    await page.locator("#annual-year").dispatchEvent("change");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      `${width}px年度页面溢出`,
    );
    await page.locator("#annual-table-details summary").click();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      `${width}px数据表溢出`,
    );
    const scroller = page.locator(".svg-scroll").first();
    if (width < 700) {
      assert.ok(
        await scroller.evaluate((node) => node.scrollWidth > node.clientWidth),
      );
      await scroller.evaluate((node) => {
        node.scrollLeft = 150;
      });
      assert.ok(await scroller.evaluate((node) => node.scrollLeft > 0));
      await page.locator("#mobile-report-link").click();
      assert.ok(await page.locator("#monthly-view").isVisible());
    }
    await context.close();
  }
});

test("年度深链接与刷新不写入localStorage，不发出第三方请求或脚本错误", async () => {
  const raw = M.makeBackup(annualEntries);
  const { context, page } = await openPage({}, raw);
  const errors = [],
    requests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(base + "#annual-report");
  assert.ok(await page.locator("#annual-report").isVisible());
  await page.locator("#annual-year").fill("2025");
  await page.locator("#annual-year").dispatchEvent("change");
  await page.locator("#annual-flow-chart .chart-month").first().focus();
  await page.reload();
  assert.ok(await page.locator("#annual-report").isVisible());
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), M.STORAGE_KEY),
    raw,
  );
  assert.deepEqual(errors, []);
  assert.ok(requests.every((url) => url.startsWith(base)));
  await context.close();
});

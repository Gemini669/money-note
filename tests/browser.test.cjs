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
  await page
    .locator("#import-file")
    .setInputFiles({
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
  assert.equal(await page.title(), "小账本 MoneyNote · 把生活记清楚");
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
  assert.match(await page.locator("#storage-message").textContent(), /不会自动覆盖/);
  await context.close();
});

test("超大文件在读取前拒绝，键盘 Esc 取消新增不写入", async () => {
  const { context, page } = await openPage();
  await page.locator("#import-file").setInputFiles({
    name: "oversized.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(M.MAX_FILE_BYTES + 1, 32),
  });
  await page.waitForFunction(() => !document.getElementById("import-json").disabled);
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

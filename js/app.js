(function () {
  "use strict";
  const M = window.MoneyNote;
  const $ = (id) => document.getElementById(id);
  const PAGE_SIZE = 10;
  let records = [];
  let baselineRaw = null;
  let unreadable = false;
  let originalRaw = null;
  let editing = null;
  let page = 1;
  let toastTimer;
  let annualYear = new Date().getFullYear();
  let annualData = null;
  let annualMonth = 0;
  const annualColors = {
    income: "#269c81",
    expense: M.COLORS[0],
    negative: "#da6b65",
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function toast(message, error = false) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").classList.toggle("error", error);
    $("toast").hidden = false;
    toastTimer = setTimeout(
      () => {
        $("toast").hidden = true;
      },
      error ? 8000 : 4000,
    );
  }

  function storageFailure(message) {
    unreadable = true;
    $("storage-warning").hidden = false;
    $("storage-message").textContent = message;
    $("download-original").hidden = originalRaw === null;
    [
      "add-top",
      "add-list",
      "add-empty",
      "add-mobile",
      "export-json",
      "export-csv",
    ].forEach((id) => {
      $(id).disabled = true;
    });
  }

  function loadData() {
    records = [];
    originalRaw = null;
    unreadable = false;
    try {
      baselineRaw = localStorage.getItem(M.STORAGE_KEY);
      originalRaw = baselineRaw;
      if (baselineRaw !== null) records = M.parseBackup(baselineRaw);
      $("storage-warning").hidden = true;
      [
        "add-top",
        "add-list",
        "add-empty",
        "add-mobile",
        "export-json",
        "export-csv",
      ].forEach((id) => {
        $(id).disabled = false;
      });
    } catch (error) {
      storageFailure(
        `为保护已有账目，已暂停新增和编辑，不会自动覆盖数据。你可以下载原始数据保留副本，再导入有效备份恢复，或重新读取。原因：${error.message}`,
      );
    }
  }

  function persist(next, allowRecovery = false) {
    if (unreadable && !allowRecovery)
      throw new Error("账本读取异常，请先恢复数据。");
    const payload = M.makeBackup(next);
    try {
      if (localStorage.getItem(M.STORAGE_KEY) !== baselineRaw) {
        loadData();
        render();
        throw new Error(
          "另一个标签页已修改账本，已同步最新数据。请重新检查后操作。",
        );
      }
      localStorage.setItem(M.STORAGE_KEY, payload);
    } catch (error) {
      if (error.name === "QuotaExceededError")
        throw new Error(
          "浏览器存储空间不足，未保存这次修改。请先导出备份，释放空间后重试。",
        );
      if (error.name === "SecurityError")
        throw new Error(
          "浏览器禁止本地存储，未保存这次修改。请允许此站点存储后重试。",
        );
      throw error;
    }
    baselineRaw = payload;
    originalRaw = payload;
    records = next;
    unreadable = false;
    $("storage-warning").hidden = true;
    [
      "add-top",
      "add-list",
      "add-empty",
      "add-mobile",
      "export-json",
      "export-csv",
    ].forEach((id) => {
      $(id).disabled = false;
    });
    render();
  }

  function fillCategories() {
    const type = $("entry-form").elements.type.value;
    $("category").replaceChildren(
      ...M.CATEGORIES[type].map((category) => {
        const option = element("option", "", category);
        option.value = category;
        return option;
      }),
    );
  }

  function openEntry(item = null) {
    if (unreadable) return;
    editing = item ? { ...item } : null;
    $("entry-form").reset();
    $("entry-title").textContent = item ? "编辑账目" : "记一笔";
    $("save-entry").textContent = item ? "保存修改" : "保存账目";
    $("entry-form").elements.type.value = item ? item.type : "expense";
    fillCategories();
    const today = M.localDate();
    $("date").value = item
      ? item.date
      : today.startsWith($("month").value)
        ? today
        : `${$("month").value}-01`;
    if (item) {
      $("amount").value =
        `${Math.floor(item.amountCents / 100)}.${String(item.amountCents % 100).padStart(2, "0")}`;
      $("category").value = item.category;
      $("note").value = item.note;
    }
    $("form-error").hidden = true;
    $("entry-dialog").showModal();
    $("amount").focus();
  }

  function renderChart(summary) {
    const entries = Object.entries(summary.categories)
      .filter(([, amount]) => amount > 0)
      .sort((a, b) => b[1] - a[1]);
    $("chart-total").textContent = M.formatMoney(summary.expense);
    $("chart-empty").hidden = entries.length > 0;
    $("category-legend").replaceChildren();
    let current = 0;
    const stops = [];
    for (const [category, amount] of entries) {
      const index = M.CATEGORIES.expense.indexOf(category);
      const percent = (amount / summary.expense) * 100;
      stops.push(`${M.COLORS[index]} ${current}% ${current + percent}%`);
      current += percent;
      const row = element("li");
      const dot = element("span", "legend-dot");
      dot.style.backgroundColor = M.COLORS[index];
      dot.setAttribute("aria-hidden", "true");
      row.append(
        dot,
        element("span", "legend-name", category),
        element("span", "legend-amount", M.formatMoney(amount)),
        element("span", "legend-percent", `${percent.toFixed(1)}%`),
      );
      $("category-legend").append(row);
    }
    $("expense-chart").style.background = stops.length
      ? `conic-gradient(${stops.join(",")})`
      : "#edf2f9";
    $("expense-chart").setAttribute(
      "aria-label",
      entries.length
        ? `本月总支出 ${M.formatMoney(summary.expense)}，各类别金额和占比见下方列表`
        : "本月暂无支出",
    );
  }

  function transactionRow(item) {
    const row = element("article", "transaction-row");
    const income = item.type === "income";
    const icon = element(
      "span",
      `transaction-icon${income ? " income" : ""}`,
      income ? "↙" : "↗",
    );
    icon.setAttribute("aria-hidden", "true");
    const content = element("div", "transaction-content");
    const title = element("p", "transaction-name", item.note || item.category);
    title.title = item.note || item.category;
    content.append(
      title,
      element(
        "p",
        "transaction-meta",
        `${item.date} · ${income ? "收入" : "支出"} · ${item.category}`,
      ),
    );
    const money = element(
      "span",
      `transaction-money${income ? " income" : ""}`,
      `${income ? "+" : "−"}${M.formatMoney(item.amountCents)}`,
    );
    const actions = element("div", "transaction-actions");
    const edit = element("button", "row-button", "编辑");
    edit.type = "button";
    edit.setAttribute(
      "aria-label",
      `编辑 ${item.date} ${item.category} ${M.formatMoney(item.amountCents)}`,
    );
    edit.addEventListener("click", () => openEntry(item));
    const remove = element("button", "row-button danger", "删除");
    remove.type = "button";
    remove.setAttribute(
      "aria-label",
      `删除 ${item.date} ${item.category} ${M.formatMoney(item.amountCents)}`,
    );
    remove.addEventListener("click", () => {
      if (
        !window.confirm(
          `确定删除这笔账目？\n${item.date} · ${item.category} · ${M.formatMoney(item.amountCents)}\n删除后无法撤销，请先确认已有备份。`,
        )
      )
        return;
      try {
        persist(records.filter((record) => record.id !== item.id));
        toast("账目已删除");
      } catch (error) {
        toast(error.message, true);
      }
    });
    actions.append(edit, remove);
    row.append(icon, content, money, actions);
    return row;
  }

  function renderList() {
    const keyword = $("search").value;
    const category = $("category-filter").value;
    const filtered = M.filterRecords(records, {
      month: $("month").value,
      keyword,
      category,
    });
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.min(page, pages);
    $("transaction-count").textContent = `${filtered.length} 笔`;
    $("clear-filters").hidden = !keyword && !category;
    $("filter-note").textContent =
      keyword || category
        ? `筛选到 ${filtered.length} 笔 · 按日期从近到远排列 · 上方统计仍为整月收支`
        : "按日期从近到远排列";
    $("transaction-list").replaceChildren(
      ...filtered
        .slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
        .map(transactionRow),
    );
    $("list-empty").hidden = filtered.length > 0;
    const isInitial = records.length === 0 && !unreadable;
    $("empty-title").textContent = unreadable
      ? "账本需要恢复"
      : isInitial
        ? "新的账本，新的开始"
        : "这里还没有记录";
    $("empty-description").textContent = unreadable
      ? "请查看上方提示，已有数据不会被自动覆盖。"
      : isInitial
        ? "从一杯咖啡、一份工资开始，记下你的第一笔。"
        : "试试其他月份或清除筛选，也可以在这个月记一笔。";
    $("add-empty").textContent = isInitial ? "＋ 记下第一笔" : "＋ 记一笔";
    $("pagination").hidden = pages <= 1;
    $("prev-page").disabled = page <= 1;
    $("next-page").disabled = page >= pages;
    $("page-label").textContent = `第 ${page} / ${pages} 页`;
  }

  function svgElement(tag, attributes = {}, text) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attributes))
      node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svgDescription(svg, prefix, title, description) {
    svg.replaceChildren(
      svgElement("title", { id: `${prefix}-title` }, title),
      svgElement("desc", { id: `${prefix}-desc` }, description),
    );
  }

  function axisLabel(cents) {
    const amount = Math.abs(cents);
    const unit =
      amount >= 10000000000 ? 10000000000 : amount >= 1000000 ? 1000000 : 100;
    const suffix = unit === 10000000000 ? "亿" : unit === 1000000 ? "万" : "";
    return `${cents < 0 ? "−" : ""}¥${(amount / unit).toLocaleString("zh-CN", { maximumFractionDigits: unit === 100 ? 2 : 1 })}${suffix}`;
  }

  function chartGrid(svg, limit, symmetric = false) {
    const plot = { left: 96, right: 784, top: 25, bottom: 238 };
    plot.width = plot.right - plot.left;
    const minimum = symmetric ? -limit : 0;
    plot.y = (value) =>
      plot.bottom -
      ((value - minimum) / (limit - minimum)) * (plot.bottom - plot.top);
    svg.append(
      svgElement(
        "text",
        { x: 12, y: 14, class: "chart-axis-label" },
        "金额（元）",
      ),
    );
    for (let index = 0; index <= 4; index++) {
      const value = limit - ((limit - minimum) * index) / 4;
      const y = plot.y(value);
      svg.append(
        svgElement("line", {
          x1: plot.left,
          x2: plot.right,
          y1: y,
          y2: y,
          class: value === 0 ? "chart-zero-line" : "chart-grid-line",
          "data-value": value,
        }),
      );
      svg.append(
        svgElement(
          "text",
          {
            x: plot.left - 12,
            y: y + 4,
            "text-anchor": "end",
            class: "chart-axis-label",
          },
          axisLabel(value),
        ),
      );
    }
    return plot;
  }

  function annualMonthGroup(month, index, plot) {
    const slot = plot.width / 12;
    const x = plot.left + slot * (index + 0.5);
    const label = `${month.month}月，收入 ${M.formatMoney(month.income)}，支出 ${M.formatMoney(month.expense)}，结余 ${M.formatMoney(month.balance)}`;
    const group = svgElement("g", {
      class: "chart-month",
      tabindex: 0,
      role: "button",
      "data-month": month.month,
      "aria-label": `查看${label}`,
    });
    group.append(
      svgElement("title", {}, label),
      svgElement("rect", {
        x: x - slot / 2 + 2,
        y: plot.top - 5,
        width: slot - 4,
        height: plot.bottom - plot.top + 40,
        rx: 6,
        fill: "transparent",
        class: "chart-hit-area",
      }),
    );
    group.append(
      svgElement(
        "text",
        { x, y: 263, "text-anchor": "middle", class: "chart-axis-label" },
        `${month.month}月`,
      ),
    );
    const select = () => {
      annualMonth = index;
      renderAnnualReadout();
    };
    group.addEventListener("click", select);
    group.addEventListener("focus", select);
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select();
      }
    });
    return { group, x };
  }

  function renderAnnualCharts(data) {
    const flow = $("annual-flow-chart");
    const balance = $("annual-balance-chart");
    svgDescription(
      flow,
      "annual-flow-svg",
      `${data.year}年每月收入与支出`,
      "横轴1月至12月，纵轴人民币金额。绿色为收入，蓝色为支出。无记录月份为零。点选或聚焦月份可查看精确金额，下方提供完整数值表格。",
    );
    svgDescription(
      balance,
      "annual-balance-svg",
      `${data.year}年月度结余`,
      "结余为收入减去支出。蓝点为非负结余，红点为负结余，粗线表示零值。最高和最低月份列于图后，精确金额见下方表格。",
    );
    const flowLimit = Math.max(
      100,
      Math.ceil(
        Math.max(
          ...data.months.flatMap((month) => [month.income, month.expense]),
        ) / 4,
      ) * 4,
    );
    const flowPlot = chartGrid(flow, flowLimit);
    for (const [index, month] of data.months.entries()) {
      const { group, x } = annualMonthGroup(month, index, flowPlot);
      for (const [type, offset] of [
        ["income", -18],
        ["expense", 2],
      ]) {
        const y = flowPlot.y(month[type]);
        group.append(
          svgElement("rect", {
            x: x + offset,
            y,
            width: 16,
            height: Math.max(0, flowPlot.bottom - y),
            rx: 3,
            fill: annualColors[type],
            "data-series": type,
            "data-amount-cents": month[type],
          }),
        );
      }
      flow.append(group);
    }
    const balanceLimit = Math.max(
      100,
      Math.ceil(
        Math.max(...data.months.map((month) => Math.abs(month.balance))) / 4,
      ) * 4,
    );
    const balancePlot = chartGrid(balance, balanceLimit, true);
    const points = data.months
      .map(
        (month, index) =>
          `${balancePlot.left + (balancePlot.width / 12) * (index + 0.5)},${balancePlot.y(month.balance)}`,
      )
      .join(" ");
    balance.append(
      svgElement("polyline", {
        points,
        fill: "none",
        stroke: annualColors.expense,
        "stroke-width": 2.5,
        "stroke-linejoin": "round",
        "aria-hidden": "true",
      }),
    );
    for (const [index, month] of data.months.entries()) {
      const { group, x } = annualMonthGroup(month, index, balancePlot);
      group.append(
        svgElement("circle", {
          cx: x,
          cy: balancePlot.y(month.balance),
          r: 5,
          fill:
            month.balance < 0 ? annualColors.negative : annualColors.expense,
          stroke: "white",
          "stroke-width": 2,
          "data-balance-cents": month.balance,
        }),
      );
      balance.append(group);
    }
    renderAnnualReadout();
  }

  function renderAnnualReadout() {
    if (!annualData) return;
    const month = annualData.months[annualMonth];
    $("annual-flow-readout").textContent =
      `${annualData.year}年${month.month}月 · 收入 ${M.formatMoney(month.income)}（${month.incomeCount} 笔） · 支出 ${M.formatMoney(month.expense)}（${month.expenseCount} 笔）`;
    $("annual-balance-readout").textContent =
      `${annualData.year}年${month.month}月 · 结余 ${M.formatMoney(month.balance)}`;
    document.querySelectorAll(".chart-month").forEach((group) => {
      const selected = Number(group.dataset.month) === month.month;
      group.classList.toggle("selected", selected);
      group.setAttribute("aria-pressed", String(selected));
    });
  }

  function renderAnnualRanking(type, categories) {
    const visible = categories.filter((category) => category.amountCents > 0);
    const list = $(`annual-${type}-ranking`);
    $(`annual-${type}-empty`).hidden = visible.length > 0;
    list.replaceChildren(
      ...visible.map((category, index) => {
        const row = element("li");
        row.dataset.category = category.category;
        row.dataset.amountCents = category.amountCents;
        const heading = element("div", "annual-rank-heading");
        heading.append(
          element(
            "span",
            "annual-rank-name",
            `${index + 1}. ${category.category}`,
          ),
          element("strong", "", M.formatMoney(category.amountCents)),
        );
        const percent = category.share * 100;
        const share = percent < 0.1 ? "<0.1%" : `${percent.toFixed(1)}%`;
        const info = element("div", "annual-rank-info");
        info.append(
          element("span", "", `${category.count} 笔`),
          element("span", "", `占比 ${share}`),
        );
        const track = element("div", "annual-rank-track");
        track.setAttribute("aria-hidden", "true");
        const bar = element("span");
        bar.style.width = `${percent}%`;
        bar.style.backgroundColor =
          M.COLORS[M.CATEGORIES[type].indexOf(category.category)];
        track.append(bar);
        row.append(heading, info, track);
        return row;
      }),
    );
  }

  function renderAnnual() {
    $("annual-unavailable").hidden = !unreadable;
    $("annual-report-content").hidden = unreadable;
    $("prev-year").disabled = annualYear <= 1900;
    $("next-year").disabled = annualYear >= 9999;
    $("annual-range").textContent = `${annualYear}.01.01 — ${annualYear}.12.31`;
    if (unreadable) {
      annualData = null;
      return;
    }
    const data = M.summarizeYear(records, annualYear);
    annualData = data;
    $("annual-empty").hidden = data.count > 0;
    for (const [id, key] of [
      ["income", "income"],
      ["expense", "expense"],
      ["balance", "balance"],
      ["average-income", "averageIncome"],
      ["average-expense", "averageExpense"],
    ]) {
      $(`annual-${id}`).textContent = M.formatMoney(data[key]);
    }
    $("annual-income-count").textContent = data.incomeCount;
    $("annual-expense-count").textContent = data.expenseCount;
    const monthNames = (months) =>
      months.length === 12
        ? "1–12月（并列）"
        : `${months.join("、")}月${months.length > 1 ? "（并列）" : ""}`;
    $("annual-highest").textContent = data.count
      ? `最高结余：${monthNames(data.highestMonths)} · ${M.formatMoney(data.highestBalance)}`
      : "最高结余：暂无收支记录";
    $("annual-lowest").textContent = data.count
      ? `最低结余：${monthNames(data.lowestMonths)} · ${M.formatMoney(data.lowestBalance)}`
      : "最低结余：暂无收支记录";
    $("annual-month-table")
      .querySelector("tbody")
      .replaceChildren(
        ...data.months.map((month) => {
          const row = element("tr");
          const heading = element("th", "", `${month.month}月`);
          heading.scope = "row";
          row.append(
            heading,
            ...[month.income, month.expense, month.balance].map((amount) =>
              element("td", "", M.formatMoney(amount)),
            ),
            element("td", "", month.incomeCount),
            element("td", "", month.expenseCount),
          );
          return row;
        }),
      );
    $("annual-table-caption").textContent =
      `${annualYear}年每月收支与笔数（单位：人民币元）`;
    for (const key of ["income", "expense", "balance"])
      $(`annual-table-${key}`).textContent = M.formatMoney(data[key]);
    $("annual-table-income-count").textContent = data.incomeCount;
    $("annual-table-expense-count").textContent = data.expenseCount;
    renderAnnualCharts(data);
    renderAnnualRanking("expense", data.expenseCategories);
    renderAnnualRanking("income", data.incomeCategories);
  }

  function changeYear(value) {
    try {
      M.filterByYear([], value);
      annualYear = Number(value);
      $("annual-year").value = annualYear;
      renderAnnual();
    } catch (error) {
      $("annual-year").value = annualYear;
      toast(error.message, true);
    }
  }

  function showView() {
    const annual = location.hash === "#annual-report";
    $("monthly-view").hidden = annual;
    $("annual-report").hidden = !annual;
    document
      .querySelectorAll(".sidebar a.nav-item, .view-tabs a")
      .forEach((link) => {
        const href = link.getAttribute("href");
        const active = annual
          ? href === "#annual-report"
          : href ===
            (location.hash === "#transactions" && !link.closest(".view-tabs")
              ? "#transactions"
              : "#overview");
        link.classList.toggle("active", active);
        if (active) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      });
    $("mobile-report-link").href = annual ? "#overview" : "#annual-report";
    $("mobile-report-link").textContent = annual ? "← 返回账本" : "年度报告 ↗";
    if (annual) renderAnnual();
  }

  function render() {
    const month = $("month").value;
    const summary = M.summarize(records, month);
    $("income-total").textContent = M.formatMoney(summary.income);
    $("expense-total").textContent = M.formatMoney(summary.expense);
    $("balance-total").textContent = M.formatMoney(summary.balance);
    $("month-caption").textContent =
      `${Number(month.slice(0, 4))} 年 ${Number(month.slice(5))} 月 · ${summary.count} 笔记录`;
    $("prev-month").disabled = month === "1900-01";
    $("next-month").disabled = month === "9999-12";
    renderChart(summary);
    renderList();
    renderAnnual();
  }

  function shiftMonth(offset) {
    const [year, month] = $("month").value.split("-").map(Number);
    const total = year * 12 + month - 1 + offset;
    if (total < 1900 * 12 || total > 9999 * 12 + 11) return;
    $("month").value =
      `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
    page = 1;
    render();
  }

  function download(content, filename, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = element("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // 下拉分类明确区分收入“其他”和支出“其他”。
  for (const [type, categories] of Object.entries(M.CATEGORIES)) {
    const group = element("optgroup");
    group.label = type === "income" ? "收入" : "支出";
    for (const category of categories) {
      const option = element("option", "", `${category} · ${group.label}`);
      option.value = `${type}:${category}`;
      group.append(option);
    }
    $("category-filter").append(group);
  }

  $("month").value = M.localDate().slice(0, 7);
  $("annual-year").value = annualYear;
  loadData();
  render();
  showView();
  window.addEventListener("hashchange", () => {
    showView();
    const target =
      location.hash === "#annual-report"
        ? $("annual-title")
        : location.hash === "#transactions"
          ? $("transactions")
          : $("overview");
    target.scrollIntoView({ block: "start" });
    if (location.hash === "#annual-report")
      target.focus({ preventScroll: true });
  });
  $("annual-year").addEventListener("change", () =>
    changeYear($("annual-year").value),
  );
  $("prev-year").addEventListener("click", () => changeYear(annualYear - 1));
  $("next-year").addEventListener("click", () => changeYear(annualYear + 1));
  $("this-year").addEventListener("click", () =>
    changeYear(new Date().getFullYear()),
  );
  ["add-top", "add-list", "add-empty", "add-mobile"].forEach((id) =>
    $(id).addEventListener("click", () => openEntry()),
  );
  ["close-dialog", "cancel-entry"].forEach((id) =>
    $(id).addEventListener("click", () => $("entry-dialog").close()),
  );
  $("entry-form").elements.type.forEach((radio) =>
    radio.addEventListener("change", fillCategories),
  );
  $("entry-form").addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const amountCents = M.parseAmount($("amount").value);
      if (!M.validDate($("date").value))
        throw new Error("请选择有效日期（1900 年至 9999 年）。");
      if ($("note").value.length > 200)
        throw new Error("备注不能超过 200 字。");
      if (editing) {
        const latest = records.find((item) => item.id === editing.id);
        if (!latest || JSON.stringify(latest) !== JSON.stringify(editing))
          throw new Error(
            "这笔账目已在其他窗口修改或删除，请关闭窗口后重新编辑。",
          );
      }
      const timestamp = new Date(
        Math.max(Date.now(), editing ? Date.parse(editing.createdAt) : 0),
      ).toISOString();
      const record = {
        id: editing
          ? editing.id
          : typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now().toString(36)}-${Array.from(crypto.getRandomValues(new Uint32Array(3)), (n) => n.toString(36)).join("-")}`,
        date: $("date").value,
        type: $("entry-form").elements.type.value,
        amountCents,
        category: $("category").value,
        note: $("note").value.trim(),
        createdAt: editing ? editing.createdAt : timestamp,
        updatedAt: timestamp,
      };
      const next = editing
        ? records.map((item) => (item.id === editing.id ? record : item))
        : [...records, record];
      persist(next);
      $("entry-dialog").close();
      toast(editing ? "账目已更新" : "已记下这笔账目");
    } catch (error) {
      $("form-error").textContent = error.message;
      $("form-error").hidden = false;
    }
  });
  $("prev-month").addEventListener("click", () => shiftMonth(-1));
  $("next-month").addEventListener("click", () => shiftMonth(1));
  $("this-month").addEventListener("click", () => {
    $("month").value = M.localDate().slice(0, 7);
    page = 1;
    render();
  });
  $("month").addEventListener("change", () => {
    if (
      !/^\d{4}-\d{2}$/.test($("month").value) ||
      !M.validDate(`${$("month").value}-01`)
    ) {
      $("month").value = M.localDate().slice(0, 7);
      toast("请选择 1900 年至 9999 年之间的月份", true);
    }
    page = 1;
    render();
  });
  ["search", "category-filter"].forEach((id) =>
    $(id).addEventListener(id === "search" ? "input" : "change", () => {
      page = 1;
      renderList();
    }),
  );
  $("clear-filters").addEventListener("click", () => {
    $("search").value = "";
    $("category-filter").value = "";
    page = 1;
    renderList();
  });
  $("prev-page").addEventListener("click", () => {
    page--;
    renderList();
  });
  $("next-page").addEventListener("click", () => {
    page++;
    renderList();
  });
  $("backup-help").addEventListener("click", () => {
    $("data-tools").scrollIntoView({ block: "center" });
    $("export-json").focus({ preventScroll: true });
  });
  $("export-json").addEventListener("click", () => {
    if (unreadable) return;
    download(
      M.makeBackup(records),
      `MoneyNote-备份-${M.localDate()}.json`,
      "application/json;charset=utf-8",
    );
    toast(`已导出全部 ${records.length} 笔账目的 JSON 备份，请妥善保管`);
  });
  $("export-csv").addEventListener("click", () => {
    if (unreadable) return;
    download(
      M.toCSV(records),
      `MoneyNote-账目-${M.localDate()}.csv`,
      "text/csv;charset=utf-8",
    );
    toast(`已导出全部 ${records.length} 笔账目（CSV）`);
  });
  $("import-json").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", async () => {
    const file = $("import-file").files[0];
    if (!file) return;
    $("import-json").disabled = true;
    try {
      if (file.size > M.MAX_FILE_BYTES)
        throw new Error("备份文件不能超过 10 MB。");
      const imported = M.parseBackup(await file.text());
      const summary = M.summarize(imported);
      const message = `已通过完整校验：${imported.length} 笔账目。\n全部收入 ${M.formatMoney(summary.income)}，支出 ${M.formatMoney(summary.expense)}。\n\n将替换当前${unreadable ? "无法读取的" : ` ${records.length} 笔`}账目，不能撤销。建议先导出当前数据。\n确认导入恢复吗？`;
      if (!window.confirm(message)) return;
      persist(imported, true);
      $("search").value = "";
      $("category-filter").value = "";
      page = 1;
      if (imported.length)
        $("month").value = M.filterRecords(imported)[0].date.slice(0, 7);
      render();
      toast(`已恢复 ${imported.length} 笔账目`);
    } catch (error) {
      toast(`导入未完成：${error.message} 原有账目未被此导入覆盖。`, true);
    } finally {
      $("import-file").value = "";
      $("import-json").disabled = false;
    }
  });
  $("download-original").addEventListener("click", () => {
    if (originalRaw !== null)
      download(
        originalRaw,
        `MoneyNote-原始数据-${M.localDate()}.txt`,
        "text/plain;charset=utf-8",
      );
  });
  $("reload-data").addEventListener("click", () => {
    loadData();
    render();
    if (!unreadable) toast("账本已重新读取");
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== M.STORAGE_KEY && event.key !== null) return;
    loadData();
    render();
    if ($("entry-dialog").open) {
      $("form-error").textContent =
        "其他标签页已更新账本。正在编辑的账目如有变化，将阻止保存，请重新打开后编辑。";
      $("form-error").hidden = false;
    }
    toast("已同步此浏览器其他标签页的账目");
  });
})();

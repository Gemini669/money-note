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
  loadData();
  render();
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

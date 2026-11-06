(function () {
  "use strict";
  var bridge = window.powerinfo;
  var content = document.getElementById("content");
  var toast = document.getElementById("toast");
  var pollTimer = null;
  var batteryNode = "/sys/class/power_supply/battery";

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toast.classList.add("hidden"); }, 2200);
  }

  /* ---------- Unit conversion + formatting (front end owns ALL of it) ---------- */

  function toFixed(v, digits) {
    var n = parseFloat(v);
    if (isNaN(n)) return "--";
    return n.toFixed(digits);
  }

  // temp: adaptive unit. Different kernels use different scales:
  //   - milli-degrees C (0.01℃): e.g. 2650 -> 26.5℃   (user's example)
  //   - tenths of a degree (0.1℃): e.g. 310 -> 31.0℃   (Note7 Pro kernel, matches dumpsys battery)
  //   - plain degrees C: e.g. 26 -> 26.0℃
  // A real battery temperature is within roughly -20..80℃, so:
  //   |raw| >= 1000  -> milli-degrees (divide by 100)
  //   |raw| >= 100   -> tenths (divide by 10)
  //   otherwise      -> degrees (as-is)
  function fmtTemp(raw) {
    var n = parseFloat(raw);
    if (isNaN(n)) return "--";
    var abs = Math.abs(n);
    var deg;
    if (abs >= 1000) deg = n / 100;
    else if (abs >= 100) deg = n / 10;
    else deg = n;
    return deg.toFixed(1) + "℃";
  }
  // capacity: integer %
  function fmtCapacity(raw) { var n = parseFloat(raw); if (isNaN(n)) return "--"; return Math.round(n) + "%"; }
  // Determine the sign that matches the battery status, regardless of the kernel's
  // current_now sign convention. Discharging -> negative (battery is supplying power),
  // Charging/Full -> positive. This keeps the displayed sign intuitive.
  function signedVal(raw, status) {
    var n = parseFloat(raw);
    if (isNaN(n)) return NaN;
    var st = String(status || "");
    if (st === "Discharging") {
      return -Math.abs(n);
    }
    if (st === "Charging" || st === "Full") {
      return Math.abs(n);
    }
    return n; // Unknown status: trust the kernel's sign as-is
  }
  // current_now uA -> mA, 1 decimal (sign follows battery status)
  function fmtCurrentMa(raw, status) {
    var n = signedVal(raw, status);
    if (isNaN(n)) return "--";
    return (n / 1000).toFixed(1) + "mA";
  }
  // A magnitude (max) current: always show the absolute value, no sign.
  function fmtCurrentAbsMa(raw) {
    var n = parseFloat(raw);
    if (isNaN(n)) return "--";
    return (Math.abs(n) / 1000).toFixed(1) + "mA";
  }
  // voltage_now / voltage_max uV -> V, 3 decimals
  function fmtVoltage(raw) { var n = parseFloat(raw); if (isNaN(n)) return "--"; return (n / 1e6).toFixed(3) + "V"; }
  // charge_full / design uAh -> mAh, integer
  function fmtMah(raw) { var n = parseFloat(raw); if (isNaN(n)) return "--"; return Math.round(n / 1000) + "mAh"; }
  // life % = charge_full / charge_full_design * 100, integer
  function fmtLife(full, design) {
    var f = parseFloat(full), d = parseFloat(design);
    if (isNaN(f) || isNaN(d) || d === 0) return "--";
    return Math.round(f / d * 100) + "%";
  }
  // power W = current_now(uA) * voltage_now(uV) / 1e12, 3 decimals (sign follows status)
  function fmtPower(curRaw, voltRaw, status) {
    var c = signedVal(curRaw, status), v = parseFloat(voltRaw);
    if (isNaN(c) || isNaN(v)) return "--";
    return (c * v / 1e12).toFixed(3) + "W";
  }
  // health map: Good -> 良好
  function fmtHealth(raw) {
    if (!raw) return "--";
    var map = {
      "Good": "良好", "Overheat": "过热", "Cold": "过冷",
      "Dead": "失效", "Over voltage": "过压", "Unspecified failure": "未知故障"
    };
    return map[raw] || raw;
  }
  // online: 0/1 -> 未连接/已连接 (user: default 未连接, 1=已连接)
  function fmtOnline(raw) {
    if (raw === "" || raw === null || raw === undefined) return "--";
    var n = parseInt(raw, 10);
    if (isNaN(n)) return "--";
    return n ? "已连接" : "未连接";
  }
  // fastcharge_mode: 0/1 -> 慢速充电/快速充电 (user: default 慢速, 1=快速)
  function fmtFastcharge(raw) {
    if (raw === "" || raw === null || raw === undefined) return "慢速充电";
    var n = parseInt(raw, 10);
    if (isNaN(n)) return "--";
    return n ? "快速充电" : "慢速充电";
  }
  // battery status map: Discharging -> 未充电 (user asked). Others mapped too.
  function fmtStatus(raw) {
    if (!raw) return "--";
    var map = {
      "Discharging": "未充电", "Charging": "充电中",
      "Full": "已充满", "Not charging": "未充电",
      "Unknown": "未知"
    };
    return map[raw] || raw;
  }
  // generic: show raw value as-is for unknown fields ("有些不知道是什么的值 也先显示出来")
  function fmtRaw(raw) {
    if (raw === "" || raw === null || raw === undefined) return "--";
    return String(raw);
  }

  /* ---------- Rendering ---------- */

  function renderError(msg) {
    content.innerHTML = "";
    var box = el("div", "error-box", msg);
    content.appendChild(box);
    var retry = el("button", "btn", "重试");
    retry.style.marginTop = "8px";
    retry.onclick = function () { load(); };
    content.appendChild(retry);
  }

  function renderLoading(text) {
    content.innerHTML = "";
    var wrap = el("div", "loading");
    wrap.appendChild(el("div", "spinner"));
    wrap.appendChild(el("div", "loading-text", text));
    content.appendChild(wrap);
  }

  function row(label, value, key) {
    var r = el("div", "row");
    if (key) r.setAttribute("data-key", key);
    r.appendChild(el("div", "row-label", label));
    r.appendChild(el("div", "row-value", value));
    return r;
  }

  // Build the battery card DOM once. Values are filled by updateBattery().
  function buildBatteryCard() {
    var card = el("div", "card");
    card.setAttribute("data-card", "battery");

    var head = el("div", "card-head");
    var ht = el("div", "card-head-title");
    ht.appendChild(el("span", "dot"));
    ht.appendChild(el("span", null, "电池信息"));
    head.appendChild(ht);
    card.appendChild(head);

    // Main (always visible)
    card.appendChild(row("电池温度", "--"));
    card.appendChild(row("当前电量", "--"));
    card.appendChild(row("电池功率", "--"));
    card.appendChild(row("电池状态", "--"));

    // More (collapsed by default)
    var moreToggle = el("div", "more-toggle");
    moreToggle.appendChild(el("span", null, "更多"));
    moreToggle.appendChild(el("span", "arrow", "\u25BE"));
    card.appendChild(moreToggle);

    var more = el("div", "more-body");
    more.appendChild(row("技术", "--"));
    more.appendChild(row("健康", "--"));
    more.appendChild(row("电池电压", "--"));
    more.appendChild(row("设计容量", "--"));
    more.appendChild(row("最大容量", "--"));
    more.appendChild(row("剩余寿命", "--"));
    more.appendChild(row("充电循环次数", "--"));
    more.appendChild(row("最大电压", "--"));
    more.appendChild(row("电池电流", "--"));
    card.appendChild(more);

    moreToggle.onclick = function () {
      var open = more.classList.toggle("open");
      moreToggle.classList.toggle("open", open);
    };

    return card;
  }

  // Build a label->value map for rows ONLY inside the given card (data-card).
  // Prefers data-key when present (disambiguates duplicate labels like "快充类型").
  function rowMap(card) {
    var rows = card.querySelectorAll(".row");
    var map = {};
    for (var i = 0; i < rows.length; i++) {
      var label = rows[i].querySelector(".row-label");
      var value = rows[i].querySelector(".row-value");
      if (label && value) {
        var k = rows[i].getAttribute("data-key") || label.textContent;
        map[k] = value;
      }
    }
    return map;
  }

  // Update the values of an existing battery card in place (no DOM rebuild).
  // "更多" expand state is preserved because we never touch the toggle/more elements.
  function updateBattery(b) {
    var card = content.querySelector('.card[data-card="battery"]');
    if (!card) return;
    var map = rowMap(card);
    function set(label, text) {
      var v = map[label];
      if (v) v.textContent = text;
    }
    set("电池温度", fmtTemp(b.temp));
    set("当前电量", fmtCapacity(b.capacity));
    set("电池功率", fmtPower(b.current_now, b.voltage_now, b.status));
    set("电池状态", fmtStatus(b.status));
    set("技术", b.technology || "--");
    set("健康", fmtHealth(b.health));
    set("电池电压", fmtVoltage(b.voltage_now));
    set("设计容量", fmtMah(b.charge_full_design));
    set("最大容量", fmtMah(b.charge_full));
    set("剩余寿命", fmtLife(b.charge_full, b.charge_full_design));
    set("充电循环次数", b.cycle_count || "--");
    set("最大电压", fmtVoltage(b.voltage_max));
    set("电池电流", fmtCurrentMa(b.current_now, b.status));
  }

  /* ---------- Charging (usb) card ---------- */

  // Build the charging card DOM once. Values are filled by updateCharging().
  function buildChargingCard() {
    var card = el("div", "card");
    card.setAttribute("data-card", "charging");

    var head = el("div", "card-head");
    var ht = el("div", "card-head-title");
    ht.appendChild(el("span", "dot"));
    ht.appendChild(el("span", null, "充电信息"));
    head.appendChild(ht);
    card.appendChild(head);

    // Main (always visible)
    card.appendChild(row("连接状态", "--", "online"));
    card.appendChild(row("是否快充", "--", "fastcharge_mode"));
    card.appendChild(row("高压快充类型", "--", "quick_charge_type"));
    card.appendChild(row("协议类型", "--", "real_type"));
    card.appendChild(row("充电电压", "--", "voltage_now"));
    card.appendChild(row("充电电流", "--", "input_current_now"));
    card.appendChild(row("充电功率", "--", "power"));

    // More (collapsed by default)
    var moreToggle = el("div", "more-toggle");
    moreToggle.appendChild(el("span", null, "更多"));
    moreToggle.appendChild(el("span", "arrow", "\u25BE"));
    card.appendChild(moreToggle);

    var more = el("div", "more-body");
    more.appendChild(row("最大电压", "--", "voltage_max"));
    more.appendChild(row("最大设计电压", "--", "voltage_max_design"));
    more.appendChild(row("最大电流", "--", "current_max"));
    more.appendChild(row("PD 激活", "--", "pd_active"));
    more.appendChild(row("PD 认证", "--", "pd_authentication"));
    more.appendChild(row("PD 最大电流", "--", "pd_current_max"));
    more.appendChild(row("PD 最大电压", "--", "pd_voltage_max"));
    more.appendChild(row("PD 最小电压", "--", "pd_voltage_min"));
    more.appendChild(row("QC 激活", "--", "hvdcp3_type"));
    card.appendChild(more);

    moreToggle.onclick = function () {
      var open = more.classList.toggle("open");
      moreToggle.classList.toggle("open", open);
    };

    return card;
  }

  // Update charging card values in place (no DOM rebuild).
  function updateCharging(u) {
    var card = content.querySelector('.card[data-card="charging"]');
    if (!card) return;
    var map = rowMap(card);
    function set(key, text) {
      var v = map[key];
      if (v) v.textContent = text;
    }
    set("online", fmtOnline(u.online));
    set("fastcharge_mode", fmtFastcharge(u.fastcharge_mode));
    set("quick_charge_type", fmtRaw(u.quick_charge_type));
    set("real_type", fmtRaw(u.real_type));
    set("voltage_now", fmtVoltage(u.voltage_now));
    set("input_current_now", fmtCurrentMa(u.input_current_now));
    set("power", fmtPower(u.input_current_now, u.voltage_now));
    set("voltage_max", fmtVoltage(u.voltage_max));
    set("voltage_max_design", fmtVoltage(u.voltage_max_design));
    set("current_max", fmtCurrentAbsMa(u.current_max));
    set("pd_active", fmtRaw(u.pd_active));
    set("pd_authentication", fmtRaw(u.pd_authentication));
    set("pd_current_max", fmtCurrentAbsMa(u.pd_current_max));
    set("pd_voltage_max", fmtVoltage(u.pd_voltage_max));
    set("pd_voltage_min", fmtVoltage(u.pd_voltage_min));
    set("hvdcp3_type", fmtRaw(u.hvdcp3_type));

    // PD 激活=0 → hide "PD 激活" row AND all pd_* rows (user: "只有pd激活>0的时候才显示pd_开头的行")
    var pdOn = parseInt(u.pd_active, 10) > 0;
    var pdKeys = ["pd_active", "pd_authentication", "pd_current_max", "pd_voltage_max", "pd_voltage_min"];
    for (var i = 0; i < pdKeys.length; i++) {
      var rowEl = card.querySelector('.row[data-key="' + pdKeys[i] + '"]');
      if (rowEl) rowEl.style.display = pdOn ? "" : "none";
    }

    // QC 激活=0 → hide the QC 激活 row (user: "hvdcp3_type 为0时候隐藏 类似pd")
    var qcRow = card.querySelector('.row[data-key="hvdcp3_type"]');
    if (qcRow) qcRow.style.display = (parseInt(u.hvdcp3_type, 10) === 0 || u.hvdcp3_type === "" || u.hvdcp3_type === null || u.hvdcp3_type === undefined) ? "none" : "";
  }

  // First render: build both cards once (side by side), then populate.
  function renderBattery(b, u) {
    content.innerHTML = "";
    var rowWrap = el("div", "cards-row");
    rowWrap.appendChild(buildBatteryCard());
    rowWrap.appendChild(buildChargingCard());
    content.appendChild(rowWrap);
    updateBattery(b);
    updateCharging(u || {});
  }

  // Subsequent updates: update in place — no rebuild, no flicker.
  function applyToDom(b, u) {
    var cards = content.querySelectorAll(".card");
    if (cards.length < 2) {
      renderBattery(b, u);
      return;
    }
    updateBattery(b);
    updateCharging(u || {});
  }

  /* ---------- Loading ---------- */

  var hasRendered = false;

  function load() {
    // Only show the loading spinner on the very first load. During polling we
    // update in place so the UI never flickers.
    if (!hasRendered) renderLoading("正在读取电池信息…");
    var result;
    try {
      result = JSON.parse(bridge.readRaw());
    } catch (e) {
      if (!hasRendered) renderError("读取失败: " + e);
      return;
    }
    if (!result.ok) {
      if (!hasRendered) renderError(result.error || "读取失败");
      return;
    }
    hasRendered = true;
    applyToDom(result.battery || {}, result.usb || {});
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(load, 3000);
  }

  /* ---------- Menu / settings / about wiring ---------- */

  var dropdown = document.getElementById("dropdown");
  document.getElementById("btn-menu").onclick = function (e) {
    e.stopPropagation();
    dropdown.classList.toggle("hidden");
  };
  document.addEventListener("click", function () {
    dropdown.classList.add("hidden");
  });

  // Settings
  var settingsOverlay = document.getElementById("settings-overlay");
  var inputSu = document.getElementById("input-su");

  function openSettings() {
    var cfg = JSON.parse(bridge.getConfig());
    inputSu.value = cfg.suCmd || "";
    settingsOverlay.classList.remove("hidden");
  }

  document.getElementById("item-settings").onclick = function () {
    dropdown.classList.add("hidden");
    openSettings();
  };
  document.getElementById("btn-back-settings").onclick = function () {
    settingsOverlay.classList.add("hidden");
  };
  document.getElementById("btn-save-settings").onclick = function () {
    bridge.setSuCmd(inputSu.value);
    settingsOverlay.classList.add("hidden");
    showToast("已保存");
    load();
  };

  // About
  var aboutOverlay = document.getElementById("about-overlay");
  document.getElementById("item-about").onclick = function () {
    dropdown.classList.add("hidden");
    aboutOverlay.classList.remove("hidden");
  };
  document.getElementById("btn-close-about").onclick = function () {
    aboutOverlay.classList.add("hidden");
  };

  /* ---------- Init ---------- */
  var cfg = JSON.parse(bridge.getConfig());
  if (!cfg.rootAvailable) {
    renderError("未找到 su，需要 root 权限。请在设置中填写自定义 su 命令。");
  } else {
    load();
    startPolling();
  }
})();

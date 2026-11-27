(function () {
  "use strict";

  var S = {
    player: false, osdTimer: null,
    builtin: [],
    custom: [],
    groups: [],
    site: { title: "央视频直播", notice: "" },
    overrides: {},
    hidden: [],
    editable: false,
    scope: "lan",
    epg: null,
    filter: "全部",
    keyword: "",
    selected: null,   // {type:'builtin'|'custom', slug}
    playing: null,
    line: "main",
    editing: null,
    hls: null,
    timer: null,
    lastTick: 0,
    switched: false
  };

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  function b64u(str) {
    return btoa(unescape(encodeURIComponent(str)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function toast(msg, isErr) {
    var t = $("#toast");
    t.textContent = msg;
    t.className = "toast on" + (isErr ? " err" : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = "toast"; }, 2600);
  }

  function badge(name) {
    var m = String(name).toUpperCase().match(/CCTV[- ]?([0-9]+[A-Z+]*)/);
    if (m) return "C" + m[1].replace("+", "P");
    return String(name).trim().slice(0, 2) || "CH";
  }

  /* ------------------------------------------------ 数据 */

  function load(keepToast) {
    return fetch("/api/state", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        S.builtin = data.builtin || [];
        S.custom = data.custom || [];
        S.site = data.site || S.site;
        S.groups = data.groups || [];
        S.epg = data.epg || null;
        S.editable = !!data.writable;
        S.scope = data.scope || "lan";
        S.overrides = {};
        S.hidden = [];
        S.builtin.forEach(function (ch) {
          if (ch.edited) {
            var ov = {};
            if (ch.name !== ch.orig_name) ov.name = ch.name;
            if (ch.group !== ch.orig_group) ov.group = ch.group;
            if (ch.custom_url) ov.url = ch.custom_url;
            S.overrides[ch.slug] = ov;
          }
          if (ch.hidden) S.hidden.push(ch.slug);
        });
        renderMeta(data);
        renderList();
        renderInfo();
        renderAdmin();
        return data;
      });
  }

  function payload() {
    return { site: S.site, overrides: S.overrides, hidden: S.hidden, custom: S.custom };
  }

  function save() {
    return fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload())
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
        return load(true);
      });
    });
  }

  /* ------------------------------------------------ 列表模型 */

  function rowsModel(includeHidden) {
    var out = [];
    S.builtin.forEach(function (ch) {
      if (!includeHidden && ch.hidden) return;
      out.push({ type: "builtin", ch: ch, slug: ch.slug, name: ch.name, group: ch.group });
    });
    S.custom.forEach(function (ch) {
      out.push({ type: "custom", ch: ch, slug: ch.id, name: ch.name, group: ch.group });
    });
    return out;
  }

  function matchRow(row) {
    if (S.filter !== "全部" && row.group !== S.filter) return false;
    if (S.keyword) {
      var s = (row.name + " " + row.group + " " + row.slug).toLowerCase();
      if (s.indexOf(S.keyword.toLowerCase()) < 0) return false;
    }
    return true;
  }

  function findRow(type, key) {
    var list = type === "custom" ? S.custom : S.builtin;
    for (var i = 0; i < list.length; i++) {
      var ch = list[i];
      if ((type === "custom" ? ch.id : ch.slug) === key) {
        return { type: type, ch: ch, slug: key, name: ch.name, group: ch.group };
      }
    }
    return null;
  }

  function findSelected() {
    if (!S.selected) return null;
    return findRow(S.selected.type, S.selected.slug);
  }

  function effectiveUrl(row) {
    if (row.type === "custom") return row.ch.url;
    var ov = S.overrides[row.slug] || {};
    return ov.url || ("/" + row.slug + ".m3u8");
  }

  /* ------------------------------------------------ 渲染 */

  function renderMeta(data) {
    var ok = !!data.ok;
    $("#statusPill").className = "pill " + (ok ? "ok" : "bad");
    $("#statusText").textContent = ok ? "服务运行中" : "服务未就绪";
    $("#siteTitle").textContent = S.site.title || "央视频直播";
    document.title = (S.site.title || "央视频直播");

    var scopeText = { lan: "内网访问 · 可修改", ipv6: "IPv6 访问 · 可修改", "public": "公网 IPv4 · 只读" }[S.scope] || "内网访问";
    $("#fScope").textContent = scopeText;
    var base = location.protocol + "//" + location.host + "/all.m3u";
    $("#subUrl").value = base;
    if ($("#subUrlBk")) $("#subUrlBk").value = base + "?line=bk";
    if ($("#subUrlDual")) $("#subUrlDual").value = base + "?dual=1";
    renderUpdate(data.update || null, data.version);

    [ $("#btnAdd"), $("#btnSiteSave"), $("#btnChanSave") ].forEach(function (b) {
      if (b) b.disabled = !S.editable;
    });

    var eng = (data.engine || {}).engine || {};
    var tc = (data.engine || {}).ts_cache || {};
    $("#kvInfo").innerHTML = [
      ["服务状态", ok ? "正常" : "异常"],
      ["频道总数", (data.counts || {}).builtin + " 路（显示 " + (data.counts || {}).visible + "）"],
      ["设备协议池", eng.session_valid ? (eng.active_device_slots || 0) + " 路在跑" : "未就绪"],
      ["分片缓存", (tc.hit_rate || "0%") + (tc.size_mb != null ? " · " + tc.size_mb + " MB" : "")],
      ["界面端口", (data.ports || {}).ui || 8767],
      ["引擎端口", (data.ports || {}).engine || 8788],
      ["节目单", S.epg && S.epg.ok ? "已同步" : "同步中"],
      ["访问方式", scopeText]
    ].map(function (kv) {
      return '<div><b>' + esc(kv[0]) + "</b><span>" + esc(kv[1]) + "</span></div>";
    }).join("");
  }

  function renderFilters() {
    var list = rowsModel(true);
    var groups = ["全部"];
    S.groups.forEach(function (g) { if (g && groups.indexOf(g) < 0) groups.push(g); });
    list.forEach(function (row) { if (row.group && groups.indexOf(row.group) < 0) groups.push(row.group); });
    if (groups.indexOf(S.filter) < 0) S.filter = "全部";

    $("#filters").innerHTML = groups.map(function (g) {
      return '<button class="chip' + (g === S.filter ? " on" : "") + '" data-g="' + esc(g) + '">' + esc(g) + "</button>";
    }).join("");

    $$("#filters .chip").forEach(function (el) {
      el.addEventListener("click", function () {
        S.filter = el.getAttribute("data-g");
        renderList();
      });
    });
  }

  function renderList() {
    renderFilters();
    var all = rowsModel(false).filter(matchRow);
    $("#chCount").textContent = all.length + " 路";

    if (!S.selected && all.length) {
      S.selected = { type: all[0].type, slug: all[0].slug };
    }

    $("#rows").innerHTML = all.map(function (row, i) {
      return rowHtml(row, i, S.selected && S.selected.type === row.type && S.selected.slug === row.slug);
    }).join("");

    $$("#rows .row").forEach(function (el) {
      el.addEventListener("click", function () {
        var row = all[Number(el.getAttribute("data-i"))];
        if (!row) return;
        /* 点频道列表里的任意一行 = 立刻换台播放，不需要先选中再点一次 */
        S.selected = { type: row.type, slug: row.slug };
        renderList(); renderInfo();
        playSoon(row);
      });
    });
  }

  function lineLabel() { return S.line === "backup" ? "备用线路" : "主线路"; }

  function renderInfo() {
    var row = findSelected();
    var isPlaying = S.playing && row && S.playing.slug === row.slug && S.playing.type === row.type;
    $("#iWatch").className = "watch" + (isPlaying ? " on" : "");

    $("#iIdx").textContent = row ? (rowIndex(row) + 1) : "—";
    $("#iName").textContent = row ? row.name : "选择一个频道";
    $("#iGroup").textContent = row ? (row.group || "") : "央视 / 卫视";

    var now = row && row.ch.now;
    var next = row && row.ch.next;
    $("#iNow").textContent = now ? now.title : (S.epg && !S.epg.ok ? "节目单同步中…" : "—");
    $("#iNowTime").textContent = now ? (now.start + " – " + now.stop) : "";
    $("#iNext").textContent = next ? next.title : "—";
    $("#iNextTime").textContent = next ? (next.start + " – " + next.stop) : "";

    var src = row ? (row.type === "custom" ? "自定义源 · " : "央视频直播 · ") + lineLabel() : "央视频直播 · " + lineLabel();
    $("#iSrc").textContent = src;
    $("#iSrcNote").textContent = row && row.type === "custom"
      ? "外链经 NAS 代理（解决跨域与相对路径）"
      : "备用线路：NAS 代理转发";

    if (row && !isPlaying) {
      $("#idleCh").textContent = row.name;
      $("#idleProg").textContent = now ? ("正在播出 · " + now.title) : "点「立即收看」开始直播";
    } else if (!row) {
      $("#idleCh").textContent = "央视频直播";
      $("#idleProg").textContent = "选一个频道，再点一次开始收看";
    }

    $("#lineTag").textContent = lineLabel();
    $("#btnLine").textContent = lineLabel();
    $("#btnLine").className = "tbtn" + (S.line === "backup" ? " on" : "");
  }

  function rowHtml(row, i, on) {
    var sub = (row.ch.now && row.ch.now.title) ? row.ch.now.title : (row.group || "");
    return '<div class="row' + (on ? " on" : "") + '" data-i="' + i + '">' +
      '<div class="num">' + (i + 1) + "</div>" +
      '<div class="meta"><div class="nm">' + esc(row.name) + "</div>" +
      '<div class="sub">' + esc(sub) + "</div></div></div>";
  }

  /* ------------------------------------------------ 全屏播放 + 选台浮层 */

  function showOsd(hold) {
    document.body.classList.add("osd-on");
    $("#osd").classList.remove("collapsed");
    $("#osd").classList.add("on");
    renderOsd();
    clearTimeout(S.osdTimer);
    S.osdTimer = hold ? null : setTimeout(hideOsd, 9000);
  }

  function hideOsd() {
    clearTimeout(S.osdTimer);
    S.osdTimer = null;
    document.body.classList.remove("osd-on");
    $("#osd").classList.remove("on");
  }

  function toggleOsd() {
    if ($("#osd").classList.contains("on")) hideOsd(); else showOsd();
  }

  function renderOsd() {
    var all = rowsModel(false).filter(matchRow);
    $("#osdCount").textContent = all.length + " 路";

    $("#osdChips").innerHTML = S.groups.map(function (g) {
      return '<button class="chip' + (S.filter === g ? " on" : "") + '" data-g="' + esc(g) + '">' + esc(g) + "</button>";
    }).join("");
    $$("#osdChips .chip").forEach(function (el) {
      el.addEventListener("click", function () {
        S.filter = el.getAttribute("data-g");
        renderList(); renderOsd(); showOsd();
      });
    });

    if (!all.length) {
      $("#osdRows").innerHTML = '<div style="padding:18px;color:var(--muted);font-size:13px">没有匹配的频道</div>';
      return;
    }
    $("#osdRows").innerHTML = all.map(function (row, i) {
      return rowHtml(row, i, S.selected && S.selected.type === row.type && S.selected.slug === row.slug);
    }).join("");

    $$("#osdRows .row").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        var row = all[Number(el.getAttribute("data-i"))];
        if (!row) return;
        S.selected = { type: row.type, slug: row.slug };
        playSoon(row);
        renderOsd();
        $("#osd").classList.remove("collapsed");  /* 换台后保留频道栏 */
        clearTimeout(S.osdTimer);
        S.osdTimer = setTimeout(hideOsd, 9000);
      });
    });

    var cs = findSelected();
    $("#oiIdx").textContent = cs ? (rowIndex(cs) + 1) : "—";
    $("#oiName").textContent = cs ? cs.name : "未选频道";
    $("#oiGroup").textContent = cs ? (cs.group || "") : "";
    $("#oiWatch").className = "oi-watch" + (cs && S.playing && S.playing.slug === cs.slug ? " on" : "");
    var now = cs && cs.ch.now, next = cs && cs.ch.next;
    $("#oiNow").textContent = now ? now.title : (S.epg && !S.epg.ok ? "节目单同步中…" : "—");
    $("#oiNowTime").textContent = now ? (now.start + " – " + now.stop) : "";
    $("#oiNext").textContent = next ? next.title : "—";
    $("#oiNextTime").textContent = next ? (next.start + " – " + next.stop) : "";
    $("#oiSrc").textContent = (cs && cs.type === "custom" ? "自定义源 · " : "央视频直播 · ") + lineLabel();
    $("#osdLine").textContent = lineLabel();
    $("#osdLine").className = "tbtn" + (S.line === "backup" ? " on" : "");
  }

  function enterPlayer() {
    if (S.player) return;
    S.player = true;
    $("#shell").classList.add("player");
    var coarse = window.matchMedia && window.matchMedia("(pointer:coarse)").matches;
    var el = $("#screen");
    if (!coarse && el.requestFullscreen && !document.fullscreenElement) {
      try { el.requestFullscreen({ navigationUI: "hide" }); } catch (e) { }
    }
  }

  function exitPlayer() {
    S.player = false;
    $("#shell").classList.remove("player");
    hideOsd();
    if (fsElement()) {
      exitFs();
    }
  }

  /* ------------------------------------------------ 全屏切换（双击画面） */

  function fsElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function requestFs() {
    var el = $("#screen");
    var fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (fn) {
      try {
        var r = fn.call(el, { navigationUI: "hide" });
        if (r && r.catch) r.catch(function () { });
      } catch (e) { }
      return;
    }
    /* iPhone 只有 video 元素自带原生全屏，div 上没有任何 Fullscreen API */
    var v = $("#vid");
    if (v && v.webkitEnterFullscreen) {
      try { v.webkitEnterFullscreen(); } catch (e) { }
      return;
    }
    enterPlayer();   /* 其它手机浏览器：至少切到页面内满屏 */
  }

  function exitFs() {
    var fn = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (fn) {
      try {
        var r = fn.call(document);
        if (r && r.catch) r.catch(function () { });
      } catch (e) { }
    }
  }

  function toggleFullscreen() {
    if (fsElement()) exitFs(); else requestFs();
  }

  /* 单击 = 立刻执行（显示/隐藏频道浮层）；双击 = 全屏切换。
     不延时：第一下就动作，第二下在 340ms 内到 → 判为双击，
     先把第一下的浮层切换原样撤销，再切全屏，视觉上不闪。
     浮层遮罩 pointer-events:none，点到面板才算浮层内点击，
     所以「单击播放画面」能立刻收起浮层。 */
  var lastClickT = 0, lastAction = null, lastX = 0, lastY = 0;

  function inPanel(el) {
    return !!(el.closest(".osd-col") || el.closest(".osd-tools") || el.closest("button"));
  }

  $("#screen").addEventListener("click", function (e) {
    if (!S.player) return;
    var v = $("#vid");
    if (S.suppressClick) { S.suppressClick = false; return; }
    if (needsGesture()) { S.needGesture = false; resumePlay(); return; }
    var now = Date.now();
    var dx = e.clientX - lastX, dy = e.clientY - lastY;
    /* 双击：时间 < 350ms 且落点基本重合，第二下即使正落在刚弹出的面板上也算 */
    if (lastAction === "osd" && now - lastClickT < 350 && dx * dx + dy * dy < 2500) {
      lastClickT = 0;
      lastAction = null;
      toggleOsd();                 /* 撤销第一下 */
      var wasFs = !!fsElement();
      toggleFullscreen();
      if (!wasFs) hideOsd();       /* 进全屏回到干净画面 */
      return;
    }
    if (inPanel(e.target)) { lastClickT = 0; lastAction = null; return; }
    lastClickT = now;
    lastX = e.clientX;
    lastY = e.clientY;
    lastAction = "osd";
    toggleOsd();
  });

  /* 手机：自己判单击/双击。iOS Safari 不触发 dblclick，
     而且双击会被浏览器当成缩放，所以触摸自己处理并吃掉默认行为。 */
  var tapT = 0, tapX = 0, tapY = 0, tapTimer = 0;
  function clearTapTimer() { if (tapTimer) { clearTimeout(tapTimer); tapTimer = 0; } }
  $("#screen").addEventListener("touchend", function (e) {
    if (!S.player || !e.changedTouches || !e.changedTouches.length) return;
    if (e.touches && e.touches.length > 0) return;          /* 多指手势不处理 */
    var t = e.changedTouches[0];
    if (inPanel(e.target)) return;                          /* 点在浮层面板：交给面板自己的 click */
    S.suppressClick = true;                                 /* 吃掉随后合成的 click */
    if (needsGesture()) { clearTapTimer(); tapT = 0; S.needGesture = false; resumePlay(); return; }
    var now = Date.now(), dx = t.clientX - tapX, dy = t.clientY - tapY;
    if (now - tapT < 330 && (dx * dx + dy * dy) < 2500) {   /* 双击：直接全屏，首击不再动浮层 */
      e.preventDefault();
      clearTapTimer(); tapT = 0;
      toggleFullscreen();
      return;
    }
    tapT = now; tapX = t.clientX; tapY = t.clientY;
    /* 手机上一次点击要等 300ms 才能确定不是双击，避免浮层抢走第二击 */
    clearTapTimer();
    tapTimer = setTimeout(function () { tapTimer = 0; tapT = 0; toggleOsd(); }, 300);
  }, { passive: false });

  /* 双击事件本身用来吃掉浏览器默认行为（部分电视浏览器会放大页面） */
  $("#screen").addEventListener("dblclick", function (e) {
    if (!S.player) return;
    if (inPanel(e.target)) return;
    e.preventDefault();
  });

  $("#osdFold").addEventListener("click", function (e) { e.stopPropagation(); exitPlayer(); });
  $("#osdAdmin").addEventListener("click", function (e) {
    e.stopPropagation();
    hideOsd();
    exitPlayer();
    openAdmin();
  });
  $("#osdFull").addEventListener("click", function (e) {
    e.stopPropagation();
    toggleFullscreen();
  });
  $("#osdLine").addEventListener("click", function (e) {
    e.stopPropagation();
    S.line = S.line === "main" ? "backup" : "main";
    S.switched = S.line === "backup";
    var row = S.playing ? findRow(S.playing.type, S.playing.slug) : findSelected();
    if (S.playing && row) { startPlay(row, S.line); toast("已切换到" + lineLabel()); }
    else { renderInfo(); toast("线路已切到" + lineLabel() + "，播放时生效"); }
    renderOsd();
  });

  function rowIndex(row) {
    var all = rowsModel(false).filter(matchRow);
    for (var i = 0; i < all.length; i++) {
      if (all[i].type === row.type && all[i].slug === row.slug) return i;
    }
    return 0;
  }

  /* ------------------------------------------------ 播放 */

  function playUrl(row, line) {
    if (row.type === "custom") return "/ext?u=" + b64u(row.ch.url);
    if (line === "backup") return "/api/play.m3u8?ch=" + encodeURIComponent(row.slug) + "&proxy=1";
    return "/" + row.slug + ".m3u8";
  }

  /* 覆盖层提示已取消：这两个函数保留为空实现，兼容旧调用点 */
  function tapOn(_on) { }

  function safePlay(v) {
    if (!v) return;
    /* 不做静音兜底：始终带声音播放。被浏览器拦下时只记一个标记，
       用户任意点一下画面 / 按一个键就恢复（不弹任何提示块）。
       同时做几次静默重试：有些浏览器在用户碰过站点后就会放行。 */
    v.muted = false;
    var p = v.play();
    if (!p || !p.catch) return;
    p.catch(function () {
      S.needGesture = true;
      setPlayState("点一下画面开始播放");
      clearTimeout(S.playRetry);
      var tries = 0;
      (function again() {
        if (!S.needGesture || $("#vid").paused === false) return;
        tries += 1;
        if (tries > 3) return;
        S.playRetry = setTimeout(function () {
          if (!S.needGesture) return;
          var vv = $("#vid");
          vv.muted = false;
          var pp = vv.play();
          if (pp && pp.then) pp.then(function () { S.needGesture = false; setPlayState("直播中"); }).catch(function () { again(); });
        }, 1000 * tries);
      })();
    });
  }

  /* 只有视频真的暂停了才算需要手势；needGesture 标记可能滞后（例如重试循环已放弃、
     播放其实已经恢复），不能再拿它拦掉单击/双击 */
  function needsGesture() {
    var v = $("#vid");
    return !!(S.playing && v.paused);
  }

  function resumePlay() {
    var v = $("#vid");
    S.needGesture = false;
    tapOn(false);
    /* 一条数据都没拿到：直接从主线路重开当前频道，而不是干等 */
    if (S.playing && v.readyState === 0) {
      var cur = findRow(S.playing.type, S.playing.slug);
      if (cur) {
        S.switched = false;
        S.line = "main";
        startPlay(cur, "main");
        return;
      }
    }
    v.muted = false;
    safePlay(v);
    setPlayState(S.line === "backup" ? "直播中 · 备用线路" : "直播中 · 主线路");
  }

  function destroyHls() {
    if (S.hls) { try { S.hls.destroy(); } catch (e) { } S.hls = null; }
    clearInterval(S.timer); S.timer = null;
    var v = $("#vid");
    try { v.pause(); } catch (e) { }
    v.removeAttribute("src"); v.load();
  }

  function setPlayState(text) { $("#playState").textContent = text; }

  /* 换台节流：单击立刻播；连续快速连点时只落地最后一次，
     避免给央视频开一堆会话（上游会直接返回「操作过于频繁」） */
  var ZAP_MIN = 900;
  function playSoon(row, line) {
    var now = Date.now();
    var wait = ZAP_MIN - (now - (S.lastStart || 0));
    clearTimeout(S.zapTimer);
    if (wait <= 0) {
      S.lastStart = now;
      startPlay(row, line);
      return;
    }
    setPlayState("切换中…");
    S.zapTimer = setTimeout(function () {
      S.lastStart = Date.now();
      startPlay(row, line);
    }, wait);
  }

  function startPlay(row, line) {
    var useLine = line || S.line;
    var url = playUrl(row, useLine);
    var video = $("#vid");

    destroyHls();
    S.resolveTries = 0;
    S.playing = { type: row.type, slug: row.slug, name: row.name };
    S.switched = useLine === "backup";
    $("#idle").classList.add("hide");
    tapOn(false);
    video.muted = false;
    setPlayState("加载中…");
    renderInfo(); renderList();

    if (!(window.Hls && window.Hls.isSupported())) {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = url;
        safePlay(video);
        setPlayState("直播中（系统解码）");
      } else {
        setPlayState("浏览器不支持 HLS");
        toast("当前浏览器不支持 HLS，请用 Chrome / Edge / Safari", true);
      }
      return;
    }

    var hls = new window.Hls({
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      backBufferLength: 10,
      liveSyncDurationCount: 2,
      lowLatencyMode: false,
      enableWorker: true,
      startFragPrefetch: true,
      testBandwidth: false,
      abrEwmaDefaultEstimate: 2500000,
      manifestLoadingTimeOut: 20000,
      manifestLoadingMaxRetry: 6,
      levelLoadingTimeOut: 12000,
      levelLoadingMaxRetry: 5,
      fragLoadingTimeOut: 26000,
      fragLoadingMaxRetry: 6,
      nudgeMaxRetry: 8
    });
    S.hls = hls;
    var mediaRetry = 0;

    hls.on(window.Hls.Events.ERROR, function (evt, data) {
      if (!data || !data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
        var code = data.response && data.response.code;
        /* 503 = 引擎那边正在解析这个频道（两条线路都会 503），
           切线路没有意义，原地退避重试即可 */
        if (code === 503) {
          S.resolveTries = (S.resolveTries || 0) + 1;
          if (S.resolveTries <= 5) {
            setPlayState("频道解析中…（第 " + S.resolveTries + " 次重试）");
            setTimeout(function () { try { hls.startLoad(); } catch (e) { } },
                       1200 * S.resolveTries);
            return;
          }
          toast("该频道解析不出来，换一个试试（央视频侧暂无数据）", true);
          setPlayState("该频道暂无数据");
          return;
        }
        if (useLine === "main" && !S.switched) {
          S.switched = true;
          S.line = "backup";
          toast("主线路异常，已切到备用线路（NAS 代理）");
          startPlay(row, "backup");
          return;
        }
        if (code === 404) toast("该频道的上游地址已失效（404）", true);
        setPlayState("网络错误，重连中…");
        try { hls.startLoad(); } catch (e) { }
        return;
      }
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && mediaRetry < 2) {
        mediaRetry += 1;
        try { hls.recoverMediaError(); return; } catch (e) { }
      }
      setPlayState("播放中断：" + (data.details || data.type));
    });

    hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
      S.lastTick = Date.now();
      setPlayState(useLine === "backup" ? "直播中 · 备用线路" : "直播中 · 主线路");
      safePlay(video);
    });

    hls.loadSource(url);
    hls.attachMedia(video);

    /* 20 秒无画面自动切备用线路 */
    clearInterval(S.timer);
    S.stallFrom = Date.now();
    S.timer = setInterval(function () {
      if (!S.playing) return;
      var v = $("#vid");
      if (v.paused) {
        safePlay(v);
        S.lastTick = Date.now();
        return;
      }
      if (v.readyState === 0 && Date.now() - (S.stallFrom || 0) > 6000) {
        tapOn(true);
        return;
      }
      var wait = v.readyState === 0 ? 9000 : 16000;
      if (Date.now() - S.lastTick < wait) return;
      var cur = findRow(S.playing.type, S.playing.slug);
      if (!cur || cur.type === "custom") return;
      if (S.line === "main") {
        S.switched = true;
        S.line = "backup";
        toast("主线路取不到画面，切备用线路");
        startPlay(cur, "backup");
        return;
      }
      /* 两条线路都拿不到数据：给出明确出口，点一下重试 */
      setPlayState("两条线路都取不到数据 · 点画面重试");
      tapOn(true);
    }, 2000);
  }

  function stopPlay() {
    exitPlayer();
    destroyHls();
    S.playing = null;
    S.line = "main";
    S.switched = false;
    $("#idle").classList.remove("hide");
    tapOn(false);
    setPlayState("未播放");
    renderInfo(); renderList();
  }

  /* 任何一次按下/按键都先把卡住的播放推起来（不依赖点到视频本体） */
  document.addEventListener("pointerdown", function () {
    if (!S.playing) return;
    var v = $("#vid");
    if (v.paused) {
      S.suppressClick = true;
      resumePlay();
    }
  }, true);

  document.addEventListener("keydown", function () {
    if (!S.playing) return;
    var v = $("#vid");
    if (v.paused) resumePlay();
  });

  $("#vid").addEventListener("playing", function () {
    tapOn(false);
    S.needGesture = false;
  });

  $("#vid").addEventListener("pause", function () { });

  $("#vid").addEventListener("timeupdate", function () {
    var v = $("#vid");
    if (!v.paused && v.currentTime > 0) S.lastTick = Date.now();
  });


  $("#btnLine").addEventListener("click", function () {
    S.line = S.line === "main" ? "backup" : "main";
    S.switched = S.line === "backup";
    var row = S.playing ? findRow(S.playing.type, S.playing.slug) : findSelected();
    if (S.playing && row) {
      startPlay(row, S.line);
      toast("已切换到" + lineLabel());
      return;
    }
    renderInfo();
    toast("线路已切到" + lineLabel() + "，播放时生效");
  });

  /* ------------------------------------------------ 侧栏收起 */

  $("#btnFold").addEventListener("click", function () {
    var folded = $("#stage").classList.toggle("fold");
    $("#btnFold").textContent = folded ? "展开" : "收起";
  });

  /* ------------------------------------------------ 管理面板 */

  function openAdmin() {
    $("#fTitle").value = S.site.title || "";
    $("#fNotice").value = S.site.notice || "";
    $("#admin").classList.add("on");
    renderAdmin();
  }
  function closeAdmin() { $("#admin").classList.remove("on"); }

  $("#btnAdmin").addEventListener("click", openAdmin);
  $("#btnAdminClose").addEventListener("click", closeAdmin);
  $("#admin").addEventListener("click", function (e) {
    if (e.target === $("#admin")) closeAdmin();
  });

  function renderAdmin() {
    if (!$("#admin").classList.contains("on")) return;
    var all = rowsModel(true).filter(matchRow);
    $("#adminCount").textContent = "共 " + rowsModel(true).length + " 路（显示 " + all.length + "）";

    if (!all.length) {
      $("#adminRows").innerHTML = '<tr><td colspan="5" style="padding:22px;text-align:center;color:var(--muted)">没有匹配的频道</td></tr>';
      return;
    }

    $("#adminRows").innerHTML = all.map(function (row) {
      var ch = row.ch;
      var isCustom = row.type === "custom";
      var isHidden = !isCustom && S.hidden.indexOf(row.slug) >= 0;
      var edited = !isCustom && Object.keys(S.overrides[row.slug] || {}).length > 0;
      var logo = ch.logo
        ? '<img src="' + esc(ch.logo) + '" alt="" loading="lazy" onerror="this.parentNode.innerHTML=\'' + esc(badge(row.name)) + '\'">'
        : esc(badge(row.name));
      var status = isCustom ? '<span class="tag2 g">自定义</span>'
        : (isHidden ? '<span class="tag2 y">已隐藏</span>'
          : (edited ? '<span class="tag2 g">已改</span>' : '<span class="tag2">内置</span>'));
      var title = effectiveUrl(row);
      var addr = title.charAt(0) === "/" ? "内置解析" : title.replace(/^https?:\/\//, "").split("/")[0];

      var ops = [
        '<button class="btn small accent" data-act="play" data-type="' + row.type + '" data-key="' + esc(row.slug) + '">播放</button>',
        '<button class="btn small ghost" data-act="edit" data-type="' + row.type + '" data-key="' + esc(row.slug) + '">编辑</button>'
      ];
      if (!isCustom) {
        ops.push('<button class="btn small ghost" data-act="toggle" data-type="builtin" data-key="' + esc(row.slug) + '">' + (isHidden ? "显示" : "隐藏") + "</button>");
        if (edited) ops.push('<button class="btn small ghost" data-act="reset" data-type="builtin" data-key="' + esc(row.slug) + '">恢复</button>');
      } else {
        ops.push('<button class="btn small ghost" data-act="del" data-type="custom" data-key="' + esc(row.slug) + '">删除</button>');
      }

      return "<tr>" +
        '<td><div class="ch-cell"><div class="ch-logo">' + logo + "</div>" +
        '<div style="min-width:0"><div class="ch-name">' + esc(row.name) + "</div>" +
        '<div class="ch-slug">' + esc(isCustom ? row.slug : "/" + row.slug + ".m3u8") + "</div></div></div></td>" +
        "<td>" + esc(row.group) + "</td>" +
        '<td><div class="addr" title="' + esc(title) + '">' + esc(addr) + "</div></td>" +
        "<td>" + status + "</td>" +
        '<td><div class="ops">' + ops.join("") + "</div></td></tr>";
    }).join("");

    $$("#adminRows button[data-act]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        handleAdmin(btn.getAttribute("data-act"), btn.getAttribute("data-type"), btn.getAttribute("data-key"));
      });
    });
  }

  function handleAdmin(act, type, key) {
    var row = findRow(type, key);
    if (!row) return;
    if (act === "play") {
      S.selected = { type: type, slug: key };
      closeAdmin();
      startPlay(row);
      return;
    }
    if (!S.editable) { toast("当前来源不支持修改", true); return; }

    if (act === "toggle") {
      var i = S.hidden.indexOf(key);
      if (i >= 0) S.hidden.splice(i, 1); else S.hidden.push(key);
      save().then(function () { toast(i >= 0 ? "已显示" : "已隐藏"); })
        .catch(function (e) { toast("保存失败：" + e.message, true); });
      return;
    }
    if (act === "reset") {
      delete S.overrides[key];
      save().then(function () { toast("已恢复默认"); })
        .catch(function (e) { toast("保存失败：" + e.message, true); });
      return;
    }
    if (act === "del") {
      if (!confirm("确定删除频道「" + row.name + "」？")) return;
      S.custom = S.custom.filter(function (c) { return c.id !== key; });
      save().then(function () { toast("已删除"); })
        .catch(function (e) { toast("删除失败：" + e.message, true); });
      return;
    }
    if (act === "edit") openChan(type, key);
  }

  $("#btnRefresh").addEventListener("click", function () {
    load(true).then(function () { toast("已刷新"); }).catch(function () { toast("刷新失败", true); });
  });

  $("#search").addEventListener("input", function (e) {
    S.keyword = e.target.value.trim();
    renderAdmin();
  });

  $("#btnAdd").addEventListener("click", function () {
    if (!S.editable) { toast("当前来源不支持修改", true); return; }
    openChan("add", null);
  });

  /* 站点 */
  $("#btnSiteSave").addEventListener("click", function () {
    S.site = {
      title: $("#fTitle").value.trim() || "央视频直播",
      notice: $("#fNotice").value.trim()
    };
    save().then(function () { toast("站点信息已保存"); })
      .catch(function (e) { toast("保存失败：" + e.message, true); });
  });

  /* 频道编辑 */
  function openChan(type, key) {
    if (type === "add") {
      S.editing = { type: "custom", key: null };
      $("#mChanTitle").textContent = "新增频道";
      $("#cName").value = "";
      $("#cGroup").value = "自定义";
      $("#cUrl").value = "";
      $("#cLogo").value = "";
      $("#wrapLogo").style.display = "block";
      $("#cUrlTip").textContent = "填写完整的 http(s) m3u8 地址。";
    } else {
      var row = findRow(type, key);
      if (!row) return;
      S.editing = { type: type, key: key };
      $("#mChanTitle").textContent = type === "custom" ? "编辑自定义频道" : "编辑内置频道";
      $("#cName").value = row.name;
      $("#cGroup").value = row.group;
      if (type === "custom") {
        $("#cUrl").value = row.ch.url;
        $("#cLogo").value = row.ch.logo || "";
        $("#wrapLogo").style.display = "block";
        $("#cUrlTip").textContent = "自定义频道的播放地址，必填。";
      } else {
        $("#cUrl").value = (S.overrides[key] || {}).url || "";
        $("#wrapLogo").style.display = "none";
        $("#cUrlTip").textContent = "留空表示沿用程序内置解析地址；填写后该频道改用你给的 m3u8。";
      }
    }
    $("#mChan").classList.add("on");
  }

  $("#btnChanSave").addEventListener("click", function () {
    var ed = S.editing;
    if (!ed) return;
    var name = $("#cName").value.trim();
    var group = $("#cGroup").value.trim() || "自定义";
    var url = $("#cUrl").value.trim();
    var logo = $("#cLogo").value.trim();

    if (!name) { toast("频道名称不能为空", true); return; }
    if (url && !/^https?:\/\//i.test(url)) { toast("地址必须以 http:// 或 https:// 开头", true); return; }

    if (ed.type === "builtin") {
      var row = findRow("builtin", ed.key);
      if (!row) return;
      var ov = {};
      if (name !== row.ch.orig_name) ov.name = name;
      if (group !== row.ch.orig_group) ov.group = group;
      if (url) ov.url = url;
      if (Object.keys(ov).length) S.overrides[ed.key] = ov; else delete S.overrides[ed.key];
    } else {
      if (!url) { toast("自定义频道必须填写播放地址", true); return; }
      if (ed.key) {
        S.custom.forEach(function (c) {
          if (c.id === ed.key) { c.name = name; c.group = group; c.url = url; c.logo = logo; }
        });
      } else {
        S.custom.push({ id: "c" + Date.now().toString(36), name: name, group: group, url: url, logo: logo });
      }
    }

    save().then(function () { $("#mChan").classList.remove("on"); toast("已保存"); })
      .catch(function (e) { toast("保存失败：" + e.message, true); });
  });

  function renderUpdate(info, current) {
    var now = $("#verNow"), latest = $("#verLatest"), msg = $("#verMsg"), btn = $("#btnUpgrade");
    if (!now) return;
    now.textContent = (current || (info && info.current) || "—");
    latest.textContent = (info && info.latest) || "—";
    if (!info || info.checking) {
      msg.textContent = "正在向 GitHub 检查新版本…";
      btn.disabled = true;
      return;
    }
    if (info.error) {
      msg.textContent = "检测失败：" + info.error + "（NAS 可能访问不到 GitHub，可稍后重试）";
      btn.disabled = true;
      return;
    }
    if (info.has_update) {
      msg.textContent = "发现新版本 " + info.latest + "（当前 " + (info.current || current) + "），点「下载升级包」保存到 NAS。";
      btn.disabled = !S.editable;
      btn.textContent = "下载 " + (info.fpk_name || "升级包");
    } else {
      msg.textContent = "已是最新版本（当前 " + (info.current || current || "—") + "）。";
      btn.disabled = true;
      btn.textContent = "下载升级包";
    }
  }

  function checkVer(force) {
    var b = $("#btnCheckVer");
    if (b.disabled) return;
    b.disabled = true;
    $("#verMsg").textContent = "正在检查…";
    fetch("/api/update" + (force ? "?force=1" : "")).then(function (r) { return r.json(); })
      .then(function (d) { b.disabled = false; renderUpdate(d, null); })
      .catch(function (e) { b.disabled = false; $("#verMsg").textContent = "检测失败：" + e.message; });
  }

  if ($("#btnCheckVer")) $("#btnCheckVer").addEventListener("click", function () { checkVer(true); });

  if ($("#btnUpgrade")) $("#btnUpgrade").addEventListener("click", function () {
    var b = this;
    b.disabled = true;
    $("#verMsg").textContent = "正在下载安装包（约 0.4 MB）…";
    fetch("/api/update/download", { method: "POST" }).then(function (r) { return r.json(); })
      .then(function (d) {
        b.disabled = false;
        if (d.error) { $("#verMsg").textContent = "下载失败：" + d.error; return; }
        var shaText = d.sha_ok === true ? "sha256 已校验一致" :
          (d.sha_ok === false ? "sha256 校验不一致，请勿安装！" : "sha256 " + String(d.sha256 || "").slice(0, 16) + "…");
        $("#verMsg").textContent = "已下载到 " + d.path + "（" + shaText + "）。到应用中心「手动安装」选中该文件即可，配置与频道会保留。";
        toast("升级包已下载");
      })
      .catch(function (e) { b.disabled = false; $("#verMsg").textContent = "下载失败：" + e.message; });
  });

  function copyInput(input, msg) {
    if (!input) return;
    input.select(); input.setSelectionRange(0, 99999);
    var done = function () { toast(msg); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(done).catch(function () { document.execCommand("copy"); done(); });
    } else { document.execCommand("copy"); done(); }
  }

  $("#btnCopy").addEventListener("click", function () {
    copyInput($("#subUrl"), "订阅地址已复制");
  });
  if ($("#btnCopyBk")) $("#btnCopyBk").addEventListener("click", function () {
    copyInput($("#subUrlBk"), "备用线路订阅已复制");
  });
  if ($("#btnCopyDual")) $("#btnCopyDual").addEventListener("click", function () {
    copyInput($("#subUrlDual"), "双线路订阅已复制");
  });

  $$("[data-close]").forEach(function (el) {
    el.addEventListener("click", function () {
      var mask = el.closest(".mask");
      if (mask) mask.classList.remove("on");
    });
  });
  $$(".mask").forEach(function (mask) {
    mask.addEventListener("click", function (e) {
      if (e.target === mask) mask.classList.remove("on");
    });
  });

  $("#btnFull").addEventListener("click", function () {
    if (!S.player) { enterPlayer(); return; }
    toggleFullscreen();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if ($("#osd").classList.contains("on")) { hideOsd(); return; }
    if (S.player) { exitPlayer(); return; }
    closeAdmin();
    $("#mChan").classList.remove("on");
  });

  /* ------------------------------------------------ 启动 */

  load().then(function () {
    var qs = new URLSearchParams(location.search);
    if (qs.get("admin") === "1") openAdmin();
    if (qs.get("admin") === "1") return;      /* 管理界面不自动播 */
    var ch = qs.get("ch");
    var row = ch ? (findRow("builtin", ch) || findRow("custom", ch)) : null;
    if (!row) {                                /* 首次打开：直接播第一个频道 */
      var first = rowsModel(false).filter(matchRow)[0];
      if (first) {
        row = first;
        S.selected = { type: first.type, slug: first.slug };
      }
    } else {
      S.selected = { type: row.type, slug: row.slug };
    }
    if (row) {
      renderList(); renderInfo();
      startPlay(row);
      enterPlayer();
      if (qs.get("osd") === "1") setTimeout(function () {
        showOsd(true);
        if (qs.get("mini") === "1") $("#osd").classList.add("collapsed");
      }, 300);
    }
  }).catch(function (err) {
    $("#statusPill").className = "pill bad";
    $("#statusText").textContent = "无法连接";
    toast("读取状态失败：" + err.message, true);
  });

  /* 节目单未就绪时快速重试，之后回到 60 秒轮询 */
  var epgTries = 0;
  function scheduleRefresh() {
    if (S.epg && S.epg.ok) {
      setTimeout(function () {
        load(true).catch(function () { });
        scheduleRefresh();
      }, 60000);
      return;
    }
    epgTries += 1;
    if (epgTries > 8) return;
    setTimeout(function () {
      load(true).catch(function () { });
      scheduleRefresh();
    }, 4000);
  }
  scheduleRefresh();

  setInterval(function () {
    if (document.querySelector(".mask.on") || $("#admin").classList.contains("on")) return;
    if (!(S.epg && S.epg.ok)) return;
    load(true).catch(function () { });
  }, 60000);

})();

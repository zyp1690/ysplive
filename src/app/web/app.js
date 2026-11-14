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
    $("#subUrl").value = location.protocol + "//" + location.host + "/all.m3u";

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
        var same = S.selected && S.selected.type === row.type && S.selected.slug === row.slug;
        if (same) { startPlay(row); return; }
        S.selected = { type: row.type, slug: row.slug };
        renderList();
        renderInfo();
      });
    });
  }

  function lineLabel() { return S.line === "backup" ? "备用线路" : "主线路"; }

  function renderInfo() {
    var row = findSelected();
    var isPlaying = S.playing && row && S.playing.slug === row.slug && S.playing.type === row.type;
    $("#iWatch").className = "watch" + (isPlaying ? " on" : "");
    $("#btnPlay").className = "playbig" + (isPlaying ? " on" : "");
    $("#btnPlay").textContent = isPlaying ? "正在观看" : (row ? "立即收看" : "选择频道");

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
        startPlay(row);
        renderOsd();
        $("#osd").classList.add("collapsed");     /* 换台后自动收起频道栏 */
        clearTimeout(S.osdTimer);
        S.osdTimer = setTimeout(hideOsd, 6000);
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
    var isOn = cs && S.playing && S.playing.slug === cs.slug && S.playing.type === cs.type;
    $("#oiPlay").className = "oi-btn" + (isOn ? " on" : "");
    $("#oiPlay").textContent = isOn ? "正在观看" : "立即收看";
  }

  function enterPlayer() {
    if (S.player) return;
    S.player = true;
    $("#shell").classList.add("player");
    var el = $("#screen");
    if (el.requestFullscreen && !document.fullscreenElement) {
      try { el.requestFullscreen({ navigationUI: "hide" }); } catch (e) { }
    }
  }

  function exitPlayer() {
    S.player = false;
    $("#shell").classList.remove("player");
    hideOsd();
    if (document.fullscreenElement && document.exitFullscreen) {
      try { document.exitFullscreen(); } catch (e) { }
    }
  }

  $("#screen").addEventListener("click", function (e) {
    if (!S.player) return;
    if (e.target.closest("button")) return;
    if (e.target.closest(".osd-col")) return;      /* 点在浮层卡片上：不处理 */
    if ($("#osd").classList.contains("on")) { hideOsd(); return; }
    showOsd();
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
    var el = $("#screen");
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    if (el.requestFullscreen) el.requestFullscreen({ navigationUI: "hide" });
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
  $("#oiPlay").addEventListener("click", function (e) {
    e.stopPropagation();
    var row = findSelected();
    if (!row) return;
    var isOn = S.playing && S.playing.slug === row.slug && S.playing.type === row.type;
    if (isOn) { stopPlay(); }
    else { startPlay(row); }
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

  function destroyHls() {
    if (S.hls) { try { S.hls.destroy(); } catch (e) { } S.hls = null; }
    clearInterval(S.timer); S.timer = null;
    var v = $("#vid");
    try { v.pause(); } catch (e) { }
    v.removeAttribute("src"); v.load();
  }

  function setPlayState(text) { $("#playState").textContent = text; }

  function startPlay(row, line) {
    var useLine = line || S.line;
    var url = playUrl(row, useLine);
    var video = $("#vid");

    destroyHls();
    S.playing = { type: row.type, slug: row.slug, name: row.name };
    S.switched = useLine === "backup";
    $("#idle").classList.add("hide");
    setPlayState("加载中…");
    renderInfo(); renderList();

    if (!(window.Hls && window.Hls.isSupported())) {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = url;
        video.play().catch(function () { });
        setPlayState("直播中（系统解码）");
      } else {
        setPlayState("浏览器不支持 HLS");
        toast("当前浏览器不支持 HLS，请用 Chrome / Edge / Safari", true);
      }
      return;
    }

    var hls = new window.Hls({
      maxBufferLength: 22,
      maxMaxBufferLength: 44,
      liveSyncDurationCount: 3,
      enableWorker: true
    });
    S.hls = hls;
    var mediaRetry = 0;

    hls.on(window.Hls.Events.ERROR, function (evt, data) {
      if (!data || !data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
        if (useLine === "main" && !S.switched) {
          S.switched = true;
          S.line = "backup";
          toast("主线路异常，已切到备用线路（NAS 代理）");
          startPlay(row, "backup");
          return;
        }
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
      video.play().catch(function () { });
    });

    hls.loadSource(url);
    hls.attachMedia(video);

    /* 20 秒无画面自动切备用线路 */
    clearInterval(S.timer);
    S.timer = setInterval(function () {
      if (!S.playing) return;
      var v = $("#vid");
      if (v.paused) {
        v.play().catch(function () { });
        S.lastTick = Date.now();
        return;
      }
      if (Date.now() - S.lastTick < 20000) return;
      if (S.line !== "main" || S.switched) return;
      var cur = findRow(S.playing.type, S.playing.slug);
      if (!cur || cur.type === "custom") return;
      S.switched = true;
      S.line = "backup";
      toast("20 秒无画面，自动切换备用线路");
      startPlay(cur, "backup");
    }, 2000);
  }

  function stopPlay() {
    exitPlayer();
    destroyHls();
    S.playing = null;
    S.line = "main";
    S.switched = false;
    $("#idle").classList.remove("hide");
    setPlayState("未播放");
    renderInfo(); renderList();
  }

  $("#vid").addEventListener("timeupdate", function () {
    var v = $("#vid");
    if (!v.paused && v.currentTime > 0) S.lastTick = Date.now();
  });

  $("#btnPlay").addEventListener("click", function () {
    var row = findSelected();
    if (!row) { toast("先在左侧选一个频道", true); return; }
    var isPlaying = S.playing && S.playing.slug === row.slug && S.playing.type === row.type;
    if (isPlaying) { stopPlay(); toast("已停止"); return; }
    startPlay(row);
    enterPlayer();
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

  $("#btnCopy").addEventListener("click", function () {
    var input = $("#subUrl");
    input.select(); input.setSelectionRange(0, 99999);
    var done = function () { toast("订阅地址已复制"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(done).catch(function () { document.execCommand("copy"); done(); });
    } else { document.execCommand("copy"); done(); }
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
    var el = $("#screen");
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    if (el.requestFullscreen) el.requestFullscreen({ navigationUI: "hide" });
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
    var ch = qs.get("ch");
    var row = ch ? (findRow("builtin", ch) || findRow("custom", ch)) : null;
    if (row) {
      S.selected = { type: row.type, slug: row.slug };
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

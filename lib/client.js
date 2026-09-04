window.__ModuleLoader__.load({ id: "dsh-restart-plugin", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

// ---------------------------------------------------------------------------
// DSH 重启按钮（零依赖 DOM 实现）：
//   展开态：与侧边栏底部「设置」按钮同一行（垂直居中、右缘对齐），
//           [↻ 重启] 图标+文字，白底黑字灰框，无阴影。
//   收起态：侧边栏设置图标正上方 —— 36x36 纯图标按钮（无文字）。
//   收起判定：侧边栏根容器类名优先、宽度兜底（不依赖设置按钮文本）。
//   点击 -> POST /_dsh/dsh-restart/trigger；触发后页面字体变浅灰、图片去色。
//   重启完成（done+success 且本次页面经历过流程）-> 原页面自动刷新并
//   经 sessionStorage 接力显示「重启成功」toast。
// ---------------------------------------------------------------------------
const inject = [];
const STATE_ROUTE = "/_dsh/dsh-restart/state";
const TRIGGER_ROUTE = "/_dsh/dsh-restart/trigger";
const BTN_ATTR = "data-dsh-restart-btn";
const ICON_ATTR = "data-dsh-restart-icon";
const STYLE_ID = "dsh-restart-style";

// Feather refresh-cw：圆弧 + 箭头，代表重启
function iconSvg(size) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
    '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" data-spin="1" ' +
    'style="display:block;pointer-events:none;transform-origin:50% 50%;">' +
    '<polyline points="23 4 23 10 17 10"></polyline>' +
    '<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>' +
    '</svg>';
}

// ---------------------------------------------------------------------------
// v17 锚点加固：第三方插件（如 dsh-worktable 的 .dsh-wt_* UI）会向侧边栏
// 注入自己的按钮，几何启发式会被带偏。三层保险：
//   1) 特征排除：自身/祖先类名命中第三方前缀（dsh-wt 等）的候选一律跳过；
//   2) 兜底从「最宽」改为「最靠底」——设置按钮恒是侧边栏最底部的按钮，
//      宽度比较会被更宽的第三方面板按钮赢走；
//   3) 位置记忆锚：精确识别到「设置」按钮时记录其位置（跨 HMR 实例存活，
//      挂在 window 上），识别失败时按「位置最接近」恢复——React 重渲染
//      后按钮位置不变，第三方注入按钮的位置偏离大，不会误召回。
// ---------------------------------------------------------------------------
const FOREIGN_CLASS_PATTERNS = [/dsh-wt/];

function isForeignBtn(el) {
  let node = el;
  while (node && node !== document.body) {
    const cn = typeof node.className === "string" ? node.className : "";
    for (const p of FOREIGN_CLASS_PATTERNS) if (p.test(cn)) return true;
    node = node.parentElement;
  }
  return false;
}

// 位置记忆：跨 HMR 实例挂在 window 上（DOMRect 不可比较，只存字段值）。
function rememberAnchor(r) {
  try {
    window.__dshRestartAnchorMemo = { x: r.x, y: r.y, w: r.width, h: r.height };
  } catch (e) { /* 忽略 */ }
}

// 按位置记忆恢复锚点：在侧边栏根内找与记忆位置最接近的可见按钮
// （垂直差 < 30px、水平有重叠、仍处底部锚区，三者都满足才认）。
function recallAnchor() {
  try {
    const memo = window.__dshRestartAnchorMemo;
    if (!memo) return null;
    const root = document.querySelector(".hHd-Xa_root");
    if (!root) return null;
    const rr = root.getBoundingClientRect();
    let best = null;
    for (const b of document.querySelectorAll("button")) {
      if (b.hasAttribute(BTN_ATTR) || b.hasAttribute(ICON_ATTR)) continue;
      if (isForeignBtn(b)) continue;
      const r = b.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue;
      if (r.top < rr.top + rr.height * 0.6) continue;
      const dTop = Math.abs(r.top - memo.y);
      if (dTop > 30) continue;
      if (r.right < memo.x || r.left > memo.x + memo.w) continue;
      if (!best || dTop < best.d) best = { el: b, d: dTop };
    }
    return best ? best.el.getBoundingClientRect() : null;
  } catch (e) { return null; }
}

function apply(ctx) {
  if (typeof document === "undefined" || typeof window === "undefined") return;

  // 单例互斥：HMR 热替换会叠加多个插件实例，各实例每秒互相清理对方
  // 的按钮导致闪烁。新实例 apply 前先完整销毁旧实例（dispose 幂等）。
  if (typeof window.__dshRestartDispose === "function") {
    try { window.__dshRestartDispose(); } catch (e) { /* 忽略 */ }
  }

  let restarting = false;   // 已触发、重启进行中（保持灰色）
  let failed = false;       // 上次触发失败/自检失败
  let sawRestartFlow = false; // 本次页面生命周期内经历过重启流程（用于完成时自动刷新）
  let optimisticUntil = 0;   // 乐观变灰窗口截止时间戳（防御 live 文件陈旧导致的历史 done 撤销变灰）
  let wideBtn = null;       // 展开态：body 上、设置按钮右侧按钮
  let railBtn = null;       // 收起态：body 上的图标按钮
  let railProbe = null;     // 收起态探针：透明 44x40 占位，供第三方底部测量器（worktable）识别
  let wideLabel = null;     // wideBtn 当前文案缓存（避免每秒重建 DOM 闪烁）
  let timers = [];
  let noticeTimer = null;   // 跨刷新提示检查定时器（dispose 时清理）
  let rootEl = null;        // 当前观察的侧边栏根
  let settingsEl = null;    // 当前观察的设置按钮
  let roRoot = null;        // root ResizeObserver（收起/展开动画每帧对齐）
  let roSettings = null;    // settings ResizeObserver
  let moRoot = null;        // root class MutationObserver（切换瞬间响应）
  let cachedRoot = null;    // layout 缓存：侧边栏根（React 重建后 isConnected=false 触发重查）
  let cachedSettings = null; // layout 缓存：设置按钮
  const every = (fn, ms) => { const t = setInterval(fn, ms); timers.push(t); return t; };

  // fetch 带超时：宿主无响应时避免状态永久卡在 pending
  function fetchJson(url, opts, timeoutMs) {
    let ctrl = null;
    let timer = null;
    if (typeof AbortController !== "undefined" && opts) {
      ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), timeoutMs);
    }
    try {
      return fetch(url, Object.assign({}, opts, ctrl ? { signal: ctrl.signal } : {}))
        .finally(() => { if (timer) clearTimeout(timer); });
    } catch (e) {
      if (timer) clearTimeout(timer);
      return Promise.reject(e);
    }
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent =
      "@keyframes dsh-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}" +
      // 重启倒计时期间：页面字体统一浅灰（含输入框、占位符），图片/视频去色变淡。
      // 不把 filter 挂在 body/html 上，避免产生 containing block 影响 fixed 按钮定位。
      "body.dsh-restart-pending *{color:#9aa1ab !important;-webkit-text-fill-color:#9aa1ab !important;}" +
      "body.dsh-restart-pending *::placeholder{color:#b8bdc5 !important;}" +
      "body.dsh-restart-pending img,body.dsh-restart-pending video{filter:grayscale(1);opacity:0.7;}" +
      // 豁免：重启按钮自身不跟着变灰（同权重规则，后出现者胜）。
      // 失败红色由 data-failed 属性驱动（!important 会压过内联样式）。
      "body.dsh-restart-pending [data-dsh-restart-btn],body.dsh-restart-pending [data-dsh-restart-btn] *{color:#444b58 !important;-webkit-text-fill-color:#444b58 !important;}" +
      "body.dsh-restart-pending [data-dsh-restart-icon],body.dsh-restart-pending [data-dsh-restart-icon] *{color:rgb(15,17,21) !important;-webkit-text-fill-color:rgb(15,17,21) !important;}" +
      "body.dsh-restart-pending [data-dsh-restart-btn][data-failed],body.dsh-restart-pending [data-dsh-restart-btn][data-failed] *{color:#c0392b !important;-webkit-text-fill-color:#c0392b !important;}" +
      "body.dsh-restart-pending [data-dsh-restart-icon][data-failed],body.dsh-restart-pending [data-dsh-restart-icon][data-failed] *{color:#c0392b !important;-webkit-text-fill-color:#c0392b !important;}" +
      // 重启成功提示 toast 滑入动画
      "@keyframes dsh-toast-in{from{transform:translateX(120%);opacity:0}to{transform:translateX(0);opacity:1}}";
    (document.head || document.documentElement).appendChild(st);
  }

  function setPending(on) {
    const c = "dsh-restart-pending";
    if (on) document.body.classList.add(c);
    else document.body.classList.remove(c);
  }

  // 重启成功提示：右上角绿色对勾 toast，滑入后约 4 秒自动淡出，点击可立即关闭
  function showSuccessToast() {
    const wrap = document.createElement("div");
    wrap.setAttribute("data-dsh-restart-toast", "1");
    wrap.style.cssText =
      "position:fixed;top:20px;right:20px;z-index:2147483000;display:flex;" +
      "align-items:center;gap:12px;background:#ffffff;color:#1a1d24;border-radius:14px;" +
      "padding:14px 18px;box-shadow:0 10px 34px rgba(0,0,0,0.18);border:1px solid rgba(11,122,75,0.25);" +
      "font-family:system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;cursor:pointer;" +
      "animation:dsh-toast-in 0.35s ease;transition:opacity 0.5s ease,transform 0.5s ease;";
    wrap.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" style="flex:none;">' +
      '<circle cx="12" cy="12" r="11" fill="#0b7a4b"></circle>' +
      '<polyline points="7 12.5 10.5 16 17 8.5" stroke="#ffffff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"></polyline></svg>' +
      '<div><div style="font-size:15px;font-weight:700;line-height:1.3;">重启成功</div>' +
      '<div style="font-size:12px;color:#5b6472;margin-top:3px;">自检通过：端口 3080 · /modlens/paste · /</div></div>';
    let done = false;
    const dismiss = () => {
      if (done) return;
      done = true;
      wrap.style.opacity = "0";
      wrap.style.transform = "translateX(24px)";
      setTimeout(() => { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 500);
    };
    wrap.onclick = dismiss;
    document.body.appendChild(wrap);
    setTimeout(dismiss, 4200);
  }

  // 检查跨刷新接力标记：reload 前写入的「重启成功」提示
  function checkNotice() {
    try {
      if (sessionStorage.getItem("dsh-restart-notice") === "1") {
        sessionStorage.removeItem("dsh-restart-notice");
        showSuccessToast();
      }
    } catch (e) { /* 忽略 */ }
  }

  function paint(el) {
    if (!el) return;
    el.disabled = restarting;
    el.style.cursor = restarting ? "not-allowed" : "pointer";
    // 重启中不降透明度：保持 100% 正常视觉，状态由文案 + 图标旋转表达
    el.style.opacity = "1";
    el.toggleAttribute("data-failed", failed);
    if (el === railBtn) {
      // 收起态：与设置图标同风格（圆形、无边框、透明底），失败时图标变红
      el.style.color = failed ? "#c0392b" : "rgb(15,17,21)";
    } else {
      el.style.borderColor = failed ? "#c0392b" : "rgba(120,130,150,0.45)";
    }
    const spin = el.querySelector("[data-spin]");
    if (spin) spin.style.animation = restarting ? "dsh-spin 1s linear infinite" : "none";
  }

  function findRoot() {
    return document.querySelector(".hHd-Xa_root") || null;
  }

  // 布局查询缓存：React 重渲染会替换节点，isConnected=false 时重新查找
  function getRoot() {
    if (cachedRoot && cachedRoot.isConnected) return cachedRoot;
    cachedRoot = findRoot();
    return cachedRoot;
  }

  function getSettingsBtn() {
    if (cachedSettings && cachedSettings.isConnected) return cachedSettings;
    cachedSettings = findSettingsBtn();
    return cachedSettings;
  }

  function findSettingsBtn() {
    // v17：先排除第三方插件按钮（dsh-worktable 等注入的 .dsh-wt_* 按钮），
    // 防止几何启发式被带偏。
    const candidates = [...document.querySelectorAll("button")].filter((b) => !isForeignBtn(b));
    // 1) 精确匹配：文本/aria-label/title 为「设置」或含 settings
    for (const b of candidates) {
      const t = (b.textContent || "").trim();
      const a = (b.getAttribute("aria-label") || "") + "|" + (b.getAttribute("title") || "");
      if (t === "设置" || a === "设置" || a.indexOf("设置") >= 0 || /settings/i.test(a)) {
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          rememberAnchor(r);
          return b;
        }
      }
    }
    // 2) 文本包含「设置」（图标+文字混排、带省略号等变体）
    for (const b of candidates) {
      const t = (b.textContent || "").replace(/\s+/g, "");
      if (t.includes("设置") || /settings/i.test(t)) {
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          rememberAnchor(r);
          return b;
        }
      }
    }
    // 3) 兜底：原生侧边栏底部四分之一区域内「最靠底」的按钮。
    //    v17 改动：设置按钮恒是侧边栏最底部的按钮；旧版比「最宽」会被
    //    更宽的第三方按钮（如 worktable 的面板按钮）赢走，导致锚点错行。
    const root = getRoot();
    if (root) {
      const rr = root.getBoundingClientRect();
      let best = null;
      for (const b of candidates) {
        const r = b.getBoundingClientRect();
        if (r.height > 0 && r.top >= rr.top + rr.height * 0.75 && r.left >= rr.left - 1 && r.right <= rr.right + 1) {
          if (!best || r.bottom > best.bottom) best = { el: b, bottom: r.bottom };
        }
      }
      if (best) return best.el;
    }
    return null;
  }

  function removeWide() {
    if (wideBtn && wideBtn.parentNode) wideBtn.parentNode.removeChild(wideBtn);
    wideBtn = null;
    wideLabel = null;
  }

  function removeRail() {
    if (railBtn && railBtn.parentNode) railBtn.parentNode.removeChild(railBtn);
    railBtn = null;
    if (railProbe && railProbe.parentNode) railProbe.parentNode.removeChild(railProbe);
    railProbe = null;
  }

  // 展开态按钮挂在 body 上（React 树外）：侧边栏每秒重渲染会话时间，
  // 若插在设置按钮内部会被 React 清掉再重建，表现为图标闪烁。
  // 这里按锚点 rect 实时对齐：优先设置按钮；识别失败时按位置记忆恢复
  // （v17：第三方插件按钮挤进侧边栏后，几何兜底可能失效或被带偏，
  // 位置记忆是最后一道保险）；都没有时按侧边栏根兜底。
  // v12 定位改动：按钮悬浮在锚点正上方 8px、右缘对齐锚点右缘-8px，
  // 不再与设置按钮重叠（旧版叠在设置按钮中下区，部分界面下不可见）。
  function anchorRect() {
    const sb = getSettingsBtn();
    if (sb) return sb.getBoundingClientRect();
    const recalled = recallAnchor();
    if (recalled && recalled.width > 0 && recalled.height > 0) return recalled;
    const root = getRoot();
    if (root) {
      const rr = root.getBoundingClientRect();
      if (rr.width > 0 && rr.height > 0) {
        return { left: rr.left, right: rr.right, top: rr.bottom - 60, height: 42, width: rr.width };
      }
    }
    return null;
  }

  function repositionWide(rect) {
    if (!wideBtn || !rect) return;
    const w = wideBtn.offsetWidth || 61;
    // 与设置按钮同一行：右缘对齐锚点右缘 -8px、垂直居中（水平对齐）
    wideBtn.style.left = Math.round(rect.right - 8 - w) + "px";
    wideBtn.style.top = Math.round(rect.top + (rect.height - 26) / 2) + "px";
  }

  function ensureWide() {
    if (!wideBtn) {
      const btn = document.createElement("button");
      btn.setAttribute(BTN_ATTR, "1");
      btn.type = "button";
      btn.title = "重启 DSH 环境";
      btn.style.cssText =
        "position:fixed;height:26px;padding:0 10px 0 7px;border-radius:8px;" +
        "border:1px solid rgba(120,130,150,0.45);background:#ffffff;" +
        "color:#1a1d24;font-size:12px;font-weight:600;line-height:24px;cursor:pointer;z-index:2147483000;" +
        "font-family:inherit;white-space:nowrap;display:flex;align-items:center;gap:4px;" +
        "transition:background 0.15s ease;";
      btn.onclick = (ev) => { ev.stopPropagation(); ev.preventDefault(); triggerRestart(); };
      btn.addEventListener("mouseenter", () => { if (!restarting) btn.style.background = "rgba(0,0,0,0.06)"; });
      btn.addEventListener("mouseleave", () => { btn.style.background = "#ffffff"; });
      document.body.appendChild(btn);
      wideBtn = btn;
      wideLabel = null;
    }
    updateLabel();
    repositionWide(anchorRect());
    paint(wideBtn);
  }

  function ensureRail(root) {
    if (!railBtn) {
      const btn = document.createElement("button");
      btn.setAttribute(ICON_ATTR, "1");
      btn.type = "button";
      btn.title = "重启 DSH 环境";
      btn.style.cssText =
        "position:fixed;width:36px;height:36px;padding:0;border-radius:50%;" +
        "border:none;background:transparent;color:rgb(15,17,21);cursor:pointer;z-index:2147483000;" +
        "display:flex;align-items:center;justify-content:center;transition:background 0.15s ease;";
      btn.innerHTML = iconSvg(18);   // 纯图标，无文字，与设置齿轮同为 18px
      btn.onclick = (ev) => { ev.stopPropagation(); ev.preventDefault(); triggerRestart(); };
      btn.addEventListener("mouseenter", () => { if (!restarting) btn.style.background = "rgba(0,0,0,0.08)"; });
      btn.addEventListener("mouseleave", () => { btn.style.background = "transparent"; });
      document.body.appendChild(btn);
      railBtn = btn;
    }
    // 位置：设置图标（收起态 36x36，位于侧边栏底部、距底 16px）正上方 6px。
    // 相对根容器：bottom = 16(底距) + 36(设置) + 6(间隙) = 58px。
    if (root) {
      const rr = root.getBoundingClientRect();
      railBtn.style.position = "fixed";
      railBtn.style.left = Math.round(rr.left + rr.width / 2 - 18) + "px";
      railBtn.style.top = Math.round(rr.top + rr.height - 58 - 36) + "px";
      railBtn.style.bottom = "auto";
      railBtn.style.transform = "none";
    } else {
      // 兜底：侧边栏根缺失时固定在视口左下角（距左 12px、距底 16px）
      railBtn.style.position = "fixed";
      railBtn.style.left = "12px";
      railBtn.style.top = "auto";
      railBtn.style.bottom = "16px";
      railBtn.style.transform = "none";
    }
    paint(railBtn);
    // v18 底部探针：第三方插件（dsh-worktable 等）靠扫描「侧边栏区域内
    // position:fixed 的底部元素」测量避让，且过滤条件是 width>=40、
    // height>=16、可见。重启图标 36px 宽不达阈值，收起态 railBox 因此
    // 与图标重叠。放一个覆盖图标区域的透明探针（44x40、无背景、
    // pointer-events:none，默认 opacity=1 不触发 "opacity===0" 过滤），
    // 让第三方测量器把 railBox 自动上移到图标之上；展开态移除。
    if (!railProbe) {
      railProbe = document.createElement("div");
      railProbe.setAttribute("data-dsh-restart-probe", "1");
      railProbe.style.cssText =
        "position:fixed;width:44px;height:40px;background:transparent;" +
        "pointer-events:none;z-index:2147482999;border:none;margin:0;padding:0;";
      document.body.appendChild(railProbe);
    }
    const br = railBtn.getBoundingClientRect();
    railProbe.style.position = "fixed";
    railProbe.style.left = Math.round(br.left - 4) + "px";
    railProbe.style.top = Math.round(br.top) + "px";
    railProbe.style.bottom = "auto";
  }

  function updateLabel() {
    if (!wideBtn) return;
    const label = restarting ? "重启中…" : (failed ? "重启失败·重试" : "重启");
    if (label !== wideLabel) {
      wideLabel = label;
      wideBtn.innerHTML = iconSvg(14) + "<span>" + label + "</span>";
      // 文案宽度变化后立即重算坐标，消除按钮右缘短暂凸出的偏移
      repositionWide(anchorRect());
    }
  }

  function triggerRestart() {
    if (restarting) return;
    failed = false;
    // 乐观反馈：点击立即进入重启中状态（页面变灰 + 文案「重启中…」），
    // 不等待网络响应，点击必有可见反馈。POST 失败时再恢复并标红。
    restarting = true;
    setPending(true);
    optimisticUntil = Date.now() + 20000; // 20 秒乐观窗口
    updateLabel();
    try { console.info("[dsh-restart] button clicked -> POST " + TRIGGER_ROUTE); } catch (e) { /* 忽略 */ }
    fetchJson(TRIGGER_ROUTE, { method: "POST", credentials: "same-origin", cache: "no-store" }, 8000)
      .then((res) => (res && res.ok ? res.json() : null))
      .then((res) => {
        if (res && res.ok) {
          // 已触发：保持 restarting 状态，pollState 会持续更新进度
          try { console.info("[dsh-restart] trigger ok:", res && res.task, res && res.seconds + "s"); } catch (e) { /* 忽略 */ }
        } else {
          restarting = false;
          failed = true;
          setPending(false);
          updateLabel();
          try { console.warn("[dsh-restart] trigger rejected:", res); } catch (e) { /* 忽略 */ }
        }
      })
      .catch((err) => {
        restarting = false;
        failed = true;
        setPending(false);
        updateLabel();
        try { console.warn("[dsh-restart] trigger fetch error:", err && err.name); } catch (e) { /* 忽略 */ }
      });
  }

  function pollState() {
    fetchJson(STATE_ROUTE + "?t=" + Date.now(), { cache: "no-store", credentials: "same-origin" }, 5000)
      .then((res) => (res && res.ok ? res.json() : null))
      .then((data) => {
        if (!data || !data.ok) return;
        const live = data.live;
        if (!live) return;
        if (live.state === "countdown" || live.state === "stopping" || live.state === "booting") {
          restarting = true;
          sawRestartFlow = true;
          setPending(true);
          updateLabel();
        } else if (live.state === "done") {
          // 乐观窗口内：忽略历史 done（live 文件可能陈旧，点击后的变灰不能被撤销）
          if (restarting && Date.now() < optimisticUntil) return;
          optimisticUntil = 0;
          restarting = false;
          setPending(false);
          failed = live.success !== true;
          updateLabel();
          // 原页面重启：本次页面经历过重启流程且自检成功后，自动刷新当前标签页。
          // 条件含 sawRestartFlow，避免每次加载都因历史 done 状态而无限刷新。
          if (live.success === true && sawRestartFlow) {
            // 刷新前写入接力标记：新页面加载后显示「重启成功」提示（sessionStorage 跨刷新存活）
            try { sessionStorage.setItem("dsh-restart-notice", "1"); } catch (e) { /* 忽略 */ }
            try { window.location.reload(); } catch (e) { /* 忽略 */ }
          }
        }
      })
      .catch(() => { /* 宿主不可达（重启中）时保持现状 */ });
  }

  // 即时布局：按当前侧边栏状态摆放/切换按钮（由观察器与 1s 兜底共同驱动）
  function layout() {
    if (!document.body) return;
    // 清理其他实例残留
    for (const q of ["[" + BTN_ATTR + "]", "[" + ICON_ATTR + "]"]) {
      const el = document.querySelector(q);
      if (el && el !== wideBtn && el !== railBtn && el.parentNode) el.parentNode.removeChild(el);
    }
    const root = getRoot();
    const settingsBtn = getSettingsBtn();
    let collapsed = false;
    if (root) {
      const rr = root.getBoundingClientRect();
      // 类名判定优先（React 状态切换瞬间生效），宽度兜底，避免动画中间态抖动
      collapsed = root.classList.contains("hHd-Xa_collapsed") || (rr.width > 0 && rr.width < 60);
    } else if (settingsBtn) {
      const sr = settingsBtn.getBoundingClientRect();
      collapsed = sr.width > 0 && sr.width < 60;
    }
    if (collapsed) {
      removeWide();
      ensureRail(root);
    } else {
      removeRail();
      // 展开态：设置按钮或侧边栏根都可用作锚点，找不到时也展示按钮
      ensureWide();
    }
  }

  // 观察器：收起/展开 class 变化瞬间切换按钮形态；动画期间 ResizeObserver
  // 每帧重算坐标，按钮平滑跟随，不再出现半秒偏移后归位。
  function ensureObservers() {
    const root = getRoot();
    if (root !== rootEl) {
      rootEl = root;
      if (roRoot) { roRoot.disconnect(); roRoot = null; }
      if (moRoot) { moRoot.disconnect(); moRoot = null; }
      if (root) {
        roRoot = new ResizeObserver(() => layout());
        roRoot.observe(root);
        moRoot = new MutationObserver(() => layout());
        moRoot.observe(root, { attributes: true, attributeFilter: ["class"] });
      }
    }
    const sb = getSettingsBtn();
    if (sb !== settingsEl) {
      settingsEl = sb;
      if (roSettings) { roSettings.disconnect(); roSettings = null; }
      if (sb) {
        roSettings = new ResizeObserver(() => layout());
        roSettings.observe(sb);
      }
    }
  }

  function tick() {
    if (!document.body) return;
    ensureObservers();
    layout();
    pollState();
  }

  function mount() {
    if (!document.body) return;
    ensureStyle();
    tick();
    every(tick, 1000);
    // 稍后检查跨刷新提示标记，避免与应用初始渲染抢位
    noticeTimer = setTimeout(checkNotice, 1500);
  }

  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });

  try { console.info("[dsh-restart] client v16 mounted (optimistic gray window, live-path hardened, black inline-row button)"); } catch (e) { /* 忽略 */ }

  const dispose = () => {
    for (const t of timers) clearInterval(t);
    timers = [];
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
    if (roRoot) { roRoot.disconnect(); roRoot = null; }
    if (roSettings) { roSettings.disconnect(); roSettings = null; }
    if (moRoot) { moRoot.disconnect(); moRoot = null; }
    rootEl = null;
    settingsEl = null;
    cachedRoot = null;
    cachedSettings = null;
    setPending(false);
    removeWide();
    removeRail();
    const st = document.getElementById(STYLE_ID);
    if (st && st.parentNode) st.parentNode.removeChild(st);
    if (window.__dshRestartDispose === dispose) window.__dshRestartDispose = null;
  };
  window.__dshRestartDispose = dispose;
  return dispose;
}

exports.apply = apply;
exports.inject = inject;

return module.exports; } });

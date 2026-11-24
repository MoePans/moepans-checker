document.addEventListener("DOMContentLoaded", () => {
  const passiveToggle = document.getElementById("passiveToggle");
  const activeToggle = document.getElementById("activeToggle");
  const statOk = document.getElementById("statOk");
  const statDead = document.getElementById("statDead");
  const logList = document.getElementById("logList");
  const copyLogsBtn = document.getElementById("copyLogsBtn");
  const exportLogsBtn = document.getElementById("exportLogsBtn");
  const clearLogsBtn = document.getElementById("clearLogsBtn");
  const previewCard = document.getElementById("previewCard");
  const previewTitle = document.getElementById("previewTitle");
  const previewMeta = document.getElementById("previewMeta");
  const previewList = document.getElementById("previewList");

  let currentLogs = [];
  let currentSettings = null;

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function formatSize(bytes) {
    const val = Number(bytes || 0);
    if (!val || val <= 0) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let sz = val;
    let idx = 0;
    while (sz >= 1024 && idx < units.length - 1) {
      sz /= 1024;
      idx++;
    }
    return idx >= 2 ? `${sz.toFixed(2)} ${units[idx]}` : `${Math.round(sz)} ${units[idx]}`;
  }

  function renderSettings(cfg) {
    if (!cfg) return;
    currentSettings = cfg;
    passiveToggle.checked = Boolean(cfg.passiveEnabled);
    activeToggle.checked = Boolean(cfg.activeEnabled);
    const s = cfg.stats || {};
    statOk.textContent = String((s.passiveOk || 0) + (s.activeOk || 0));
    statDead.textContent = String((s.passiveDead || 0) + (s.activeDead || 0));
  }

  function renderPreview(p) {
    if (!p || (!Array.isArray(p.fileTree) || p.fileTree.length === 0) && !p.shareAuthor && !p.totalSize) {
      previewCard.style.display = "none";
      return;
    }
    previewCard.style.display = "block";
    const items = Array.isArray(p.fileTree) ? p.fileTree : [];
    previewTitle.textContent = `最近采样目录预览 (${p.panType || "-"} #${p.slug || "-"})`;
    const metaParts = [];
    if (p.shareAuthor) metaParts.push(`分享者: ${escapeHtml(p.shareAuthor)}`);
    if (p.totalSize > 0) metaParts.push(`大小: ${escapeHtml(formatSize(p.totalSize))}`);
    metaParts.push(`共 ${items.length} 项`);
    previewMeta.innerHTML = metaParts.map((m) => `<span>${m}</span>`).join("");
    if (items.length === 0) {
      previewList.innerHTML = '<div class="empty">无根目录列表</div>';
    } else {
      previewList.innerHTML = items
        .map((it) => {
          const icon = it.is_dir ? "📁" : "📄";
          const sz = formatSize(it.size);
          const pad = Math.min(5, Number(it.depth || 0)) * 12;
          return `<div class="tree-item" style="padding-left:${pad}px"><span class="tree-name" title="${escapeHtml(it.path || it.name)}">${icon} ${escapeHtml(it.name)}</span>${sz ? `<span class="tree-size">${escapeHtml(sz)}</span>` : ""}</div>`;
        })
        .join("");
    }
  }

  function formatLogsText(logs) {
    const manifest = chrome?.runtime?.getManifest ? chrome.runtime.getManifest() : { name: "MoePans 测活助手", version: "unknown" };
    const tzOffsetMin = -new Date().getTimezoneOffset();
    const tzSign = tzOffsetMin >= 0 ? "+" : "-";
    const tzH = Math.floor(Math.abs(tzOffsetMin) / 60);
    const tzM = Math.abs(tzOffsetMin) % 60;
    const tzStr = `UTC${tzSign}${tzH}${tzM ? ":" + String(tzM).padStart(2, "0") : ""}`;
    const platform = navigator.userAgentData?.platform || navigator.platform || "unknown";
    const mobile = navigator.userAgentData?.mobile ? "Mobile" : "Desktop";
    const s = currentSettings?.stats || {};
    const header = [
      "=== MoePans 测活助手 诊断日志 ===",
      `Extension: ${manifest.name} v${manifest.version}`,
      `ExportedAt: ${new Date().toISOString()} (${tzStr})`,
      `Device: ${mobile} / ${platform} / ${navigator.language || "unknown"}`,
      `UserAgent: ${navigator.userAgent || "unknown"}`,
      `Settings: passiveEnabled=${Boolean(currentSettings?.passiveEnabled)}, activeEnabled=${Boolean(currentSettings?.activeEnabled)}`,
      `Stats: ok=${(s.passiveOk || 0) + (s.activeOk || 0)}, dead=${(s.passiveDead || 0) + (s.activeDead || 0)}, logCount=${logs.length}`,
      "=================================="
    ].join("\n");
    const lines = logs
      .map((l) => `[${l.iso || l.time}] [${l.mode}] [${l.panType || "-"}] #${l.slug || "-"} result=${l.result} http=${l.httpStatus ?? "-"} code=${l.rawCode || "-"} server=${l.serverAccepted ? l.serverStatus : "rejected:" + (l.serverStatus || "")} author=${l.shareAuthor || "-"} size=${l.totalSize || 0} tree=${l.treeCount || 0} msg=${l.message || ""} url=${l.shareUrl || ""} api=${l.requestUrl || "-"}`)
      .join("\n");
    return `${header}\n${lines}\n`;
  }

  function renderLogs(logs) {
    currentLogs = Array.isArray(logs) ? logs : [];
    if (!currentLogs.length) {
      logList.innerHTML = '<div class="empty">暂无测活日志</div>';
      return;
    }
    logList.innerHTML = currentLogs
      .map((l) => {
        const cls = l.result === "ok" ? "badge-ok" : (l.result === "dead" ? "badge-dead" : "badge-uncertain");
        const tag = l.result === "ok" ? "OK" : (l.result === "dead" ? "DEAD" : "UNCERTAIN");
        const srv = l.serverAccepted ? `回传:${l.serverStatus || "ok"}` : `回传失败:${l.serverStatus || ""}`;
        const extra = [
          l.shareAuthor ? `分享者:${l.shareAuthor}` : "",
          l.totalSize > 0 ? `大小:${formatSize(l.totalSize)}` : "",
          l.treeCount > 0 ? `目录:${l.treeCount}项` : ""
        ].filter(Boolean).join(" · ");
        return `<div class="log-item">
          <div><span class="badge ${cls}">${tag}</span><span>[${escapeHtml(l.time)}] ${escapeHtml(l.mode)} · ${escapeHtml(l.panType || "-")} · #${escapeHtml(l.slug || "-")}</span></div>
          <div>HTTP ${escapeHtml(l.httpStatus ?? "-")} · code=${escapeHtml(l.rawCode || "-")} · ${escapeHtml(l.message || "")}</div>
          ${extra ? `<div class="muted">${escapeHtml(extra)}</div>` : ""}
          <div class="muted">${escapeHtml(srv)} · ${escapeHtml((l.shareUrl || "").slice(0, 48))}</div>
        </div>`;
      })
      .join("");
  }

  chrome.runtime.sendMessage({ action: "GET_SETTINGS" }, renderSettings);
  chrome.runtime.sendMessage({ action: "GET_LAST_PREVIEW" }, renderPreview);
  chrome.runtime.sendMessage({ action: "GET_LOGS" }, renderLogs);

  passiveToggle.addEventListener("change", () => {
    chrome.runtime.sendMessage(
      { action: "UPDATE_SETTINGS", patch: { passiveEnabled: passiveToggle.checked } },
      renderSettings
    );
  });

  activeToggle.addEventListener("change", () => {
    chrome.runtime.sendMessage(
      { action: "UPDATE_SETTINGS", patch: { activeEnabled: activeToggle.checked } },
      renderSettings
    );
  });

  copyLogsBtn.addEventListener("click", () => {
    if (!currentLogs.length) return;
    navigator.clipboard.writeText(formatLogsText(currentLogs)).then(() => {
      copyLogsBtn.textContent = "已复制";
      setTimeout(() => { copyLogsBtn.textContent = "复制"; }, 1800);
    });
  });

  exportLogsBtn.addEventListener("click", () => {
    if (!currentLogs.length) return;
    const blob = new Blob([formatLogsText(currentLogs)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `moepans-checker-logs-${Date.now()}.log`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  clearLogsBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "CLEAR_LOGS" }, () => renderLogs([]));
  });
});

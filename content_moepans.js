/**
 * MoePans 页面通信桥梁 (Content Script) v1.0.7
 * 仅在检测到 <meta name="moepans-crowd-check" content="1"> 的 MoePans 站点激活
 */
(function () {
  const marker = document.querySelector('meta[name="moepans-crowd-check"]');
  if (!marker) return;

  function safeSendMessage(payload, cb) {
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.id) return;
      if (typeof cb === "function") {
        chrome.runtime.sendMessage(payload, cb);
      } else {
        chrome.runtime.sendMessage(payload);
      }
    } catch {}
  }

  function broadcastReady() {
    safeSendMessage({ action: "GET_SETTINGS" }, (cfg) => {
      if (chrome.runtime.lastError || !cfg) return;
      window.postMessage(
        {
          type: "MOEPANS_EXTENSION_READY",
          version: "1.2.13",
          passiveEnabled: Boolean(cfg.passiveEnabled),
          activeEnabled: Boolean(cfg.activeEnabled)
        },
        "*"
      );
    });
  }

  broadcastReady();

  // 接收来自 MoePans 网页的消息
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || typeof event.data !== "object") return;
    const msg = event.data;

    if (msg.type === "MOEPANS_PING_EXTENSION") {
      broadcastReady();
    } else if (msg.type === "MOEPANS_TRACK_OUTBOUND") {
      safeSendMessage({
        action: "TRACK_OUTBOUND",
        origin: window.location.origin,
        slug: msg.slug,
        panType: msg.panType,
        shareUrl: msg.shareUrl
      });
    } else if (msg.type === "MOEPANS_RUN_ACTIVE_TASKS") {
      safeSendMessage({
        action: "RUN_ACTIVE_TASKS",
        origin: window.location.origin,
        tasks: msg.tasks || []
      });
    } else if (msg.type === "MOEPANS_EXPAND_FOLDER") {
      safeSendMessage({
        action: "EXPAND_FOLDER",
        origin: window.location.origin,
        slug: msg.slug,
        panType: msg.panType,
        shareUrl: msg.shareUrl,
        shareCode: msg.shareCode,
        folderPath: msg.folderPath,
        folderId: msg.folderId,
        depth: msg.depth,
        page: msg.page || 1
      });
    } else if (msg.type === "MOEPANS_SET_EXTENSION_CONFIG") {
      safeSendMessage(
        {
          action: "UPDATE_SETTINGS",
          patch: msg.patch || {}
        },
        (cfg) => {
          if (chrome.runtime.lastError || !cfg) return;
          window.postMessage(
            {
              type: "MOEPANS_EXTENSION_READY",
              version: "1.2.13",
              passiveEnabled: Boolean(cfg.passiveEnabled),
              activeEnabled: Boolean(cfg.activeEnabled)
            },
            "*"
          );
        }
      );
    }
  });

  // 接收来自 background.js 的状态更新并推给 MoePans 网页实时刷新徽章
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.action === "MOEPANS_STATUS_UPDATED" && msg.payload) {
        window.postMessage({ type: "MOEPANS_CHECK_RESULT", payload: msg.payload }, "*");
      } else if (msg && msg.action === "MOEPANS_FOLDER_EXPANDED" && msg.payload) {
        window.postMessage({ type: "MOEPANS_FOLDER_EXPANDED", payload: msg.payload }, "*");
      }
    });
  } catch {}
})();

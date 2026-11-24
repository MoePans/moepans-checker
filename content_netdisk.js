/**
 * 网盘分享页被动嗅探脚本 (零额外 API 请求) v1.0.7
 * 仅读取当前已打开页面的公开文本特征，由 background.js 严格校验是否来自 MoePans 跳转，非 MoePans 跳转绝不上报
 */
(function () {
  const DEAD_PATTERNS = [
    /分享的文件已经被取消/,
    /啊哦[，,]?你来晚了/,
    /分享已过期/,
    /分享已取消/,
    /分享已被取消/,
    /链接已失效/,
    /链接不存在/,
    /分享链接已失效/,
    /该分享已失效/,
    /不可访问/,
    /分享内容已失效/,
    /该分享已取消/,
    /此链接分享内容可能因为涉及侵权/,
    /该分享内容可能因为涉及侵权/,
    /无法访问[！!]?/,
    /文件已被删除/,
    /来晚啦.*分享已/,
    /已超过有效期/,
    /你打开的链接有误/,
    /分享不存在/
  ];

  const ALIVE_PATTERNS = [
    /请输入提取码/,
    /提取文件/,
    /保存到网盘/,
    /保存到云盘/,
    /全部文件/,
    /失效时间[：:]/,
    /存入网盘/,
    /保存到夸克/,
    /转存到/,
    /一键转存/,
    /下载文件/,
    /全选/
  ];

  function safeSendMessage(payload) {
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime.sendMessage(payload);
    } catch {}
  }

  let reported = false;

  function inspectOnce() {
    if (reported) return true;
    const text = (document.body?.innerText || "").slice(0, 6000);
    if (!text.trim()) return false;

    for (const pat of DEAD_PATTERNS) {
      const m = text.match(pat);
      if (m) {
        reported = true;
        safeSendMessage({
          action: "PASSIVE_PAGE_RESULT",
          url: window.location.href,
          result: "dead",
          message: m[0]
        });
        return true;
      }
    }

    for (const pat of ALIVE_PATTERNS) {
      if (pat.test(text)) {
        reported = true;
        safeSendMessage({
          action: "PASSIVE_PAGE_RESULT",
          url: window.location.href,
          result: "ok",
          message: "页面正常可访问"
        });
        return true;
      }
    }
    return false;
  }

  setTimeout(() => {
    if (!inspectOnce()) {
      setTimeout(() => {
        if (!inspectOnce()) {
          setTimeout(inspectOnce, 2500);
        }
      }, 1500);
    }
  }, 1200);
})();

/**
 * MoePans 测活助手 - Background Service Worker (MV3) v1.0.3
 * 双轨测活引擎 + 内置可导出排查日志（最近 100 条）：
 * 1. 被动模式（默认开启，零额外请求）：追踪从 MoePans 点击打开的网盘链接，由网盘页 DOM 识别回传
 * 2. 主动模式（可选开启，租约限量）：并发=2、带随机抖动的轻量队列，严格使用后端签发的 lease_token 回传
 */

const DEFAULT_SETTINGS = {
  passiveEnabled: true,
  activeEnabled: false,
  stats: {
    passiveOk: 0,
    passiveDead: 0,
    activeOk: 0,
    activeDead: 0
  }
};

const MAX_LOGS = 100;
const pendingVisits = new Map();
const VISIT_TTL_MS = 5 * 60 * 1000;

function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return String(raw || "").split("?")[0].replace(/\/+$/, "").toLowerCase();
  }
}

function cleanupVisits() {
  const now = Date.now();
  for (const [k, v] of pendingVisits.entries()) {
    if (now - v.ts > VISIT_TTL_MS) {
      pendingVisits.delete(k);
    }
  }
}

async function getSettings() {
  const data = await chrome.storage.local.get(["passiveEnabled", "activeEnabled", "stats"]);
  return {
    passiveEnabled: typeof data.passiveEnabled === "boolean" ? data.passiveEnabled : DEFAULT_SETTINGS.passiveEnabled,
    activeEnabled: typeof data.activeEnabled === "boolean" ? data.activeEnabled : DEFAULT_SETTINGS.activeEnabled,
    stats: { ...DEFAULT_SETTINGS.stats, ...(data.stats || {}) }
  };
}

async function bumpStat(key) {
  const cfg = await getSettings();
  cfg.stats[key] = (cfg.stats[key] || 0) + 1;
  await chrome.storage.local.set({ stats: cfg.stats });
}

async function appendLog(entry) {
  try {
    const data = await chrome.storage.local.get(["logs"]);
    const logs = Array.isArray(data.logs) ? data.logs : [];
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    logs.unshift({
      time: timeStr,
      iso: now.toISOString(),
      ...entry
    });
    if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
    await chrome.storage.local.set({ logs });
  } catch {}
}

function extractShareId(panType, shareUrl) {
  const raw = String(shareUrl || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const p = u.pathname;
    if (panType === "tianyi") {
      const qCode = u.searchParams.get("code");
      if (qCode) return qCode;
      const mHash = raw.match(/[?&#]code=([A-Za-z0-9]+)/i);
      if (mHash) return mHash[1];
      const mPath = p.match(/\/t\/([A-Za-z0-9]+)/);
      if (mPath) return mPath[1];
    }
    const m = p.match(/\/(?:s|123pan)\/([A-Za-z0-9_-]+)/i);
    if (m) return m[1];
  } catch {}
  return "";
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal, credentials: "omit" });
  } finally {
    clearTimeout(timer);
  }
}

// 通用多级目录递归采样器（最多展开 3 层、最多 8 次子目录请求、最多 80 项，避免触发网盘限流）
async function collectMultiLevelTree(rootItems, fetchChildrenFn, maxDepth = 3, maxSubReqs = 8, maxItems = 80) {
  const result = [];
  const queue = [];
  let subReqs = 0;

  for (const raw of (rootItems || [])) {
    if (result.length >= maxItems) break;
    const node = {
      name: String(raw.name || "").trim(),
      path: String(raw.name || "").trim(),
      depth: 0,
      is_dir: Boolean(raw.is_dir),
      size: Number(raw.size || 0)
    };
    if (!node.name) continue;
    result.push(node);
    if (node.is_dir && raw.id && maxDepth > 0) {
      queue.push({ id: raw.id, parentPath: node.path, depth: 1, insertAfterIdx: result.length - 1 });
    }
  }

  // BFS 逐层展开子目录并按层级顺序整理
  const childrenByParent = new Map();
  while (queue.length > 0 && subReqs < maxSubReqs && result.length < maxItems) {
    const cur = queue.shift();
    if (!cur || cur.depth > maxDepth) continue;
    subReqs++;
    let kids = [];
    try {
      kids = await fetchChildrenFn(cur.id);
    } catch {
      kids = [];
    }
    const list = [];
    for (const raw of (kids || [])) {
      if (result.length + list.length >= maxItems) break;
      const nm = String(raw.name || "").trim();
      if (!nm) continue;
      const p = `${cur.parentPath}/${nm}`;
      const node = {
        name: nm,
        path: p,
        depth: cur.depth,
        is_dir: Boolean(raw.is_dir),
        size: Number(raw.size || 0)
      };
      list.push(node);
      if (node.is_dir && raw.id && cur.depth < maxDepth) {
        queue.push({ id: raw.id, parentPath: p, depth: cur.depth + 1 });
      }
    }
    childrenByParent.set(cur.parentPath, list);
  }

  // 按深度优先顺序拼装成天然有序的树形列表
  const ordered = [];
  function emitWithKids(nodes) {
    for (const n of nodes) {
      if (ordered.length >= maxItems) break;
      ordered.push(n);
      const kids = childrenByParent.get(n.path);
      if (kids && kids.length > 0) emitWithKids(kids);
    }
  }
  emitWithKids(result);

  const totalSize = ordered.reduce((acc, x) => acc + (x.is_dir ? 0 : (Number(x.size) || 0)), 0);
  return { fileTree: ordered, totalSize };
}

async function checkQuarkOrUc(apiBase, prCode, shareId, passcode = "", shareUrl = "") {
  if (!shareId) return { result: "uncertain", rawCode: "no_id", httpStatus: 0, requestUrl: "", message: "未解析出分享码" };
  const tokenUrl = `${apiBase}/1/clouddrive/share/sharepage/token?pr=${encodeURIComponent(prCode)}&fr=pc&uc_param_str=`;
  try {
    const res = await fetchWithTimeout(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*"
      },
      body: JSON.stringify({
        pwd_id: shareId,
        passcode: passcode || "",
        support_visit_limit_private_share: true
      })
    });
    const httpStatus = res.status;
    if (httpStatus === 429 || httpStatus >= 500) {
      return { result: "uncertain", rawCode: String(httpStatus), httpStatus, requestUrl: tokenUrl, message: "网盘接口限流或繁忙" };
    }
    let data = null;
    try { data = await res.json(); } catch {}
    if (!data || typeof data !== "object" || data.code === undefined) {
      return { result: "uncertain", rawCode: `http_${httpStatus}`, httpStatus, requestUrl: tokenUrl, message: `非JSON响应(HTTP ${httpStatus})` };
    }
    const code = Number(data.code);
    if (code === 41008) {
      return { result: "ok", rawCode: "41008", httpStatus, requestUrl: tokenUrl, message: "链接有效(需提取码)" };
    }
    if ([41002, 41004, 41005, 41010, 41011, 41012].includes(code) || (typeof data.message === "string" && /失效|取消|不存在|过期|删除|不可访问|违规/.test(data.message))) {
      return { result: "dead", rawCode: String(code), httpStatus, requestUrl: tokenUrl, message: data.message || "分享已失效或取消" };
    }
    if (code !== 0) {
      return { result: "uncertain", rawCode: String(code), httpStatus, requestUrl: tokenUrl, message: data.message || `状态码 ${code}` };
    }

    const stoken = String(data?.data?.stoken || "");
    if (data?.data?.is_expire === true || !stoken) {
      return { result: "dead", rawCode: "expired_or_no_stoken", httpStatus, requestUrl: tokenUrl, message: "分享已过期或无有效令牌" };
    }

    // 第二步：调用 sharepage/detail 拉取真实文件列表，识别“token 返回 0 但实际文件已清空/失效”的假活链接
    const detailQs = new URLSearchParams({
      pr: prCode,
      fr: "pc",
      uc_param_str: "",
      pwd_id: shareId,
      stoken: stoken,
      pdir_fid: "0",
      force: "0",
      _page: "1",
      _size: "10",
      _fetch_banner: "0",
      _fetch_share: "1",
      _fetch_total: "1",
      _sort: "file_type:asc,updated_at:desc"
    });
    const detailUrl = `${apiBase}/1/clouddrive/share/sharepage/detail?${detailQs.toString()}`;
    const dRes = await fetchWithTimeout(detailUrl, {
      method: "GET",
      headers: { "Accept": "application/json, text/plain, */*" }
    });
    const dHttp = dRes.status;
    if (dHttp === 429 || dHttp >= 500) {
      return { result: "uncertain", rawCode: String(dHttp), httpStatus: dHttp, requestUrl: detailUrl, message: "详情接口限流或繁忙" };
    }
    let dData = null;
    try { dData = await dRes.json(); } catch {}
    if (!dData || typeof dData !== "object") {
      return { result: "uncertain", rawCode: `detail_http_${dHttp}`, httpStatus: dHttp, requestUrl: detailUrl, message: `详情非JSON响应(HTTP ${dHttp})` };
    }
    const dCode = Number(dData.code);
    const dMsg = String(dData.message || "");
    if ([41002, 41004, 41005, 41010, 41011, 41012].includes(dCode) || /失效|取消|不存在|过期|删除|不可访问|违规/.test(dMsg)) {
      return { result: "dead", rawCode: String(dCode), httpStatus: dHttp, requestUrl: detailUrl, message: dMsg || "分享已失效或不可访问" };
    }
    if (dCode !== 0) {
      return { result: "uncertain", rawCode: String(dCode), httpStatus: dHttp, requestUrl: detailUrl, message: dMsg || `详情状态码 ${dCode}` };
    }
    const shareMeta = dData?.data?.share || {};
    if (shareMeta.is_expire === true || Number(shareMeta.status) === 2) {
      return { result: "dead", rawCode: "share_expired", httpStatus: dHttp, requestUrl: detailUrl, message: "分享已失效或过期" };
    }
    const list = Array.isArray(dData?.data?.list) ? dData.data.list : [];
    if (list.length === 0) {
      return { result: "dead", rawCode: "empty_list", httpStatus: dHttp, requestUrl: detailUrl, message: "分享文件列表为空或已失效" };
    }
    const rootRaw = list.slice(0, 30).map((it) => ({
      id: String(it?.fid || ""),
      name: String(it?.file_name || "").trim(),
      is_dir: Boolean(it?.dir),
      size: Number(it?.size || 0)
    })).filter((x) => x.name);
    const { fileTree, totalSize: calcSize } = await collectMultiLevelTree(rootRaw, async (fid) => {
      const subQs = new URLSearchParams({
        pr: prCode, fr: "pc", uc_param_str: "", pwd_id: shareId, stoken, pdir_fid: fid,
        force: "0", _page: "1", _size: "20", _fetch_banner: "0", _fetch_share: "0", _fetch_total: "0"
      });
      const r = await fetchWithTimeout(`${apiBase}/1/clouddrive/share/sharepage/detail?${subQs.toString()}`, {
        headers: { "Accept": "application/json, text/plain, */*" }
      });
      if (!r.ok) return [];
      const j = await r.json().catch(() => null);
      const arr = Array.isArray(j?.data?.list) ? j.data.list : [];
      return arr.map((it) => ({ id: String(it?.fid || ""), name: it?.file_name, is_dir: Boolean(it?.dir), size: Number(it?.size || 0) }));
    });
    const totalSize = Number(shareMeta.size || 0) || calcSize;
    const shareAuthor = String(shareMeta?.author?.nickname || dData?.data?.author?.nickname || data?.data?.author?.nickname || "").trim();
    return { result: "ok", rawCode: "0", httpStatus: dHttp, requestUrl: detailUrl, message: `链接有效(${fileTree.length}项)`, fileTree, totalSize, shareAuthor };
  } catch (err) {
    return { result: "uncertain", rawCode: "network", httpStatus: 0, requestUrl: tokenUrl, message: `请求异常: ${err?.message || "超时"}` };
  }
}

async function checkAliyun(shareId, shareCode = "") {
  if (!shareId) return { result: "uncertain", rawCode: "no_id", httpStatus: 0, requestUrl: "", message: "未解析出分享码" };
  const reqUrl = `https://api.aliyundrive.com/adrive/v3/share_link/get_share_by_anonymous?share_id=${encodeURIComponent(shareId)}`;
  try {
    const res = await fetchWithTimeout(reqUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ share_id: shareId })
    });
    const httpStatus = res.status;
    if (httpStatus === 429 || httpStatus >= 500) {
      return { result: "uncertain", rawCode: String(httpStatus), httpStatus, requestUrl: reqUrl, message: "接口繁忙" };
    }
    const data = await res.json();
    const errCode = String(data?.code || "");
    if (errCode) {
      if (/Forbidden|NotFound|Expired|Cancel|Delete|Invalid/i.test(errCode)) {
        return { result: "dead", rawCode: errCode, httpStatus, requestUrl: reqUrl, message: data?.message || "分享已失效" };
      }
      return { result: "uncertain", rawCode: errCode, httpStatus, requestUrl: reqUrl, message: data?.message || "状态未知" };
    }
    const shareStatus = String(data?.share_status || data?.status || "").toLowerCase();
    if (/forbidden|expired|cancel|delete|illegal|ban|disable|invalid/.test(shareStatus)) {
      return { result: "dead", rawCode: shareStatus, httpStatus, requestUrl: reqUrl, message: `阿里云盘分享状态异常(${shareStatus})` };
    }
    if (data?.expiration) {
      const expMs = Date.parse(data.expiration);
      if (!Number.isNaN(expMs) && expMs < Date.now()) {
        return { result: "dead", rawCode: "expired_ts", httpStatus, requestUrl: reqUrl, message: "分享已过期" };
      }
    }
    const fileInfos = Array.isArray(data?.file_infos) ? data.file_infos : [];
    const fileCount = Number(data?.file_count || 0);
    if (fileInfos.length === 0 && fileCount === 0) {
      return { result: "dead", rawCode: "empty_files", httpStatus, requestUrl: reqUrl, message: "分享文件为空或链接有误" };
    }

    // 第二步：调用 v2/share_link/get_share_token 校验分享是否真正可访问（防止匿名接口返回旧缓存壳）
    const tokUrl = "https://api.aliyundrive.com/v2/share_link/get_share_token";
    const tokBody = { share_id: shareId };
    if (shareCode && shareCode.trim()) tokBody.share_pwd = shareCode.trim();
    const tokRes = await fetchWithTimeout(tokUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tokBody)
    });
    const tokHttp = tokRes.status;
    if (tokHttp === 429 || tokHttp >= 500) {
      return { result: "uncertain", rawCode: String(tokHttp), httpStatus: tokHttp, requestUrl: tokUrl, message: "阿里云盘令牌接口繁忙" };
    }
    let tokData = null;
    try { tokData = await tokRes.json(); } catch {}
    if (tokHttp === 200 && tokData?.share_token) {
      // 第三步：真实拉取根目录文件列表 list_by_share，彻底识别“有分享壳但文件已删/违规清空”的假活链接
      const listUrl = "https://api.aliyundrive.com/adrive/v2/file/list_by_share";
      const listRes = await fetchWithTimeout(listUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-share-token": tokData.share_token
        },
        body: JSON.stringify({ share_id: shareId, parent_file_id: "root", limit: 10 })
      });
      const listHttp = listRes.status;
      if (listHttp === 429 || listHttp >= 500) {
        return { result: "uncertain", rawCode: String(listHttp), httpStatus: listHttp, requestUrl: listUrl, message: "阿里云盘列表接口繁忙" };
      }
      let listData = null;
      try { listData = await listRes.json(); } catch {}
      if (listHttp !== 200) {
        const lCode = String(listData?.code || `http_${listHttp}`);
        const lMsg = String(listData?.message || "");
        return { result: "dead", rawCode: lCode, httpStatus: listHttp, requestUrl: listUrl, message: lMsg || `无法读取分享目录(${lCode})` };
      }
      const items = Array.isArray(listData?.items) ? listData.items : [];
      const validItems = items.filter((it) => Number(it?.punish_flag || 0) !== 2 && String(it?.status || "").toLowerCase() !== "trashed");
      if (validItems.length === 0) {
        return { result: "dead", rawCode: items.length > 0 ? "punished" : "empty_root", httpStatus: listHttp, requestUrl: listUrl, message: items.length > 0 ? "分享文件已被违规屏蔽" : "分享目录为空或源文件已删除" };
      }
      const rootRaw = validItems.slice(0, 30).map((it) => ({
        id: String(it?.file_id || ""),
        name: String(it?.name || "").trim(),
        is_dir: String(it?.type || "").toLowerCase() === "folder",
        size: Number(it?.size || 0)
      })).filter((x) => x.name);
      const { fileTree, totalSize } = await collectMultiLevelTree(rootRaw, async (parentFid) => {
        const r = await fetchWithTimeout(listUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-share-token": tokData.share_token },
          body: JSON.stringify({ share_id: shareId, parent_file_id: parentFid, limit: 20 })
        });
        if (!r.ok) return [];
        const j = await r.json().catch(() => null);
        const arr = Array.isArray(j?.items) ? j.items : [];
        return arr.filter((it) => Number(it?.punish_flag || 0) !== 2).map((it) => ({
          id: String(it?.file_id || ""), name: it?.name, is_dir: String(it?.type || "").toLowerCase() === "folder", size: Number(it?.size || 0)
        }));
      });
      const shareAuthor = String(data?.creator_name || data?.creator_id || "").trim();
      return { result: "ok", rawCode: "200", httpStatus: listHttp, requestUrl: listUrl, message: `链接有效(${fileTree.length}项)`, fileTree, totalSize, shareAuthor };
    }
    const tCode = String(tokData?.code || `http_${tokHttp}`);
    const tMsg = String(tokData?.message || "");
    if (/SharePwd|Password|提取码|密码/i.test(`${tCode} ${tMsg}`)) {
      return { result: "ok", rawCode: tCode, httpStatus: tokHttp, requestUrl: tokUrl, message: "链接有效(需提取码)" };
    }
    if (
      tokHttp === 404 ||
      /Forbidden|NotFound|Expired|Cancel|Delete|Invalid|BadRequest|ShareLink/i.test(tCode) ||
      /失效|取消|过期|不存在|有误|违规|删除|禁止/.test(tMsg)
    ) {
      return { result: "dead", rawCode: tCode, httpStatus: tokHttp, requestUrl: tokUrl, message: tMsg || `分享无法访问(${tCode})` };
    }
    return { result: "uncertain", rawCode: tCode, httpStatus: tokHttp, requestUrl: tokUrl, message: tMsg || `令牌校验返回 ${tCode}` };
  } catch (err) {
    return { result: "uncertain", rawCode: "network", httpStatus: 0, requestUrl: reqUrl, message: `请求异常: ${err?.message || "超时"}` };
  }
}

async function checkTianyi(shareId) {
  if (!shareId) return { result: "uncertain", rawCode: "no_id", httpStatus: 0, requestUrl: "", message: "未解析出分享码" };
  const reqUrl = `https://cloud.189.cn/api/open/share/getShareInfoByCodeV2.action?shareCode=${encodeURIComponent(shareId)}`;
  try {
    const res = await fetchWithTimeout(reqUrl, { headers: { Accept: "application/json;charset=UTF-8" } });
    const httpStatus = res.status;
    if (httpStatus === 429 || httpStatus >= 500) {
      return { result: "uncertain", rawCode: String(httpStatus), httpStatus, requestUrl: reqUrl, message: "接口繁忙" };
    }
    const text = await res.text();
    if (/ShareNotFound|ShareExpired|ShareAuditNotPass|FileNotFound|ShareInfoNotFound/i.test(text)) {
      return { result: "dead", rawCode: "189_dead", httpStatus, requestUrl: reqUrl, message: "天翼分享已失效或取消" };
    }
    if (/shareId|fileName|needAccessCode/i.test(text)) {
      let fileTree = [];
      let totalSize = 0;
      let shareAuthor = "";
      try {
        const j = JSON.parse(text);
        if (j?.fileName) {
          totalSize = Number(j.fileSize || 0);
          fileTree = [{ name: String(j.fileName).trim(), is_dir: Boolean(j.isFolder), size: totalSize }];
        }
        shareAuthor = String(j?.creatorNickname || j?.userName || "").trim();
      } catch {
        const mn = text.match(/<fileName>([^<]+)<\/fileName>/i);
        const ms = text.match(/<fileSize>(\d+)<\/fileSize>/i);
        const mf = text.match(/<isFolder>(true|false)<\/isFolder>/i);
        if (mn) {
          totalSize = ms ? Number(ms[1]) : 0;
          fileTree = [{ name: mn[1].trim(), is_dir: mf ? mf[1].toLowerCase() === "true" : false, size: totalSize }];
        }
      }
      return { result: "ok", rawCode: "200", httpStatus, requestUrl: reqUrl, message: "链接有效", fileTree, totalSize, shareAuthor };
    }
    return { result: "uncertain", rawCode: "unknown", httpStatus, requestUrl: reqUrl, message: "状态不确定" };
  } catch (err) {
    return { result: "uncertain", rawCode: "network", httpStatus: 0, requestUrl: reqUrl, message: `请求异常: ${err?.message || "超时"}` };
  }
}

async function checkPan123(shareId, shareCode = "", shareUrl = "") {
  if (!shareId) return { result: "uncertain", rawCode: "no_id", httpStatus: 0, requestUrl: "", message: "未解析出123分享码" };
  let pwd = (shareCode || "").trim();
  if (!pwd && shareUrl) {
    try {
      const u = new URL(shareUrl);
      pwd = (u.searchParams.get("pwd") || u.searchParams.get("SharePwd") || "").trim();
    } catch {}
  }
  const qs = new URLSearchParams({
    limit: "10",
    next: "0",
    orderBy: "file_name",
    orderDirection: "asc",
    parentFileId: "0",
    shareKey: shareId,
    SharePwd: pwd,
    Page: "1"
  });
  const reqUrl = `https://yun.123pan.com/b/api/share/get?${qs.toString()}`;
  try {
    const res = await fetchWithTimeout(reqUrl, {
      headers: { "Accept": "application/json, text/plain, */*", "Platform": "web" }
    });
    const httpStatus = res.status;
    if (httpStatus === 429 || httpStatus >= 500) {
      return { result: "uncertain", rawCode: String(httpStatus), httpStatus, requestUrl: reqUrl, message: "123接口繁忙" };
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!data) {
      return { result: "uncertain", rawCode: `http_${httpStatus}`, httpStatus, requestUrl: reqUrl, message: `非JSON响应(HTTP ${httpStatus})` };
    }
    const code = Number(data.code);
    const msg = String(data.message || "");
    // 123云盘状态码：0=成功，5103=分享已被取消，5104=分享已过期，5113/提取码相关=需提取码
    if ([5103, 5104, 5114, 404].includes(code) || /不存在|已失效|已取消|已被取消|已过期|删除|违规|过期/.test(msg)) {
      return { result: "dead", rawCode: String(code), httpStatus, requestUrl: reqUrl, message: msg || (code === 5103 ? "分享已被取消" : "123分享已失效") };
    }
    if (code === 0 || code === 200) {
      const infoList = Array.isArray(data?.data?.InfoList) ? data.data.InfoList : [];
      const rootRaw = infoList.slice(0, 30).map((it) => ({
        id: String(it?.FileId || ""),
        name: String(it?.FileName || "").trim(),
        is_dir: Number(it?.Type) === 1,
        size: Number(it?.Size || 0)
      })).filter((x) => x.name);
      const { fileTree, totalSize } = await collectMultiLevelTree(rootRaw, async (parentFileId) => {
        const subQs = new URLSearchParams({
          limit: "20", next: "0", orderBy: "file_name", orderDirection: "asc",
          parentFileId, shareKey: shareId, SharePwd: pwd, Page: "1"
        });
        const r = await fetchWithTimeout(`https://yun.123pan.com/b/api/share/get?${subQs.toString()}`, {
          headers: { "Accept": "application/json, text/plain, */*", "Platform": "web" }
        });
        if (!r.ok) return [];
        const j = await r.json().catch(() => null);
        const arr = Array.isArray(j?.data?.InfoList) ? j.data.InfoList : [];
        return arr.map((it) => ({ id: String(it?.FileId || ""), name: it?.FileName, is_dir: Number(it?.Type) === 1, size: Number(it?.Size || 0) }));
      });
      const shareAuthor = String(data?.data?.ShareUser || data?.data?.UserName || "").trim();
      return { result: "ok", rawCode: String(code), httpStatus, requestUrl: reqUrl, message: fileTree.length ? `链接有效(${fileTree.length}项)` : "链接有效", fileTree, totalSize, shareAuthor };
    }
    if (code === 5113 || /提取码|密码/.test(msg)) {
      return { result: "ok", rawCode: String(code), httpStatus, requestUrl: reqUrl, message: "链接有效(需提取码)" };
    }
    return { result: "uncertain", rawCode: String(code), httpStatus, requestUrl: reqUrl, message: msg || `状态码 ${code}` };
  } catch (err) {
    return { result: "uncertain", rawCode: "network", httpStatus: 0, requestUrl: reqUrl, message: `请求异常: ${err?.message || "超时"}` };
  }
}

async function checkPan115(shareId, shareCode = "", shareUrl = "") {
  if (!shareId) return { result: "uncertain", rawCode: "no_id", httpStatus: 0, requestUrl: "", message: "未解析出115分享码" };
  let pwd = (shareCode || "").trim();
  if (!pwd && shareUrl) {
    try {
      const u = new URL(shareUrl);
      pwd = (u.searchParams.get("password") || u.searchParams.get("pwd") || "").trim();
    } catch {}
  }
  const qs = new URLSearchParams({
    share_code: shareId,
    receive_code: pwd,
    offset: "0",
    limit: "10",
    cid: ""
  });
  const reqUrl = `https://webapi.115.com/share/snap?${qs.toString()}`;
  try {
    const res = await fetchWithTimeout(reqUrl, {
      headers: { "Accept": "application/json, text/javascript, */*; q=0.01" }
    });
    const httpStatus = res.status;
    if (httpStatus === 429 || httpStatus >= 500) {
      return { result: "uncertain", rawCode: String(httpStatus), httpStatus, requestUrl: reqUrl, message: "115接口繁忙" };
    }
    const data = await res.json();
    if (data?.state && data?.data) {
      const list = Array.isArray(data.data.list) ? data.data.list : [];
      const rootRaw = list.slice(0, 30).map((it) => ({
        id: String(it?.cid || ""),
        name: String(it?.n || "").trim(),
        is_dir: !it?.fid && Boolean(it?.cid),
        size: Number(it?.s || 0)
      })).filter((x) => x.name);
      const { fileTree, totalSize: calcSize } = await collectMultiLevelTree(rootRaw, async (cid) => {
        const subQs = new URLSearchParams({ share_code: shareId, receive_code: pwd, offset: "0", limit: "20", cid });
        const r = await fetchWithTimeout(`https://webapi.115.com/share/snap?${subQs.toString()}`, {
          headers: { "Accept": "application/json, text/javascript, */*; q=0.01" }
        });
        if (!r.ok) return [];
        const j = await r.json().catch(() => null);
        const arr = Array.isArray(j?.data?.list) ? j.data.list : [];
        return arr.map((it) => ({ id: String(it?.cid || ""), name: it?.n, is_dir: !it?.fid && Boolean(it?.cid), size: Number(it?.s || 0) }));
      });
      const totalSize = Number(data?.data?.shareinfo?.file_size || 0) || calcSize;
      const shareAuthor = String(data?.data?.userinfo?.user_name || "").trim();
      return { result: "ok", rawCode: "200", httpStatus, requestUrl: reqUrl, message: fileTree.length ? `链接有效(${fileTree.length}项)` : "链接有效", fileTree, totalSize, shareAuthor };
    }
    const errMsg = String(data?.error || data?.message || "");
    const errno = String(data?.errno || "");
    if (/访问码|提取码|密码/.test(errMsg) || errno === "4100008" || errno === "4100018") {
      return { result: "ok", rawCode: errno || "pwd", httpStatus, requestUrl: reqUrl, message: "链接有效(需访问码)" };
    }
    if (/取消|过期|失效|不存在|删除|违规|关闭|违规内容|已被/.test(errMsg) || ["4100009", "4100010", "4100012", "4100024", "4100026"].includes(errno)) {
      return { result: "dead", rawCode: errno || "115_dead", httpStatus, requestUrl: reqUrl, message: errMsg || "115分享已失效" };
    }
    return { result: "uncertain", rawCode: errno || "unknown", httpStatus, requestUrl: reqUrl, message: errMsg || "状态不确定" };
  } catch (err) {
    return { result: "uncertain", rawCode: "network", httpStatus: 0, requestUrl: reqUrl, message: `请求异常: ${err?.message || "超时"}` };
  }
}

async function checkMobile139(shareUrl, _shareCode = "") {
  return {
    result: "uncertain",
    rawCode: "passive_only",
    httpStatus: 0,
    requestUrl: shareUrl || "",
    message: "移动云盘接口加密，请点击打开链接由被动读页自动识别"
  };
}

// 轻量纯 JS MD5（与 Python hashlib.md5 位级一致，用于迅雷安卓协议 10 重 MD5 captcha_sign）
function md5Hex(input) {
  const bytes = new TextEncoder().encode(String(input));
  const len = bytes.length;
  const bitLen = len * 8;
  const padLen = ((len + 8) >> 6) + 1;
  const words = new Int32Array(padLen * 16);
  for (let i = 0; i < len; i++) {
    words[i >> 2] |= bytes[i] << ((i % 4) * 8);
  }
  words[len >> 2] |= 0x80 << ((len % 4) * 8);
  words[padLen * 16 - 2] = bitLen & 0xffffffff;
  words[padLen * 16 - 1] = Math.floor(bitLen / 0x100000000);

  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  const add = (x, y) => (x + y) | 0;
  const rol = (num, cnt) => (num << cnt) | (num >>> (32 - cnt));
  const cmn = (q, a0, b0, x, s, t) => add(rol(add(add(a0, q), add(x, t)), s), b0);
  const ff = (a0, b0, c0, d0, x, s, t) => cmn((b0 & c0) | (~b0 & d0), a0, b0, x, s, t);
  const gg = (a0, b0, c0, d0, x, s, t) => cmn((b0 & d0) | (c0 & ~d0), a0, b0, x, s, t);
  const hh = (a0, b0, c0, d0, x, s, t) => cmn(b0 ^ c0 ^ d0, a0, b0, x, s, t);
  const ii = (a0, b0, c0, d0, x, s, t) => cmn(c0 ^ (b0 | ~d0), a0, b0, x, s, t);

  for (let i = 0; i < words.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, words[i + 0], 7, -680876936);
    d = ff(d, a, b, c, words[i + 1], 12, -389564586);
    c = ff(c, d, a, b, words[i + 2], 17, 606105819);
    b = ff(b, c, d, a, words[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, words[i + 4], 7, -176418897);
    d = ff(d, a, b, c, words[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, words[i + 6], 17, -1473231341);
    b = ff(b, c, d, a, words[i + 7], 22, -45705983);
    a = ff(a, b, c, d, words[i + 8], 7, 1770035416);
    d = ff(d, a, b, c, words[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, words[i + 10], 17, -42063);
    b = ff(b, c, d, a, words[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, words[i + 12], 7, 1804603682);
    d = ff(d, a, b, c, words[i + 13], 12, -40341101);
    c = ff(c, d, a, b, words[i + 14], 17, -1502002290);
    b = ff(b, c, d, a, words[i + 15], 22, 1236535329);

    a = gg(a, b, c, d, words[i + 1], 5, -165796510);
    d = gg(d, a, b, c, words[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, words[i + 11], 14, 643717713);
    b = gg(b, c, d, a, words[i + 0], 20, -373897302);
    a = gg(a, b, c, d, words[i + 5], 5, -701558691);
    d = gg(d, a, b, c, words[i + 10], 9, 38016083);
    c = gg(c, d, a, b, words[i + 15], 14, -660478335);
    b = gg(b, c, d, a, words[i + 4], 20, -405537848);
    a = gg(a, b, c, d, words[i + 9], 5, 568446438);
    d = gg(d, a, b, c, words[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, words[i + 3], 14, -187363961);
    b = gg(b, c, d, a, words[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, words[i + 13], 5, -1444681467);
    d = gg(d, a, b, c, words[i + 2], 9, -51403784);
    c = gg(c, d, a, b, words[i + 7], 14, 1735328473);
    b = gg(b, c, d, a, words[i + 12], 20, -1926607734);

    a = hh(a, b, c, d, words[i + 5], 4, -378558);
    d = hh(d, a, b, c, words[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, words[i + 11], 16, 1839030562);
    b = hh(b, c, d, a, words[i + 14], 23, -35309556);
    a = hh(a, b, c, d, words[i + 1], 4, -1530992060);
    d = hh(d, a, b, c, words[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, words[i + 7], 16, -155497632);
    b = hh(b, c, d, a, words[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, words[i + 13], 4, 681279174);
    d = hh(d, a, b, c, words[i + 0], 11, -358537222);
    c = hh(c, d, a, b, words[i + 3], 16, -722521979);
    b = hh(b, c, d, a, words[i + 6], 23, 76029189);
    a = hh(a, b, c, d, words[i + 9], 4, -640364487);
    d = hh(d, a, b, c, words[i + 12], 11, -421815835);
    c = hh(c, d, a, b, words[i + 15], 16, 530742520);
    b = hh(b, c, d, a, words[i + 2], 23, -995338651);

    a = ii(a, b, c, d, words[i + 0], 6, -198630844);
    d = ii(d, a, b, c, words[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, words[i + 14], 15, -1416354905);
    b = ii(b, c, d, a, words[i + 5], 21, -57434055);
    a = ii(a, b, c, d, words[i + 12], 6, 1700485571);
    d = ii(d, a, b, c, words[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, words[i + 10], 15, -1051523);
    b = ii(b, c, d, a, words[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, words[i + 8], 6, 1873313359);
    d = ii(d, a, b, c, words[i + 15], 10, -30611744);
    c = ii(c, d, a, b, words[i + 6], 15, -1560198380);
    b = ii(b, c, d, a, words[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, words[i + 4], 6, -145523070);
    d = ii(d, a, b, c, words[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, words[i + 2], 15, 718787259);
    b = ii(b, c, d, a, words[i + 9], 21, -343485551);

    a = add(a, oa); b = add(b, ob); c = add(c, oc); d = add(d, od);
  }
  const toHex = (n) => {
    let s = "";
    for (let j = 0; j < 4; j++) {
      s += ((n >>> (j * 8)) & 0xff).toString(16).padStart(2, "0");
    }
    return s;
  };
  return toHex(a) + toHex(b) + toHex(c) + toHex(d);
}

const XL_ANDROID_CLIENT_ID = "Xp6vsxz_7IYVw2BB";
const XL_ANDROID_CLIENT_VERSION = "8.31.0.9726";
const XL_ANDROID_PACKAGE = "com.xunlei.downloadprovider";
const XL_ALGOS = [
  "9uJNVj/wLmdwKrJaVj/omlQ",
  "Oz64Lp0GigmChHMf/6TNfxx7O9PyopcczMsnf",
  "Eb+L7Ce+Ej48u",
  "jKY0",
  "ASr0zCl6v8W4aidjPK5KHd1Lq3t+vBFf41dqv5+fnOd",
  "wQlozdg6r1qxh0eRmt3QgNXOvSZO6q/GXK",
  "gmirk+ciAvIgA/cxUUCema47jr/YToixTT+Q6O",
  "5IiCoM9B1/788ntB",
  "P07JH0h6qoM6TSUAK2aL9T5s2QBVeY9JWvalf",
  "+oK0AN"
];

let xunleiDeviceId = "";
let xunleiCaptchaToken = "";
let xunleiCaptchaTs = 0;

function getXunleiDeviceId() {
  if (xunleiDeviceId) return xunleiDeviceId;
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 32; i++) id += chars[Math.floor(Math.random() * chars.length)];
  xunleiDeviceId = id;
  return id;
}

function getXunleiCaptchaSign(devId, ts) {
  let s = `${XL_ANDROID_CLIENT_ID}${XL_ANDROID_CLIENT_VERSION}${XL_ANDROID_PACKAGE}${devId}${ts}`;
  for (const algo of XL_ALGOS) {
    s = md5Hex(s + algo);
  }
  return `1.${s}`;
}

async function getXunleiCaptchaToken(force = false) {
  const now = Date.now();
  if (!force && xunleiCaptchaToken && now - xunleiCaptchaTs < 180000) {
    return xunleiCaptchaToken;
  }
  const devId = getXunleiDeviceId();
  const ts = String(now);
  const capSign = getXunleiCaptchaSign(devId, ts);
  try {
    const res = await fetchWithTimeout("https://xluser-ssl.xunlei.com/v1/shield/captcha/init", {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "Accept": "application/json;charset=UTF-8",
        "x-client-id": XL_ANDROID_CLIENT_ID,
        "x-client-version": XL_ANDROID_CLIENT_VERSION,
        "x-device-id": devId
      },
      body: JSON.stringify({
        action: "GET:/drive/v1/share",
        captcha_token: xunleiCaptchaToken || "",
        client_id: XL_ANDROID_CLIENT_ID,
        device_id: devId,
        meta: {
          client_version: XL_ANDROID_CLIENT_VERSION,
          package_name: XL_ANDROID_PACKAGE,
          user_id: "",
          timestamp: ts,
          captcha_sign: capSign
        },
        redirect_uri: "xlaccsdk01://xunlei.com/callback?state=harbor"
      })
    }, 6000);
    if (res.ok) {
      const j = await res.json();
      if (j && j.captcha_token) {
        xunleiCaptchaToken = j.captcha_token;
        xunleiCaptchaTs = now;
        return xunleiCaptchaToken;
      }
    }
  } catch {}
  return xunleiCaptchaToken || "";
}

async function checkXunlei(shareId, passCode = "", shareUrl = "") {
  if (!shareId) return { result: "uncertain", rawCode: "no_id", httpStatus: 0, requestUrl: "", message: "未解析出迅雷分享码" };
  let finalCode = (passCode || "").trim();
  if (!finalCode && shareUrl) {
    try {
      const u = new URL(shareUrl);
      finalCode = (u.searchParams.get("pwd") || u.searchParams.get("pass_code") || "").trim();
    } catch {}
  }
  const qs = new URLSearchParams({ share_id: shareId });
  if (finalCode) qs.set("pass_code", finalCode);
  const reqUrl = `https://api-pan.xunlei.com/drive/v1/share?${qs.toString()}`;
  const devId = getXunleiDeviceId();
  try {
    let capToken = await getXunleiCaptchaToken(false);
    const doReq = (tok) => {
      const hdrs = {
        "Accept": "application/json, text/plain, */*",
        "x-client-id": XL_ANDROID_CLIENT_ID,
        "x-client-version": XL_ANDROID_CLIENT_VERSION,
        "x-device-id": devId
      };
      if (tok) hdrs["x-captcha-token"] = tok;
      return fetchWithTimeout(reqUrl, { method: "GET", headers: hdrs });
    };
    let res = await doReq(capToken);
    if (res.status === 400) {
      const peek = await res.clone().text().catch(() => "");
      if (/captcha|invalid_argument|missing/i.test(peek)) {
        capToken = await getXunleiCaptchaToken(true);
        res = await doReq(capToken);
      }
    }
    const httpStatus = res.status;
    if (httpStatus === 429 || httpStatus >= 500) {
      return { result: "uncertain", rawCode: String(httpStatus), httpStatus, requestUrl: reqUrl, message: "迅雷接口繁忙或限流" };
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (httpStatus !== 200) {
      const errCode = String(data?.error || data?.error_code || httpStatus);
      const errDesc = String(data?.error_description || data?.message || "");
      const comb = `${errCode} ${errDesc}`.toLowerCase();
      if (
        httpStatus === 404 ||
        /not_found|expired|cancel|delete|illegal|forbidden|sensitive|ban|失效|取消|过期|不存在|违规|侵权|无法访问|低俗/.test(comb)
      ) {
        return { result: "dead", rawCode: errCode, httpStatus, requestUrl: reqUrl, message: errDesc || "迅雷分享已失效或违规" };
      }
      if (/pass_code|password|提取码|密码/.test(comb)) {
        return { result: "ok", rawCode: errCode, httpStatus, requestUrl: reqUrl, message: "链接有效(需提取码)" };
      }
      return { result: "uncertain", rawCode: errCode, httpStatus, requestUrl: reqUrl, message: errDesc || `HTTP ${httpStatus}` };
    }

    const st = data?.share_status;
    const stStr = String(st ?? "").toUpperCase();
    const stText = String(data?.share_status_text || "");
    if (/提取码|密码/.test(stText) || stStr === "PASS_CODE_EMPTY" || stStr === "PASS_CODE_ERROR") {
      return { result: "ok", rawCode: stStr || "pass_code", httpStatus, requestUrl: reqUrl, message: "链接有效(需提取码)" };
    }
    if (
      /SENSITIVE|ILLEGAL|VIOLAT|EXPIRED|DELETE|CANCEL|NOT_FOUND|FORBIDDEN|BAN|DISABLE/.test(stStr) ||
      (typeof st === "number" && st !== 0 && st !== 1) ||
      /敏感|失效|取消|过期|不存在|违规|侵权|无法访问|低俗|删除/.test(stText)
    ) {
      return { result: "dead", rawCode: stStr || "dead", httpStatus, requestUrl: reqUrl, message: stText || "迅雷分享已失效或无法访问" };
    }
    const files = Array.isArray(data?.files) ? data.files : [];
    if (stStr === "OK" || st === 0 || st === 1 || files.length > 0 || data?.title) {
      const rootRaw = files.slice(0, 30).map((it) => ({
        id: String(it?.id || ""),
        name: String(it?.name || "").trim(),
        is_dir: String(it?.kind || "").includes("folder"),
        size: Number(it?.size || 0)
      })).filter((x) => x.name);
      const { fileTree, totalSize } = await collectMultiLevelTree(rootRaw, async (parentId) => {
        const subQs = new URLSearchParams({ share_id: shareId, parent_id: parentId, limit: "20" });
        if (finalCode) subQs.set("pass_code", finalCode);
        const hdrs = {
          "Accept": "application/json, text/plain, */*",
          "x-client-id": XL_ANDROID_CLIENT_ID,
          "x-client-version": XL_ANDROID_CLIENT_VERSION,
          "x-device-id": devId
        };
        if (capToken) hdrs["x-captcha-token"] = capToken;
        const r = await fetchWithTimeout(`https://api-pan.xunlei.com/drive/v1/share?${subQs.toString()}`, { method: "GET", headers: hdrs });
        if (!r.ok) return [];
        const j = await r.json().catch(() => null);
        const arr = Array.isArray(j?.files) ? j.files : [];
        return arr.map((it) => ({ id: String(it?.id || ""), name: it?.name, is_dir: String(it?.kind || "").includes("folder"), size: Number(it?.size || 0) }));
      });
      const shareAuthor = String(data?.user_info?.nick_name || data?.user_info?.name || data?.user_info?.nickname || data?.share?.nick_name || "").trim();
      return { result: "ok", rawCode: stStr || "200", httpStatus, requestUrl: reqUrl, message: fileTree.length ? `链接有效(${fileTree.length}项)` : "链接有效", fileTree, totalSize, shareAuthor };
    }
    return { result: "uncertain", rawCode: stStr || "unknown", httpStatus, requestUrl: reqUrl, message: stText || "迅雷返回状态不明确" };
  } catch (err) {
    return { result: "uncertain", rawCode: "network", httpStatus: 0, requestUrl: reqUrl, message: `请求异常: ${err?.message || "超时"}` };
  }
}

async function checkHtmlPage(shareUrl, deadPatterns, alivePatterns) {
  try {
    const res = await fetchWithTimeout(shareUrl, { redirect: "follow" });
    const httpStatus = res.status;
    if (httpStatus === 404 || httpStatus === 410) {
      return { result: "dead", rawCode: String(httpStatus), httpStatus, requestUrl: shareUrl, message: "页面不存在" };
    }
    if (httpStatus === 429 || httpStatus >= 500) {
      return { result: "uncertain", rawCode: String(httpStatus), httpStatus, requestUrl: shareUrl, message: "触发限流或繁忙" };
    }
    const html = await res.text();
    if (/安全验证|验证码|滑块|captcha/i.test(html) && html.length < 12000) {
      return { result: "uncertain", rawCode: "captcha", httpStatus, requestUrl: shareUrl, message: "触发验证跳过" };
    }
    for (const pat of deadPatterns) {
      if (pat.test(html)) {
        return { result: "dead", rawCode: "page_dead", httpStatus, requestUrl: shareUrl, message: "分享已取消或失效" };
      }
    }
    for (const pat of alivePatterns) {
      if (pat.test(html)) {
        return { result: "ok", rawCode: "200", httpStatus, requestUrl: shareUrl, message: "链接有效" };
      }
    }
    return { result: "uncertain", rawCode: "ambiguous", httpStatus, requestUrl: shareUrl, message: "页面特征不明确" };
  } catch (err) {
    return { result: "uncertain", rawCode: "network", httpStatus: 0, requestUrl: shareUrl, message: `请求异常: ${err?.message || "超时"}` };
  }
}

async function checkSingleTask(task) {
  const pan = String(task.pan_type || "").toLowerCase();
  const shareUrl = String(task.share_link || "").trim();
  const shareCode = String(task.share_code || "").trim();
  const shareId = extractShareId(pan, shareUrl);

  if (pan === "quark") return checkQuarkOrUc("https://drive-h.quark.cn", "ucpro", shareId, shareCode, shareUrl);
  if (pan === "uc") return checkQuarkOrUc("https://pc-api.uc.cn", "UCBrowser", shareId, shareCode, shareUrl);
  if (pan === "aliyun" || pan === "alipan") return checkAliyun(shareId, shareCode);
  if (pan === "tianyi" || pan === "189") return checkTianyi(shareId);
  if (pan === "123" || pan === "pan123") return checkPan123(shareId, shareCode, shareUrl);
  if (pan === "115" || pan === "pan115") return checkPan115(shareId, shareCode, shareUrl);
  if (pan === "mobile" || pan === "139") return checkMobile139(shareUrl, shareCode);
  if (pan === "xunlei" || pan === "thunder") return checkXunlei(shareId, shareCode, shareUrl);
  if (pan === "baidu") {
    return checkHtmlPage(
      shareUrl,
      [/分享的文件已经被取消/, /此链接分享内容可能因为涉及侵权/, /啊哦，你来晚了/, /分享已过期/, /链接不存在/],
      [/请输入提取码/, /yunData/, /share_title/, /提取文件/]
    );
  }
  return { result: "uncertain", rawCode: "unsupported", httpStatus: 0, requestUrl: shareUrl, message: `暂不支持主动探测(${pan})` };
}

async function postReport(origin, payload) {
  try {
    const res = await fetchWithTimeout(`${origin}/api/client/check/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!res.ok) return { accepted: false, reason: `HTTP ${res.status}`, raw: text.slice(0, 120) };
    return json;
  } catch (err) {
    return { accepted: false, reason: `上报失败: ${err?.message || "网络异常"}` };
  }
}

async function runTasksWithLimit(origin, tasks, tabId) {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
    while (queue.length > 0) {
      const task = queue.shift();
      if (!task) break;
      const checkRes = await checkSingleTask(task);
      const serverRes = await postReport(origin, {
        slug: task.slug,
        share_url: task.share_link,
        lease_token: task.lease_token,
        mode: "active",
        result: checkRes.result,
        raw_code: checkRes.rawCode || "",
        message: checkRes.message || "",
        file_tree: Array.isArray(checkRes.fileTree) ? checkRes.fileTree : [],
        total_size: Number(checkRes.totalSize || 0) || null,
        share_author: checkRes.shareAuthor || ""
      });
      if (checkRes.result === "ok") await bumpStat("activeOk");
      else if (checkRes.result === "dead") await bumpStat("activeDead");

      const treeArr = Array.isArray(checkRes.fileTree) ? checkRes.fileTree : [];
      const authorStr = checkRes.shareAuthor || "";
      const totalBytes = Number(checkRes.totalSize || 0);
      if (treeArr.length > 0 || authorStr || totalBytes > 0) {
        chrome.storage.local.set({
          lastPreview: {
            slug: task.slug || "",
            panType: task.pan_type || "",
            shareUrl: task.share_link || "",
            shareAuthor: authorStr,
            totalSize: totalBytes,
            fileTree: treeArr,
            updatedAt: new Date().toISOString()
          }
        }).catch(() => {});
      }
      await appendLog({
        mode: "active",
        panType: task.pan_type || "",
        slug: task.slug || "",
        shareUrl: task.share_link || "",
        requestUrl: checkRes.requestUrl || "",
        httpStatus: checkRes.httpStatus ?? 0,
        result: checkRes.result,
        rawCode: checkRes.rawCode || "",
        message: checkRes.message || "",
        shareAuthor: authorStr,
        totalSize: totalBytes,
        treeCount: treeArr.length,
        serverAccepted: Boolean(serverRes?.accepted),
        serverStatus: serverRes?.alive_status || serverRes?.reason || ""
      });

      if (tabId) {
        const payload = (serverRes && serverRes.accepted)
          ? { ...serverRes, check_result: checkRes.result, check_message: checkRes.message || "" }
          : {
              accepted: false,
              slug: task.slug,
              alive_status: "unknown",
              check_result: checkRes.result,
              check_message: checkRes.message || (serverRes?.reason || "上报未受理")
            };
        chrome.tabs.sendMessage(tabId, {
          action: "MOEPANS_STATUS_UPDATED",
          payload
        }).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 250 + Math.floor(Math.random() * 200)));
    }
  });
  await Promise.all(workers);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return false;

  if (msg.action === "GET_SETTINGS") {
    getSettings().then(sendResponse);
    return true;
  }

  if (msg.action === "GET_LAST_PREVIEW") {
    chrome.storage.local.get(["lastPreview"]).then((d) => sendResponse(d.lastPreview || null));
    return true;
  }

  if (msg.action === "GET_LOGS") {
    chrome.storage.local.get(["logs"]).then((d) => sendResponse(Array.isArray(d.logs) ? d.logs : []));
    return true;
  }

  if (msg.action === "CLEAR_LOGS") {
    chrome.storage.local.set({ logs: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === "UPDATE_SETTINGS") {
    chrome.storage.local.set(msg.patch || {}).then(() => getSettings().then(sendResponse));
    return true;
  }

  if (msg.action === "TRACK_OUTBOUND") {
    cleanupVisits();
    const norm = normalizeUrl(msg.shareUrl);
    if (norm && msg.origin && msg.slug) {
      pendingVisits.set(norm, {
        origin: msg.origin,
        slug: msg.slug,
        panType: msg.panType || "",
        ts: Date.now()
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === "RUN_ACTIVE_TASKS") {
    const origin = msg.origin;
    const tasks = Array.isArray(msg.tasks) ? msg.tasks.slice(0, 5) : [];
    const tabId = sender?.tab?.id;
    runTasksWithLimit(origin, tasks, tabId).then(() => sendResponse({ done: true }));
    return true;
  }

  if (msg.action === "PASSIVE_PAGE_RESULT") {
    (async () => {
      cleanupVisits();
      const cfg = await getSettings();
      if (!cfg.passiveEnabled) {
        sendResponse({ reported: false, reason: "disabled" });
        return;
      }
      const norm = normalizeUrl(msg.url);
      let visit = pendingVisits.get(norm);
      if (!visit) {
        const tail = norm.split("/").pop() || "";
        if (tail.length >= 8) {
          for (const [k, v] of pendingVisits.entries()) {
            if (k.endsWith("/" + tail)) {
              visit = v;
              pendingVisits.delete(k);
              break;
            }
          }
        }
      } else {
        pendingVisits.delete(norm);
      }

      if (!visit) {
        sendResponse({ reported: false, reason: "not_from_moepans" });
        return;
      }

      const serverRes = await postReport(visit.origin, {
        slug: visit.slug,
        share_url: msg.url,
        mode: "passive",
        result: msg.result,
        raw_code: "dom_passive",
        message: msg.message || ""
      });
      if (msg.result === "ok") await bumpStat("passiveOk");
      else if (msg.result === "dead") await bumpStat("passiveDead");

      await appendLog({
        mode: "passive",
        panType: visit.panType || "",
        slug: visit.slug || "",
        shareUrl: msg.url || "",
        requestUrl: msg.url || "",
        httpStatus: 200,
        result: msg.result,
        rawCode: "dom_passive",
        message: msg.message || "",
        serverAccepted: Boolean(serverRes?.accepted),
        serverStatus: serverRes?.alive_status || serverRes?.reason || ""
      });

      sendResponse({ reported: Boolean(serverRes?.accepted), serverRes });
    })();
    return true;
  }

  return false;
});

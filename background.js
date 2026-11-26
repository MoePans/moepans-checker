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

// 安全解析含 16 位以上长整型 ID（如天翼云盘 18 位雪花 ID）的 JSON，防止 JS Number 精度丢失导致 ID 碰撞
function safeJsonParse(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    const protectedText = text.replace(/([:\[,]\s*)(\d{16,})(?=\s*[,}\]])/g, '$1"$2"');
    return JSON.parse(protectedText);
  } catch {
    try { return JSON.parse(text); } catch { return null; }
  }
}

// 单次分享会话缓存（10分钟 TTL），供按需点击展开单个子目录时复用令牌，避免从头重新测活
const shareSessionCache = new Map();
function setShareSession(pan, shareUrl, ctx) {
  const key = `${String(pan || "").toLowerCase()}|${normalizeUrl(shareUrl)}`;
  shareSessionCache.set(key, { ...ctx, ts: Date.now() });
  if (shareSessionCache.size > 60) {
    const oldest = shareSessionCache.keys().next().value;
    if (oldest) shareSessionCache.delete(oldest);
  }
}
function getShareSession(pan, shareUrl) {
  const key = `${String(pan || "").toLowerCase()}|${normalizeUrl(shareUrl)}`;
  const hit = shareSessionCache.get(key);
  if (!hit || Date.now() - hit.ts > 10 * 60 * 1000) return null;
  return hit;
}

// 通用多级目录递归采样器（最多展开 4 层、最多 12 次子目录请求、展示最多 80 项；文件大小全量累加不截断，记录 node_id/expanded/truncated）
async function collectMultiLevelTree(rootItems, fetchChildrenFn, maxDepth = 4, maxSubReqs = 12, maxItems = 80) {
  const result = [];
  const queue = [];
  const seenDirIds = new Set();
  const nodeByPath = new Map();
  let subReqs = 0;
  let totalSize = 0;
  let skippedAny = false;

  const MAX_SUBDIRS_PER_PARENT = 15;
  let rootDirCount = 0;

  for (const raw of (rootItems || [])) {
    const nm = String(raw.name || "").trim();
    if (!nm) continue;
    const isDir = Boolean(raw.is_dir);
    const sz = isDir ? 0 : (Number(raw.size || 0) || 0);
    totalSize += sz;

    const rid = raw.id ? String(raw.id) : "";
    if (isDir) {
      if (rid && seenDirIds.has(rid)) continue;
      if (rootDirCount >= MAX_SUBDIRS_PER_PARENT && maxDepth > 0) {
        skippedAny = true;
        continue;
      }
      rootDirCount++;
      if (rid) seenDirIds.add(rid);
    }

    if (result.length >= maxItems) {
      skippedAny = true;
      continue;
    }
    const node = {
      name: nm,
      path: nm,
      depth: 0,
      is_dir: isDir,
      size: sz,
      ...(isDir ? { node_id: rid, expanded: false } : {})
    };
    result.push(node);
    nodeByPath.set(node.path, node);
    if (isDir && rid && maxDepth > 0) {
      queue.push({ id: rid, parentPath: node.path, depth: 1 });
    }
  }

  const childrenByParent = new Map();
  let totalCount = result.length;
  while (queue.length > 0 && subReqs < maxSubReqs && totalCount + 20 <= maxItems) {
    const cur = queue.shift();
    if (!cur || cur.depth > maxDepth) continue;
    subReqs++;
    let kids = [];
    try {
      kids = await fetchChildrenFn(cur.id);
    } catch {
      kids = [];
    }
    const parentNode = nodeByPath.get(cur.parentPath);
    if (parentNode) {
      parentNode.expanded = true;
      if (Array.isArray(kids) && kids.length >= 20) {
        parentNode.has_more = true;
        parentNode.next_page = 2;
        skippedAny = true;
      }
    }

    const list = [];
    let dirAdded = 0;
    for (const raw of (kids || [])) {
      const nm = String(raw.name || "").trim();
      if (!nm) continue;
      const isDir = Boolean(raw.is_dir);
      const sz = isDir ? 0 : (Number(raw.size || 0) || 0);
      totalSize += sz;

      const kidId = raw.id ? String(raw.id) : "";
      if (isDir) {
        if (kidId && seenDirIds.has(kidId)) continue;
        if (cur.depth < maxDepth && dirAdded >= MAX_SUBDIRS_PER_PARENT) {
          skippedAny = true;
          if (parentNode) { parentNode.has_more = true; parentNode.next_page = 2; }
          continue;
        }
        dirAdded++;
        if (kidId) seenDirIds.add(kidId);
      }

      if (totalCount >= maxItems) {
        skippedAny = true;
        if (parentNode) { parentNode.has_more = true; parentNode.next_page = 2; }
        continue;
      }
      const p = `${cur.parentPath}/${nm}`;
      const node = {
        name: nm,
        path: p,
        depth: cur.depth,
        is_dir: isDir,
        size: sz,
        ...(isDir ? { node_id: kidId, expanded: false } : {})
      };
      list.push(node);
      nodeByPath.set(p, node);
      totalCount++;
      if (isDir && kidId && cur.depth < maxDepth) {
        queue.push({ id: kidId, parentPath: p, depth: cur.depth + 1 });
      }
    }
    if (list.length > 0) childrenByParent.set(cur.parentPath, list);
  }

  const ordered = [];
  function emitWithKids(nodes) {
    for (const n of nodes) {
      if (ordered.length >= maxItems) {
        skippedAny = true;
        break;
      }
      ordered.push(n);
      const kids = childrenByParent.get(n.path);
      if (kids && kids.length > 0) emitWithKids(kids);
    }
  }
  emitWithKids(result);

  const hasUnexpanded = ordered.some((n) => n.is_dir && n.expanded === false);
  const truncated = Boolean(skippedAny || queue.length > 0 || hasUnexpanded);
  return { fileTree: ordered, totalSize, truncated };
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
      _size: "100",
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
    const rootRaw = list.slice(0, 100).map((it) => ({
      id: String(it?.fid || ""),
      name: String(it?.file_name || "").trim(),
      is_dir: Boolean(it?.dir),
      size: Number(it?.size || 0)
    })).filter((x) => x.name);
    setShareSession(prCode === "ucpro" ? "quark" : "uc", shareUrl, { apiBase, prCode, shareId, stoken });
    const { fileTree, totalSize: calcSize, truncated: treeTruncated } = await collectMultiLevelTree(rootRaw, async (fid) => {
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
    return { result: "ok", rawCode: "0", httpStatus: dHttp, requestUrl: detailUrl, message: `链接有效(${fileTree.length}${treeTruncated ? "+" : ""}项)`, fileTree, totalSize, treeTruncated, shareAuthor };
  } catch (err) {
    return { result: "uncertain", rawCode: "network", httpStatus: 0, requestUrl: tokenUrl, message: `请求异常: ${err?.message || "超时"}` };
  }
}

async function checkAliyun(shareId, shareCode = "", shareUrl = "") {
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
    let pwd = (shareCode || "").trim();
    if (!pwd && shareUrl) {
      try {
        const u = new URL(shareUrl);
        pwd = (u.searchParams.get("pwd") || u.searchParams.get("password") || "").trim();
      } catch {}
    }
    const reqToken = async (usePwd) => {
      const bodyObj = { share_id: shareId };
      if (usePwd) bodyObj.share_pwd = usePwd;
      const r = await fetchWithTimeout(tokUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyObj)
      });
      const j = await r.json().catch(() => null);
      return { http: r.status, data: j };
    };
    let { http: tokHttp, data: tokData } = await reqToken(pwd);
    // 若库里带有冗余/错误提取码导致公开分享报 InvalidResource.SharePwd，自动以无密码重试一次
    if (pwd && tokHttp !== 200 && /SharePwd|Password/i.test(String(tokData?.code || ""))) {
      const retry = await reqToken("");
      if (retry.http === 200 && retry.data?.share_token) {
        tokHttp = retry.http;
        tokData = retry.data;
      }
    }
    if (tokHttp === 429 || tokHttp >= 500) {
      return { result: "uncertain", rawCode: String(tokHttp), httpStatus: tokHttp, requestUrl: tokUrl, message: "阿里云盘令牌接口繁忙" };
    }
    if (tokHttp === 200 && tokData?.share_token) {
      // 第三步：真实拉取根目录文件列表 list_by_share，彻底识别“有分享壳但文件已删/违规清空”的假活链接
      const listUrl = "https://api.aliyundrive.com/adrive/v2/file/list_by_share";
      const listRes = await fetchWithTimeout(listUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-share-token": tokData.share_token
        },
        body: JSON.stringify({ share_id: shareId, parent_file_id: "root", limit: 100 })
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
      const rootRaw = validItems.slice(0, 100).map((it) => ({
        id: String(it?.file_id || ""),
        name: String(it?.name || "").trim(),
        is_dir: String(it?.type || "").toLowerCase() === "folder",
        size: Number(it?.size || 0)
      })).filter((x) => x.name);
      const aliMarkers = {};
      setShareSession("aliyun", `https://www.alipan.com/s/${shareId}`, { shareId, shareToken: tokData.share_token, markers: aliMarkers });
      const { fileTree, totalSize, truncated: treeTruncated } = await collectMultiLevelTree(rootRaw, async (parentFid) => {
        const r = await fetchWithTimeout(listUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-share-token": tokData.share_token },
          body: JSON.stringify({ share_id: shareId, parent_file_id: parentFid, limit: 20 })
        });
        if (!r.ok) return [];
        const j = await r.json().catch(() => null);
        if (j?.next_marker) aliMarkers[parentFid] = String(j.next_marker);
        const arr = Array.isArray(j?.items) ? j.items : [];
        return arr.filter((it) => Number(it?.punish_flag || 0) !== 2).map((it) => ({
          id: String(it?.file_id || ""), name: it?.name, is_dir: String(it?.type || "").toLowerCase() === "folder", size: Number(it?.size || 0)
        }));
      });
      const shareAuthor = String(data?.creator_name || data?.creator_id || "").trim();
      return { result: "ok", rawCode: "200", httpStatus: listHttp, requestUrl: listUrl, message: `链接有效(${fileTree.length}${treeTruncated ? "+" : ""}项)`, fileTree, totalSize, treeTruncated, shareAuthor };
    }
    const tCode = String(tokData?.code || `http_${tokHttp}`);
    const tMsg = String(tokData?.message || "");
    if (/SharePwd|Password|提取码|密码/i.test(`${tCode} ${tMsg}`)) {
      const anonTree = fileInfos.slice(0, 20).map((it) => ({
        name: String(it?.file_name || it?.name || "").trim(),
        path: String(it?.file_name || it?.name || "").trim(),
        depth: 0,
        is_dir: String(it?.type || "").toLowerCase() === "folder",
        size: Number(it?.size || 0)
      })).filter((x) => x.name);
      const anonSize = anonTree.reduce((acc, x) => acc + (x.is_dir ? 0 : (Number(x.size) || 0)), 0);
      const shareAuthor = String(data?.creator_name || data?.creator_id || "").trim();
      const msg = pwd ? "链接有效(提取码不匹配，仅展示顶层预览)" : "链接有效(需提取码)";
      return { result: "ok", rawCode: tCode, httpStatus: tokHttp, requestUrl: tokUrl, message: msg, fileTree: anonTree, totalSize: anonSize, treeTruncated: anonTree.some((x) => x.is_dir), shareAuthor };
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

async function checkTianyi(shareId, shareCode = "", shareUrl = "") {
  if (!shareId) return { result: "uncertain", rawCode: "no_id", httpStatus: 0, requestUrl: "", message: "未解析出分享码" };
  let accessCode = (shareCode || "").trim();
  if (!accessCode && shareUrl) {
    try {
      const u = new URL(shareUrl);
      accessCode = (u.searchParams.get("pwd") || u.searchParams.get("accessCode") || "").trim();
    } catch {}
  }
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
    if (!/shareId|fileName|needAccessCode/i.test(text)) {
      return { result: "uncertain", rawCode: "unknown", httpStatus, requestUrl: reqUrl, message: "状态不确定" };
    }

    const info = safeJsonParse(text);

    let fileName = "";
    let fileSize = 0;
    let isFolder = false;
    let shareIdNum = "";
    let rootFileId = "";
    let shareMode = "3";
    let needAccessCode = 0;
    let shareAuthor = "";

    if (info && typeof info === "object") {
      fileName = String(info.fileName || "").trim();
      fileSize = Number(info.fileSize || 0);
      isFolder = Boolean(info.isFolder);
      shareIdNum = String(info.shareId || "");
      rootFileId = String(info.fileId || "");
      shareMode = String(info.shareMode || (info.needAccessCode ? "1" : "3"));
      needAccessCode = Number(info.needAccessCode || 0);
      shareAuthor = String(info?.creator?.nickName || info?.creatorNickname || info?.userName || "").trim();
    } else {
      const pick = (tag) => {
        const m = text.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, "i"));
        return m ? m[1].trim() : "";
      };
      fileName = pick("fileName");
      fileSize = Number(pick("fileSize") || 0);
      isFolder = pick("isFolder").toLowerCase() === "true";
      shareIdNum = pick("shareId");
      rootFileId = pick("fileId");
      needAccessCode = Number(pick("needAccessCode") || 0);
      shareMode = pick("shareMode") || (needAccessCode ? "1" : "3");
      shareAuthor = pick("nickName") || pick("creatorNickname") || pick("userName");
    }

    if (needAccessCode === 1) {
      if (!accessCode) {
        const rootTree = fileName ? [{ name: fileName, path: fileName, depth: 0, is_dir: isFolder, size: fileSize }] : [];
        return { result: "ok", rawCode: "200", httpStatus, requestUrl: reqUrl, message: "链接有效(需提取码)", fileTree: rootTree, totalSize: fileSize, shareAuthor };
      }
      try {
        const chkUrl = `https://cloud.189.cn/api/open/share/checkAccessCode.action?shareCode=${encodeURIComponent(shareId)}&accessCode=${encodeURIComponent(accessCode)}`;
        const chkRes = await fetchWithTimeout(chkUrl, { headers: { Accept: "application/json;charset=UTF-8" } });
        if (chkRes.ok) {
          const chkText = await chkRes.text();
          const cj = safeJsonParse(chkText);
          if (cj?.shareId) {
            shareIdNum = String(cj.shareId);
          } else {
            const mSid = chkText.match(/<shareId>([^<]+)<\/shareId>/i);
            if (mSid) shareIdNum = mSid[1].trim();
          }
        }
      } catch {}
    }

    const rootRaw = fileName
      ? [{ id: rootFileId, name: fileName, is_dir: isFolder, size: fileSize }]
      : [];

    let fileTree = rootRaw.map((x) => ({ name: x.name, path: x.name, depth: 0, is_dir: x.is_dir, size: x.size }));
    let totalSize = fileSize;
    let treeTruncated = false;

    if (isFolder && shareIdNum && rootFileId) {
      setShareSession("tianyi", shareUrl, { shareIdNum, rootFileId, shareMode, accessCode });
      const parseTianyiDirItems = (bodyText) => {
        const items = [];
        const j = safeJsonParse(bodyText);
        if (j && Number(j.res_code) === 0 && j.fileListAO) {
          const folders = Array.isArray(j.fileListAO.folderList) ? j.fileListAO.folderList : [];
          const files = Array.isArray(j.fileListAO.fileList) ? j.fileListAO.fileList : [];
          for (const d of folders) {
            items.push({ id: String(d?.id || ""), name: String(d?.name || "").trim(), is_dir: true, size: 0 });
          }
          for (const f of files) {
            items.push({ id: String(f?.id || ""), name: String(f?.name || "").trim(), is_dir: false, size: Number(f?.size || 0) });
          }
          return items;
        }
        const folderBlocks = bodyText.match(/<folder>[\s\S]*?<\/folder>/gi) || [];
        for (const blk of folderBlocks) {
          const mid = blk.match(/<id>([^<]+)<\/id>/i);
          const mnm = blk.match(/<name>([^<]+)<\/name>/i);
          if (mnm) items.push({ id: mid ? mid[1].trim() : "", name: mnm[1].trim(), is_dir: true, size: 0 });
        }
        const fileBlocks = bodyText.match(/<file>[\s\S]*?<\/file>/gi) || [];
        for (const blk of fileBlocks) {
          const mid = blk.match(/<id>([^<]+)<\/id>/i);
          const mnm = blk.match(/<name>([^<]+)<\/name>/i);
          const msz = blk.match(/<size>(\d+)<\/size>/i);
          if (mnm) items.push({ id: mid ? mid[1].trim() : "", name: mnm[1].trim(), is_dir: false, size: msz ? Number(msz[1]) : 0 });
        }
        return items;
      };

      const fetchTianyiDir = async (fid, dirFileId) => {
        const qs = new URLSearchParams({
          noCache: String(Math.random()),
          pageNum: "1",
          pageSize: "20",
          fileId: fid,
          shareDirFileId: dirFileId,
          isFolder: "true",
          shareId: shareIdNum,
          shareMode,
          iconOption: "5",
          orderBy: "lastOpTime",
          descending: "true",
          accessCode
        });
        const r = await fetchWithTimeout(`https://cloud.189.cn/api/open/share/listShareDir.action?${qs.toString()}`, {
          headers: { Accept: "application/json;charset=UTF-8" }
        });
        if (!r.ok) return [];
        const txt = await r.text().catch(() => "");
        return parseTianyiDirItems(txt);
      };

      const treeRes = await collectMultiLevelTree(rootRaw, async (fid) => {
        let items = await fetchTianyiDir(fid, rootFileId);
        if (items.length === 0 && fid !== rootFileId) {
          items = await fetchTianyiDir(fid, fid);
        }
        return items;
      });
      if (treeRes.fileTree.length > 0) {
        fileTree = treeRes.fileTree;
        totalSize = fileSize || treeRes.totalSize;
        treeTruncated = Boolean(treeRes.truncated);
      }
    }

    return {
      result: "ok",
      rawCode: "200",
      httpStatus,
      requestUrl: reqUrl,
      message: fileTree.length ? `链接有效(${fileTree.length}${treeTruncated ? "+" : ""}项)` : "链接有效",
      fileTree,
      totalSize,
      treeTruncated,
      shareAuthor
    };
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
    limit: "100",
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
      const rootRaw = infoList.slice(0, 100).map((it) => ({
        id: String(it?.FileId || ""),
        name: String(it?.FileName || "").trim(),
        is_dir: Number(it?.Type) === 1,
        size: Number(it?.Size || 0)
      })).filter((x) => x.name);
      setShareSession("123", shareUrl, { shareId, pwd });
      const { fileTree, totalSize, truncated: treeTruncated } = await collectMultiLevelTree(rootRaw, async (parentFileId) => {
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
      return { result: "ok", rawCode: String(code), httpStatus, requestUrl: reqUrl, message: fileTree.length ? `链接有效(${fileTree.length}${treeTruncated ? "+" : ""}项)` : "链接有效", fileTree, totalSize, treeTruncated, shareAuthor };
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
    limit: "100",
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
      const rootRaw = list.slice(0, 100).map((it) => ({
        id: String(it?.cid || ""),
        name: String(it?.n || "").trim(),
        is_dir: !it?.fid && Boolean(it?.cid),
        size: Number(it?.s || 0)
      })).filter((x) => x.name);
      setShareSession("115", shareUrl, { shareId, pwd });
      const { fileTree, totalSize: calcSize, truncated: treeTruncated } = await collectMultiLevelTree(rootRaw, async (cid) => {
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
      return { result: "ok", rawCode: "200", httpStatus, requestUrl: reqUrl, message: fileTree.length ? `链接有效(${fileTree.length}${treeTruncated ? "+" : ""}项)` : "链接有效", fileTree, totalSize, treeTruncated, shareAuthor };
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

async function checkMobile139(shareUrl, shareCode = "") {
  const raw = String(shareUrl || "").trim();
  let linkId = "";
  let pwd = (shareCode || "").trim();
  const mId = raw.match(/\/w\/i\/([A-Za-z0-9_-]+)|\/share\/([A-Za-z0-9_-]+)/i);
  if (mId) linkId = mId[1] || mId[2] || "";
  if (!linkId) {
    try {
      const u = new URL(raw);
      linkId = (u.searchParams.get("linkID") || u.searchParams.get("linkId") || "").trim();
      if (!pwd) pwd = (u.searchParams.get("pwd") || u.searchParams.get("passwd") || "").trim();
    } catch {}
  }
  if (!linkId) {
    return { result: "uncertain", rawCode: "no_id", httpStatus: 0, requestUrl: raw, message: "未解析出移动云盘分享ID" };
  }

  const apiUrl = "https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/getOutLinkInfoV6";
  const fetchPage = async (pcaId = "root") => {
    const payload = {
      getOutLinkInfoReq: {
        account: "",
        linkID: linkId,
        passwd: pwd,
        pCaID: pcaId,
        caSrt: 0,
        coSrt: 0,
        coLstSortType: 0,
        caLstSortType: 0,
        sorts: [{ sortDirection: 0, sortType: 1 }],
        pageInfo: { pageSize: 20, pageNum: 1 }
      }
    };
    return fetchWithTimeout(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*"
      },
      body: JSON.stringify(payload)
    });
  };

  try {
    const res = await fetchPage("root");
    const httpStatus = res.status;
    if (httpStatus === 429 || httpStatus >= 500) {
      return { result: "uncertain", rawCode: String(httpStatus), httpStatus, requestUrl: apiUrl, message: "移动云盘接口繁忙" };
    }
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== "object") {
      return { result: "uncertain", rawCode: `http_${httpStatus}`, httpStatus, requestUrl: apiUrl, message: `非JSON响应(HTTP ${httpStatus})` };
    }
    const rCode = String(json.resultCode ?? "");
    const desc = String(json.desc || json.message || "");
    if (rCode !== "0") {
      if (/提取码|密码|passwd/i.test(desc)) {
        return { result: "ok", rawCode: rCode || "pwd", httpStatus, requestUrl: apiUrl, message: "链接有效(需提取码)" };
      }
      if (/失效|过期|取消|不存在|删除|违规|禁止|关闭|找不到/.test(desc)) {
        return { result: "dead", rawCode: rCode || "139_dead", httpStatus, requestUrl: apiUrl, message: desc || "移动云盘分享已失效或取消" };
      }
      return { result: "uncertain", rawCode: rCode || "unknown", httpStatus, requestUrl: apiUrl, message: desc || `状态码 ${rCode}` };
    }

    const data = json.data || {};
    const shareAuthor = String(data.nickName || "").trim();
    const mapItems = (d) => {
      const caLst = Array.isArray(d?.caLst) ? d.caLst : [];
      const coLst = Array.isArray(d?.coLst) ? d.coLst : [];
      const dirs = caLst.map((x) => ({
        id: String(x?.caID || ""),
        name: String(x?.caName || "").trim(),
        is_dir: true,
        size: 0
      }));
      const files = coLst.map((x) => ({
        id: String(x?.coID || ""),
        name: String(x?.coName || "").trim(),
        is_dir: false,
        size: Number(x?.coSize || 0)
      }));
      return [...dirs, ...files].filter((x) => x.name);
    };

    const rootRaw = mapItems(data);
    if (rootRaw.length === 0 && !data.lkName) {
      return { result: "dead", rawCode: "empty_share", httpStatus, requestUrl: apiUrl, message: "分享文件列表为空或已失效" };
    }

    setShareSession("mobile", shareUrl, { linkId, pwd });
    const { fileTree, totalSize, truncated: treeTruncated } = await collectMultiLevelTree(rootRaw, async (caId) => {
      if (!caId) return [];
      const r = await fetchPage(caId);
      if (!r.ok) return [];
      const j = await r.json().catch(() => null);
      if (!j || String(j.resultCode ?? "") !== "0") return [];
      return mapItems(j.data || {});
    });

    return {
      result: "ok",
      rawCode: "0",
      httpStatus,
      requestUrl: apiUrl,
      message: fileTree.length ? `链接有效(${fileTree.length}${treeTruncated ? "+" : ""}项)` : "链接有效",
      fileTree,
      totalSize,
      treeTruncated,
      shareAuthor
    };
  } catch (err) {
    return { result: "uncertain", rawCode: "network", httpStatus: 0, requestUrl: apiUrl, message: `请求异常: ${err?.message || "超时"}` };
  }
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
const xunleiCaptchaCache = new Map();

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

async function getXunleiCaptchaToken(force = false, action = "GET:/drive/v1/share") {
  const now = Date.now();
  const cached = xunleiCaptchaCache.get(action);
  if (!force && cached && cached.token && now - cached.ts < 180000) {
    return cached.token;
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
        action,
        captcha_token: cached?.token || "",
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
        xunleiCaptchaCache.set(action, { token: j.captcha_token, ts: now });
        return j.captcha_token;
      }
    }
  } catch {}
  return cached?.token || "";
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
      const rootRaw = files.slice(0, 100).map((it) => ({
        id: String(it?.id || ""),
        name: String(it?.name || "").trim(),
        is_dir: String(it?.kind || "").includes("folder"),
        size: Number(it?.size || 0)
      })).filter((x) => x.name);
      const passCodeToken = String(data?.pass_code_token || "");
      const xlPageTokens = {};
      setShareSession("xunlei", shareUrl, { shareId, passCodeToken, finalCode, pageTokens: xlPageTokens });
      const { fileTree, totalSize, truncated: treeTruncated } = await collectMultiLevelTree(rootRaw, async (parentId) => {
        const subQs = new URLSearchParams({ share_id: shareId, parent_id: parentId, limit: "20", thumbnail_size: "SIZE_SMALL" });
        if (passCodeToken) subQs.set("pass_code_token", passCodeToken);
        else if (finalCode) subQs.set("pass_code", finalCode);
        const detailCap = await getXunleiCaptchaToken(false, "GET:/drive/v1/share/detail");
        const hdrs = {
          "Accept": "application/json, text/plain, */*",
          "x-client-id": XL_ANDROID_CLIENT_ID,
          "x-client-version": XL_ANDROID_CLIENT_VERSION,
          "x-device-id": devId
        };
        if (detailCap) hdrs["x-captcha-token"] = detailCap;
        const r = await fetchWithTimeout(`https://api-pan.xunlei.com/drive/v1/share/detail?${subQs.toString()}`, { method: "GET", headers: hdrs });
        if (!r.ok) return [];
        const j = await r.json().catch(() => null);
        if (j?.next_page_token) xlPageTokens[parentId] = String(j.next_page_token);
        const arr = Array.isArray(j?.files) ? j.files : [];
        return arr.map((it) => ({ id: String(it?.id || ""), name: it?.name, is_dir: String(it?.kind || "").includes("folder"), size: Number(it?.size || 0) }));
      });
      const shareAuthor = String(data?.user_info?.nick_name || data?.user_info?.name || data?.user_info?.nickname || data?.share?.nick_name || "").trim();
      return { result: "ok", rawCode: stStr || "200", httpStatus, requestUrl: reqUrl, message: fileTree.length ? `链接有效(${fileTree.length}${treeTruncated ? "+" : ""}项)` : "链接有效", fileTree, totalSize, treeTruncated, shareAuthor };
    }
    return { result: "uncertain", rawCode: stStr || "unknown", httpStatus, requestUrl: reqUrl, message: stText || "迅雷返回状态不明确" };
  } catch (err) {
    return { result: "uncertain", rawCode: "network", httpStatus: 0, requestUrl: reqUrl, message: `请求异常: ${err?.message || "超时"}` };
  }
}

async function checkBaidu(shareUrl, shareCode = "") {
  let surl = "";
  let pwd = (shareCode || "").trim();
  try {
    const u = new URL(String(shareUrl || "").trim());
    const qSurl = (u.searchParams.get("surl") || "").trim();
    if (qSurl) {
      surl = qSurl;
    } else {
      const m = u.pathname.match(/\/s\/([A-Za-z0-9_-]+)/i);
      if (m) {
        surl = m[1].startsWith("1") && m[1].length > 1 ? m[1].slice(1) : m[1];
      }
    }
    if (!pwd) {
      pwd = (u.searchParams.get("pwd") || "").trim();
    }
  } catch {}

  const fallbackHtml = () => checkHtmlPage(
    shareUrl,
    [/分享的文件已经被取消/, /此链接分享内容可能因为涉及侵权/, /啊哦，你来晚了/, /分享已过期/, /链接不存在/],
    [/请输入提取码/, /yunData/, /share_title/, /提取文件/]
  );

  if (!surl) return fallbackHtml();

  const fetchBaidu = async (url, options = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      return await fetch(url, { ...options, signal: ctrl.signal, credentials: "include" });
    } finally {
      clearTimeout(timer);
    }
  };

  let sekey = "";
  if (pwd) {
    try {
      const verifyQs = new URLSearchParams({
        surl,
        t: String(Date.now()),
        channel: "chunlei",
        web: "1",
        app_id: "250528",
        clienttype: "0"
      });
      const verifyUrl = `https://pan.baidu.com/share/verify?${verifyQs.toString()}`;
      const vRes = await fetchBaidu(verifyUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "Accept": "application/json, text/plain, */*"
        },
        body: new URLSearchParams({ pwd, vcode: "", vcode_str: "" }).toString()
      });
      if (vRes.ok) {
        const vData = await vRes.json().catch(() => null);
        const vErrno = Number(vData?.errno);
        if (vErrno === 0 && vData?.randsk) {
          try {
            sekey = decodeURIComponent(String(vData.randsk));
          } catch {
            sekey = String(vData.randsk);
          }
        } else if (vErrno === -9 || vErrno === -12) {
          return { result: "ok", rawCode: String(vErrno), httpStatus: vRes.status, requestUrl: verifyUrl, message: "链接有效(提取码错误或需提取码)" };
        } else if ([-7, 105, 110, 115, 145].includes(vErrno)) {
          return { result: "dead", rawCode: String(vErrno), httpStatus: vRes.status, requestUrl: verifyUrl, message: String(vData?.err_msg || vData?.show_msg || "百度分享已失效或取消") };
        }
      }
    } catch {}
  }

  const fetchListPage = async (paramsObj) => {
    const qs = new URLSearchParams({
      is_from_web: "true",
      page: "1",
      num: "20",
      order: "name",
      desc: "0",
      showempty: "0",
      view_mode: "1",
      web: "1",
      channel: "chunlei",
      app_id: "250528",
      clienttype: "0",
      ...paramsObj
    });
    const listUrl = `https://pan.baidu.com/share/list?${qs.toString()}`;
    const res = await fetchBaidu(listUrl, {
      method: "GET",
      headers: { "Accept": "application/json, text/plain, */*" }
    });
    return { res, listUrl };
  };

  try {
    const rootParams = { shorturl: surl, root: "1" };
    if (sekey) rootParams.sekey = sekey;
    const { res, listUrl } = await fetchListPage(rootParams);
    const httpStatus = res.status;
    if (httpStatus === 429 || httpStatus >= 500) return fallbackHtml();

    const data = await res.json().catch(() => null);
    if (!data || typeof data !== "object" || data.errno === undefined) {
      return fallbackHtml();
    }

    const errno = Number(data.errno);
    const errMsg = String(data.show_msg || data.errmsg || "");
    if (errno === -9 || errno === -12) {
      return { result: "ok", rawCode: String(errno), httpStatus, requestUrl: listUrl, message: "链接有效(需提取码)" };
    }
    if ([-7, 105, 110, 115, 145].includes(errno)) {
      return { result: "dead", rawCode: String(errno), httpStatus, requestUrl: listUrl, message: errMsg || "百度分享已失效或取消" };
    }
    // 9019 (need verify), -6 (未登录), -62 (验证码), 2 (参数错误) 等风控或会话异常绝不误判失效，回退 HTML 探测
    if (errno !== 0) {
      return fallbackHtml();
    }

    const list = Array.isArray(data.list) ? data.list : [];
    if (list.length === 0) {
      return fallbackHtml();
    }

    const uk = String(data.uk || "");
    const shareid = String(data.share_id || data.shareid || "");
    const rootRaw = list.slice(0, 100).map((it) => ({
      id: String(it?.path || it?.fs_id || ""),
      name: String(it?.server_filename || "").trim(),
      is_dir: Number(it?.isdir) === 1,
      size: Number(it?.size || 0)
    })).filter((x) => x.name);

    setShareSession("baidu", shareUrl, { surl, uk, shareid, sekey });
    const { fileTree, totalSize, truncated: treeTruncated } = await collectMultiLevelTree(rootRaw, async (dirPath) => {
      if (!dirPath || !dirPath.startsWith("/")) return [];
      const querySub = async (targetDir) => {
        const subParams = (uk && shareid)
          ? { uk, shareid, dir: targetDir }
          : { shorturl: surl, root: "0", dir: targetDir };
        if (sekey) subParams.sekey = sekey;
        const { res: subRes } = await fetchListPage(subParams);
        if (!subRes.ok) return null;
        return subRes.json().catch(() => null);
      };
      let j = await querySub(dirPath);
      if ((!j || Number(j.errno) !== 0) && uk && dirPath.startsWith("/sharelink0-")) {
        j = await querySub(dirPath.replace(/^\/sharelink0-/, `/sharelink${uk}-`));
      }
      if (!j || Number(j.errno) !== 0) return [];
      const arr = Array.isArray(j.list) ? j.list : [];
      return arr.map((it) => ({
        id: String(it?.path || it?.fs_id || ""),
        name: String(it?.server_filename || "").trim(),
        is_dir: Number(it?.isdir) === 1,
        size: Number(it?.size || 0)
      }));
    });

    const shareAuthor = String(data.uname || data.user?.uname || "").trim();
    return {
      result: "ok",
      rawCode: "0",
      httpStatus,
      requestUrl: listUrl,
      message: fileTree.length ? `链接有效(${fileTree.length}${treeTruncated ? "+" : ""}项)` : "链接有效",
      fileTree,
      totalSize,
      treeTruncated,
      shareAuthor
    };
  } catch {
    return fallbackHtml();
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
  if (pan === "aliyun" || pan === "alipan") return checkAliyun(shareId, shareCode, shareUrl);
  if (pan === "tianyi" || pan === "189") return checkTianyi(shareId, shareCode, shareUrl);
  if (pan === "123" || pan === "pan123") return checkPan123(shareId, shareCode, shareUrl);
  if (pan === "115" || pan === "pan115") return checkPan115(shareId, shareCode, shareUrl);
  if (pan === "mobile" || pan === "139") return checkMobile139(shareUrl, shareCode);
  if (pan === "xunlei" || pan === "thunder") return checkXunlei(shareId, shareCode, shareUrl);
  if (pan === "baidu") return checkBaidu(shareUrl, shareCode);
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
        tree_truncated: Boolean(checkRes.treeTruncated),
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
            origin: origin || "",
            slug: task.slug || "",
            panType: task.pan_type || "",
            shareUrl: task.share_link || "",
            shareCode: task.share_code || "",
            shareAuthor: authorStr,
            totalSize: totalBytes,
            treeTruncated: Boolean(checkRes.treeTruncated),
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


// 按需展开单个未采样文件夹（仅发 1 次子目录请求，必要时自动补拉会话令牌，绝不从头重新测活）
async function expandSingleFolder({ panType, shareUrl, shareCode = "", folderId, folderPath, depth = 0, page = 1 }) {
  const pageNum = Math.max(1, Number(page || 1));
  const pan = String(panType || "").toLowerCase();
  const fid = String(folderId || "").trim();
  const fpath = String(folderPath || "").trim();
  if (!fid || !fpath) return { ok: false, message: "缺少文件夹标识" };
  const shareId = extractShareId(pan, shareUrl);
  let pwd = String(shareCode || "").trim();
  if (!pwd && shareUrl) {
    try {
      const u = new URL(shareUrl);
      pwd = (u.searchParams.get("pwd") || u.searchParams.get("pass_code") || u.searchParams.get("password") || u.searchParams.get("accessCode") || "").trim();
    } catch {}
  }

  let rawKids = [];
  let cursorHasMore = null;
  try {
    if (pan === "quark" || pan === "uc") {
      const apiBase = pan === "uc" ? "https://pc-api.uc.cn" : "https://drive-h.quark.cn";
      const prCode = pan === "uc" ? "UCBrowser" : "ucpro";
      let sess = getShareSession(pan, shareUrl);
      if (!sess || !sess.stoken) {
        const tRes = await fetchWithTimeout(`${apiBase}/1/clouddrive/share/sharepage/token?pr=${encodeURIComponent(prCode)}&fr=pc&uc_param_str=`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/plain, */*" },
          body: JSON.stringify({ pwd_id: shareId, passcode: pwd, support_visit_limit_private_share: true })
        });
        const tj = await tRes.json().catch(() => null);
        if (tj?.data?.stoken) {
          sess = { apiBase, prCode, shareId, stoken: String(tj.data.stoken) };
          setShareSession(pan, shareUrl, sess);
        }
      }
      if (!sess?.stoken) return { ok: false, message: "无法获取网盘访问令牌" };
      const qs = new URLSearchParams({
        pr: sess.prCode, fr: "pc", uc_param_str: "", pwd_id: sess.shareId, stoken: sess.stoken,
        pdir_fid: fid, force: "0", _page: String(pageNum), _size: "20", _fetch_banner: "0", _fetch_share: "0", _fetch_total: "0"
      });
      const r = await fetchWithTimeout(`${sess.apiBase}/1/clouddrive/share/sharepage/detail?${qs.toString()}`, {
        headers: { Accept: "application/json, text/plain, */*" }
      });
      const j = await r.json().catch(() => null);
      const arr = Array.isArray(j?.data?.list) ? j.data.list : [];
      rawKids = arr.map((it) => ({ id: String(it?.fid || ""), name: String(it?.file_name || "").trim(), is_dir: Boolean(it?.dir), size: Number(it?.size || 0) }));
    } else if (pan === "aliyun" || pan === "alipan") {
      let sess = getShareSession("aliyun", `https://www.alipan.com/s/${shareId}`);
      if (!sess?.shareToken) {
        const tRes = await fetchWithTimeout("https://api.aliyundrive.com/v2/share_link/get_share_token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pwd ? { share_id: shareId, share_pwd: pwd } : { share_id: shareId })
        });
        const tj = await tRes.json().catch(() => null);
        if (tj?.share_token) {
          sess = { shareId, shareToken: tj.share_token };
          setShareSession("aliyun", `https://www.alipan.com/s/${shareId}`, sess);
        }
      }
      if (!sess?.shareToken) return { ok: false, message: "无法获取阿里云盘令牌" };
      sess.markers = sess.markers || {};
      const aliReqBody = { share_id: sess.shareId, parent_file_id: fid, limit: 20 };
      if (pageNum > 1) {
        if (!sess.markers[fid]) {
          return { ok: true, children: [], addedSize: 0, hasMore: false, nextPage: pageNum };
        }
        aliReqBody.marker = sess.markers[fid];
      }
      const r = await fetchWithTimeout("https://api.aliyundrive.com/adrive/v2/file/list_by_share", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-share-token": sess.shareToken },
        body: JSON.stringify(aliReqBody)
      });
      const j = await r.json().catch(() => null);
      sess.markers[fid] = j?.next_marker ? String(j.next_marker) : "";
      cursorHasMore = Boolean(sess.markers[fid]);
      const arr = Array.isArray(j?.items) ? j.items : [];
      rawKids = arr.filter((it) => Number(it?.punish_flag || 0) !== 2).map((it) => ({
        id: String(it?.file_id || ""), name: String(it?.name || "").trim(), is_dir: String(it?.type || "").toLowerCase() === "folder", size: Number(it?.size || 0)
      }));
    } else if (pan === "tianyi" || pan === "189") {
      let sess = getShareSession("tianyi", shareUrl);
      if (!sess?.shareIdNum || !sess?.rootFileId) {
        const infoRes = await fetchWithTimeout(`https://cloud.189.cn/api/open/share/getShareInfoByCodeV2.action?shareCode=${encodeURIComponent(shareId)}`, {
          headers: { Accept: "application/json;charset=UTF-8" }
        });
        const info = safeJsonParse(await infoRes.text().catch(() => ""));
        let shareIdNum = String(info?.shareId || "");
        const rootFileId = String(info?.fileId || "");
        const shareMode = String(info?.shareMode || (info?.needAccessCode ? "1" : "3"));
        if (Number(info?.needAccessCode || 0) === 1 && pwd) {
          const chk = await fetchWithTimeout(`https://cloud.189.cn/api/open/share/checkAccessCode.action?shareCode=${encodeURIComponent(shareId)}&accessCode=${encodeURIComponent(pwd)}`, {
            headers: { Accept: "application/json;charset=UTF-8" }
          });
          const cj = safeJsonParse(await chk.text().catch(() => ""));
          if (cj?.shareId) shareIdNum = String(cj.shareId);
        }
        if (shareIdNum && rootFileId) {
          sess = { shareIdNum, rootFileId, shareMode, accessCode: pwd };
          setShareSession("tianyi", shareUrl, sess);
        }
      }
      if (!sess?.shareIdNum) return { ok: false, message: "无法获取天翼分享会话" };
      const fetchDir = async (dirFileId) => {
        const qs = new URLSearchParams({
          noCache: String(Math.random()), pageNum: String(pageNum), pageSize: "20", fileId: fid, shareDirFileId: dirFileId,
          isFolder: "true", shareId: sess.shareIdNum, shareMode: sess.shareMode, iconOption: "5",
          orderBy: "lastOpTime", descending: "true", accessCode: sess.accessCode || ""
        });
        const r = await fetchWithTimeout(`https://cloud.189.cn/api/open/share/listShareDir.action?${qs.toString()}`, {
          headers: { Accept: "application/json;charset=UTF-8" }
        });
        if (!r.ok) return [];
        const txt = await r.text().catch(() => "");
        const j = safeJsonParse(txt);
        const out = [];
        if (j && Number(j.res_code) === 0 && j.fileListAO) {
          for (const d of (j.fileListAO.folderList || [])) out.push({ id: String(d?.id || ""), name: String(d?.name || "").trim(), is_dir: true, size: 0 });
          for (const f of (j.fileListAO.fileList || [])) out.push({ id: String(f?.id || ""), name: String(f?.name || "").trim(), is_dir: false, size: Number(f?.size || 0) });
        }
        return out;
      };
      rawKids = await fetchDir(sess.rootFileId);
      if (rawKids.length === 0 && fid !== sess.rootFileId) rawKids = await fetchDir(fid);
    } else if (pan === "mobile" || pan === "139") {
      let sess = getShareSession("mobile", shareUrl);
      if (!sess?.linkId) {
        const mId = String(shareUrl || "").match(/\/w\/i\/([A-Za-z0-9_-]+)|\/share\/([A-Za-z0-9_-]+)/i);
        const linkId = mId ? (mId[1] || mId[2] || "") : "";
        if (linkId) {
          sess = { linkId, pwd };
          setShareSession("mobile", shareUrl, sess);
        }
      }
      if (!sess?.linkId) return { ok: false, message: "未解析出移动云盘分享ID" };
      const r = await fetchWithTimeout("https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/getOutLinkInfoV6", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/plain, */*" },
        body: JSON.stringify({
          getOutLinkInfoReq: {
            account: "", linkID: sess.linkId, passwd: sess.pwd || "", pCaID: fid,
            caSrt: 0, coSrt: 0, coLstSortType: 0, caLstSortType: 0,
            sorts: [{ sortDirection: 0, sortType: 1 }], pageInfo: { pageSize: 20, pageNum }
          }
        })
      });
      const j = await r.json().catch(() => null);
      if (j && String(j.resultCode ?? "") === "0" && j.data) {
        const dirs = (j.data.caLst || []).map((x) => ({ id: String(x?.caID || ""), name: String(x?.caName || "").trim(), is_dir: true, size: 0 }));
        const files = (j.data.coLst || []).map((x) => ({ id: String(x?.coID || ""), name: String(x?.coName || "").trim(), is_dir: false, size: Number(x?.coSize || 0) }));
        rawKids = [...dirs, ...files];
      }
    } else if (pan === "123" || pan === "pan123") {
      const qs = new URLSearchParams({
        limit: "20", next: "0", orderBy: "file_name", orderDirection: "asc",
        parentFileId: fid, shareKey: shareId, SharePwd: pwd, Page: String(pageNum)
      });
      const r = await fetchWithTimeout(`https://yun.123pan.com/b/api/share/get?${qs.toString()}`, {
        headers: { Accept: "application/json, text/plain, */*", Platform: "web" }
      });
      const j = await r.json().catch(() => null);
      const arr = Array.isArray(j?.data?.InfoList) ? j.data.InfoList : [];
      rawKids = arr.map((it) => ({ id: String(it?.FileId || ""), name: String(it?.FileName || "").trim(), is_dir: Number(it?.Type) === 1, size: Number(it?.Size || 0) }));
    } else if (pan === "115" || pan === "pan115") {
      const qs = new URLSearchParams({ share_code: shareId, receive_code: pwd, offset: String((pageNum - 1) * 20), limit: "20", cid: fid });
      const r = await fetchWithTimeout(`https://webapi.115.com/share/snap?${qs.toString()}`, {
        headers: { Accept: "application/json, text/javascript, */*; q=0.01" }
      });
      const j = await r.json().catch(() => null);
      const arr = Array.isArray(j?.data?.list) ? j.data.list : [];
      rawKids = arr.map((it) => ({ id: String(it?.cid || ""), name: String(it?.n || "").trim(), is_dir: !it?.fid && Boolean(it?.cid), size: Number(it?.s || 0) }));
    } else if (pan === "xunlei" || pan === "thunder") {
      let sess = getShareSession("xunlei", shareUrl);
      const devId = getXunleiDeviceId();
      if (!sess) {
        sess = { shareId, passCodeToken: "", finalCode: pwd, pageTokens: {} };
        setShareSession("xunlei", shareUrl, sess);
      }
      sess.pageTokens = sess.pageTokens || {};
      if (!sess.passCodeToken && pwd) {
        try {
          const initQs = new URLSearchParams({ share_id: shareId, pass_code: pwd });
          const initCap = await getXunleiCaptchaToken(false, "GET:/drive/v1/share");
          const initHdrs = { Accept: "application/json, text/plain, */*", "x-client-id": XL_ANDROID_CLIENT_ID, "x-client-version": XL_ANDROID_CLIENT_VERSION, "x-device-id": devId };
          if (initCap) initHdrs["x-captcha-token"] = initCap;
          const initRes = await fetchWithTimeout(`https://api-pan.xunlei.com/drive/v1/share?${initQs.toString()}`, { method: "GET", headers: initHdrs });
          const initJson = await initRes.json().catch(() => null);
          if (initJson?.pass_code_token) sess.passCodeToken = String(initJson.pass_code_token);
        } catch {}
      }
      const subQs = new URLSearchParams({ share_id: shareId, parent_id: fid, limit: "20", thumbnail_size: "SIZE_SMALL" });
      if (sess.passCodeToken) subQs.set("pass_code_token", sess.passCodeToken);
      else if (pwd) subQs.set("pass_code", pwd);
      if (pageNum > 1) {
        if (!sess.pageTokens[fid]) {
          return { ok: true, children: [], addedSize: 0, hasMore: false, nextPage: pageNum };
        }
        subQs.set("page_token", sess.pageTokens[fid]);
      }
      const cap = await getXunleiCaptchaToken(false, "GET:/drive/v1/share/detail");
      const hdrs = { Accept: "application/json, text/plain, */*", "x-client-id": XL_ANDROID_CLIENT_ID, "x-client-version": XL_ANDROID_CLIENT_VERSION, "x-device-id": devId };
      if (cap) hdrs["x-captcha-token"] = cap;
      const r = await fetchWithTimeout(`https://api-pan.xunlei.com/drive/v1/share/detail?${subQs.toString()}`, { method: "GET", headers: hdrs });
      const j = await r.json().catch(() => null);
      sess.pageTokens[fid] = j?.next_page_token ? String(j.next_page_token) : "";
      cursorHasMore = Boolean(sess.pageTokens[fid]);
      const arr = Array.isArray(j?.files) ? j.files : [];
      rawKids = arr.map((it) => ({ id: String(it?.id || ""), name: String(it?.name || "").trim(), is_dir: String(it?.kind || "").includes("folder"), size: Number(it?.size || 0) }));
    } else if (pan === "baidu") {
      let sess = getShareSession("baidu", shareUrl);
      if (!sess?.surl) {
        const m = String(shareUrl || "").match(/\/s\/([A-Za-z0-9_-]+)/i);
        const surl = m ? (m[1].startsWith("1") && m[1].length > 1 ? m[1].slice(1) : m[1]) : "";
        sess = { surl, uk: "", shareid: "", sekey: "" };
      }
      const qs = new URLSearchParams({
        is_from_web: "true", page: String(pageNum), num: "20", order: "name", desc: "0", showempty: "0",
        view_mode: "1", web: "1", channel: "chunlei", app_id: "250528", clienttype: "0",
        ...(sess.uk && sess.shareid ? { uk: sess.uk, shareid: sess.shareid, dir: fid } : { shorturl: sess.surl, root: "0", dir: fid }),
        ...(sess.sekey ? { sekey: sess.sekey } : {})
      });
      const r = await fetch(`https://pan.baidu.com/share/list?${qs.toString()}`, { credentials: "include", headers: { Accept: "application/json, text/plain, */*" } });
      const j = await r.json().catch(() => null);
      const arr = Array.isArray(j?.list) ? j.list : [];
      rawKids = arr.map((it) => ({ id: String(it?.path || it?.fs_id || ""), name: String(it?.server_filename || "").trim(), is_dir: Number(it?.isdir) === 1, size: Number(it?.size || 0) }));
    } else {
      return { ok: false, message: `暂不支持该网盘按需展开(${pan})` };
    }
  } catch (err) {
    return { ok: false, message: `请求异常: ${err?.message || "超时"}` };
  }

  const children = rawKids.filter((x) => x.name).slice(0, 100).map((it) => ({
    name: it.name,
    path: `${fpath}/${it.name}`,
    depth: Number(depth || 0) + 1,
    is_dir: Boolean(it.is_dir),
    size: it.is_dir ? 0 : (Number(it.size || 0) || 0),
    ...(it.is_dir ? { node_id: String(it.id || ""), expanded: false } : {})
  }));
  const addedSize = children.reduce((acc, x) => acc + (x.is_dir ? 0 : (Number(x.size) || 0)), 0);
  const hasMore = cursorHasMore !== null ? cursorHasMore : (rawKids.length >= 20);
  return { ok: true, children, addedSize, hasMore, nextPage: pageNum + 1 };
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

  if (msg.action === "EXPAND_FOLDER") {
    (async () => {
      const res = await expandSingleFolder(msg);
      let serverData = null;
      if (res.ok && msg.origin && msg.slug) {
        try {
          const sRes = await fetchWithTimeout(`${msg.origin}/api/client/check/expand-folder`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              slug: msg.slug,
              folder_path: msg.folderPath,
              children: res.children,
              added_size: res.addedSize,
              has_more: Boolean(res.hasMore),
              next_page: Number(res.nextPage || 2)
            })
          });
          if (sRes.ok) serverData = await sRes.json().catch(() => null);
        } catch {}
      }
      const payload = {
        ok: Boolean(res.ok),
        slug: msg.slug || "",
        folderPath: msg.folderPath || "",
        message: res.message || "",
        children: res.children || [],
        file_tree: serverData?.accepted ? serverData.file_tree : null,
        file_size_desc: serverData?.accepted ? serverData.file_size_desc : "",
        tree_truncated: serverData?.accepted ? Boolean(serverData.tree_truncated) : Boolean(res.hasMore)
      };
      // 同步刷新扩展弹窗的 lastPreview，保证在弹窗里点展开后立即可见
      if (payload.ok) {
        try {
          const st = await chrome.storage.local.get(["lastPreview"]);
          const lp = st.lastPreview;
          if (lp && lp.slug === payload.slug) {
            if (Array.isArray(payload.file_tree) && payload.file_tree.length > 0) {
              lp.fileTree = payload.file_tree;
              lp.treeTruncated = Boolean(payload.tree_truncated);
              const treeBytes = lp.fileTree.reduce((acc, x) => acc + (x.is_dir ? 0 : (Number(x.size) || 0)), 0);
              if (treeBytes > Number(lp.totalSize || 0)) lp.totalSize = treeBytes;
            } else if (Array.isArray(payload.children) && Array.isArray(lp.fileTree)) {
              const idx = lp.fileTree.findIndex((x) => (x.path || x.name) === payload.folderPath);
              if (idx >= 0) {
                lp.fileTree[idx].expanded = true;
                lp.fileTree[idx].has_more = Boolean(res.hasMore);
                if (res.hasMore) lp.fileTree[idx].next_page = Number(res.nextPage || 2);
                const pDepth = Number(lp.fileTree[idx].depth || 0);
                let ins = idx + 1;
                while (ins < lp.fileTree.length && Number(lp.fileTree[ins].depth || 0) > pDepth) ins++;
                const existingPaths = new Set(lp.fileTree.map((x) => x.path || x.name));
                const fresh = payload.children.filter((c) => !existingPaths.has(c.path || c.name));
                lp.fileTree.splice(ins, 0, ...fresh);
                lp.totalSize = Number(lp.totalSize || 0) + fresh.reduce((acc, x) => acc + (x.is_dir ? 0 : (Number(x.size) || 0)), 0);
                lp.treeTruncated = lp.fileTree.some((x) => x.is_dir && (x.expanded === false || x.has_more === true));
              }
            }
            await chrome.storage.local.set({ lastPreview: lp });
          }
        } catch {}
      }
      if (sender?.tab?.id) {
        chrome.tabs.sendMessage(sender.tab.id, { action: "MOEPANS_FOLDER_EXPANDED", payload }).catch(() => {});
      }
      sendResponse(payload);
    })();
    return true;
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

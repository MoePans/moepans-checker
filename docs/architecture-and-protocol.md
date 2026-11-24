# MoePans 测活助手：原理与技术细节

本文档详细说明 `moepans-checker` 与 **MoePans** 后端协同工作的完整技术架构、协议规范、防风控设计与安全边界。

---

## 1. 为什么需要浏览器扩展（为什么不能用纯网页 JS）

在浏览器同源策略（CORS）与 Fetch 规范约束下，普通网页前端脚本直接向网盘接口发起探测会遇到两道无法绕过的限制：

1. **CORS 拦截**：百度、阿里、夸克、迅雷等网盘 API 不会向第三方域名返回 `Access-Control-Allow-Origin: *`，网页直接 `fetch()` 会被浏览器直接阻断。
2. **受限请求头（Forbidden Headers）**：W3C Fetch 规范禁止普通网页修改 `Origin`、`Referer` 等请求头，而绝大多数网盘分享接口都会校验来源域。

另一方面，如果完全由 MoePans 服务端集中轮询探测，单一出口 IP 在高并发下极易触发网盘限流、验证码甚至封禁。因此 `moepans-checker` 利用 **Chrome / Edge Manifest V3** 的 `host_permissions` 与 `declarativeNetRequest` 能力，把测活压力安全地分摊到真实用户终端。

---

## 2. 总体架构：双轨协同与通信桥梁

```text
+------------------------------------------------------------------------+
| 用户浏览器                                                              |
|                                                                        |
|  [MoePans 网页] <-- window.postMessage --> [content_moepans.js]        |
|       |                                           |                    |
|       | (1) POST /api/client/check/claim          | chrome.runtime     |
|       v                                           v                    |
|  [MoePans 后端] <--- POST /api/client/check/report --- [background.js] |
|  (租约锁 + 动态TTL + 目录敏感词审查 + 多票软下架)          ^   |        |
|                                                           |   |        |
|  [用户点击打开的网盘分享页] --> [content_netdisk.js] ------+   | fetch  |
|  (轨道一：被动读页 DOM 识别，零额外 API 请求)                   v        |
|                                                        [各大网盘 API]   |
|                                                    (轨道二：主动探测)   |
+------------------------------------------------------------------------+
```

### 轨道一：被动读页模式（默认开启，零额外请求）
1. 用户在 MoePans 详情页点击「打开 XX 网盘转存」时，网页通过 `MOEPANS_TRACK_OUTBOUND` 告知扩展即将访问的 `{ origin, slug, panType, shareUrl }`。
2. `background.js` 将该跳转记录缓存在内存 `pendingVisits` 中（有效期 5 分钟）。
3. 浏览器打开网盘分享页后，`content_netdisk.js` 等待 SPA 渲染完成（分 1.2s / 2.7s / 5.2s 三次轻量检查），读取页面公开文本特征（如「分享已被取消」「该分享已失效，不可访问」「保存到云盘」「请输入提取码」等）。
4. `background.js` 严格核对该 URL 是否存在于 `pendingVisits`（支持域名 302 跳转后的尾部 shareId 匹配），命中后才向对应 MoePans 实例的 `POST /api/client/check/report` 回传 `mode: "passive"`。非 MoePans 跳转的网盘页面直接丢弃，保障隐私。

### 轨道二：主动租约模式（用户可选开启 / 手动点击「验证链接」）
1. **领取租约**：网页向 `POST /api/client/check/claim` 发送当前页的 `slugs` 列表（单次最多领取 `max_tasks <= 5` 条）。
2. **后台队列探测**：`background.js` 以**最大并发 2 + 250~450ms 随机抖动间隔**调用对应网盘的官方分享接口，同时提取根目录文件列表 `file_tree`（最多 30 项）。
3. **带租约回传**：将 `result`（`ok | dead | uncertain`）、`raw_code`、`message`、`file_tree` 连同一次性 `lease_token` 回传给 `POST /api/client/check/report`，并将服务端最新状态推回当前网页实时刷新 UI。

---

## 3. 服务端核心算法（MoePans `CrowdCheckService`）

### 3.1 30 秒原子租约锁（防热点并发惊群）
单纯依赖 `checked_at` 无法防止同一秒 50 个用户搜到同一条刚过期的热剧链接时同时发起 50 次探测。MoePans 后端引入进程内原子租约：
* 每次 `claim` 对命中的 `resource_id` 签发 30 秒锁（`checking_until`）与一次性随机 `lease_token`（绑定 `resource_id` 与客户端 IP 哈希）。
* 同一时间全网只有第 1 个客户端能领到该资源的测活任务，其余客户端自动跳过；若第 1 个客户端中途关闭页面未回传，30 秒后租约自动释放。
* 主动上报接口强制校验并消费 `lease_token`，天然阻断外部脚本伪造请求恶意刷死链。

### 3.2 指数退避动态 TTL 与状态机

| 资源当前状态 | 下次允许自动检测的间隔 | 说明 |
| :--- | :--- | :--- |
| `unknown`（未测） | `0`（立即允许） | 首次访问时即测 |
| `ok`（连续存活 1 次） | `6 小时` | 新热资源易失效，保持较高巡检频率 |
| `ok`（连续存活 2 次） | `24 小时` | 随 `alive_streak` 递增自动降频 |
| `ok`（连续存活 3 次） | `72 小时` | 稳定资源大幅减少无意义请求 |
| `ok`（连续存活 >= 4 次） | `7 天 (168 小时)` | 长期稳定老资源低频保鲜 |
| `suspect`（1 票失效） | 立即允许**其他独立 IP** 复检 | 前台标黄「存疑」；同 IP 自动巡检跳过，避免单点误判 |
| `dead`（2 票独立 IP 确认） | 永久停止自动检测 | 软下架（`status = "offline"`），支持后台一键捞回并重置测活状态 |
| `uncertain`（超时/429/验证码） | 内存冷却 `10 分钟` | **绝不计入失效票**，避免客户端网络波动造成误杀 |

### 3.3 多票软下架与 IP 隐私哈希
* 服务端不直接存储明文用户 IP，而是计算加盐截断 SHA-256 哈希（`hash_ip`）存入 `dead_vote_ips`。
* 累计 **2 个不同 IP** 确认 `dead` 后，将资源软下架至异常库并写入 `crowd_check` 系统日志；管理员在后台恢复上架时会自动清空历史失效票与测活计数。

### 3.4 目录结构采样与敏感词合规审查
当客户端探测返回 `result = "ok"` 且附带 `file_tree`（最多 30 条根目录文件/文件夹名称及大小）、`total_size`（总字节数）与 `share_author`（分享者昵称）时：
1. 服务端先做字段清洗与长度截断（仅保留 `name`、`is_dir`、`size`）。
2. 自动拉取 `sensitive_words` 敏感词库，逐条比对 `file_tree` 中的每个文件/目录名以及 `share_author` 分享者昵称：
   * **命中敏感词**：立即将资源移入敏感词拦截队列（`status = "rejected"`），记录命中的敏感词与具体文件名到 `transfer_error` 及 `crowd_check` 日志，防止“标题正常、网盘内藏违规文件”的漏网资源。
   * **通过审查**：将目录结构持久化到 `resources.file_tree_json`、分享者写入 `resources.share_author`，若资源尚未记录有效体积则自动按 `total_size` 格式化回填 `file_size_desc`；前台详情页即可直接展示「网盘目录预览」与分享者信息，且后续后台新增敏感词时也会追溯扫描存量 `file_tree_json` 与 `share_author`。

---

## 4. 各网盘探测协议与避坑细节

### 4.1 夸克网盘 & UC 网盘（两步深度校验）
* **Step 1**：`POST {apiBase}/1/clouddrive/share/sharepage/token?pr={prCode}&fr=pc&uc_param_str=`（夸克 `pr=ucpro`，UC `pr=UCBrowser`），换取 `stoken` 并检查 `is_expire`。`code === 41008` 表示链接有效但需提取码。
* **Step 2**：携带 `stoken` 调用 `GET {apiBase}/1/clouddrive/share/sharepage/detail?...&_fetch_share=1`，验证 `share.is_expire`、`share.status !== 2` 且 `list.length > 0`，彻底杜绝“token 返回 0 但文件已被清空”的假活误判，同时提取 `list` 作为目录预览。

### 4.2 阿里云盘（三步深度校验）
* **Step 1**：`POST https://api.aliyundrive.com/adrive/v3/share_link/get_share_by_anonymous`，校验错误码、`share_status`、`expiration` 过期时间与 `file_infos`。
* **Step 2**：`POST https://api.aliyundrive.com/v2/share_link/get_share_token`，校验分享是否真正可签发访问令牌（过滤旧缓存壳）。
* **Step 3**：携带 `x-share-token` 调用 `POST https://api.aliyundrive.com/adrive/v2/file/list_by_share` 拉取根目录文件，过滤 `punish_flag === 2`（违规屏蔽）与 `trashed` 条目，确认存在有效文件并提取目录树。

### 4.3 迅雷网盘（安卓协议 10 重 MD5 `captcha_sign`）
* 迅雷分享页为纯前端 SPA，不能用 HTML 关键字判断；而直接调 Web 端 `shield/captcha/init` 无签名会返回 `captcha_invalid`。
* 扩展内置纯 JS MD5（与标准 MD5 位级一致），完整实现了迅雷安卓客户端 10 重加盐 MD5 `captcha_sign` 签名链，向 `https://xluser-ssl.xunlei.com/v1/shield/captcha/init` 换取合法 `x-captcha-token`（内存缓存 3 分钟），再请求 `GET https://api-pan.xunlei.com/drive/v1/share`，精准识别 `OK`、`PASS_CODE_*`、`SENSITIVE_RESOURCE`、`EXPIRED`、`DELETED` 等状态，并提取 `files` 目录树。

### 4.4 123 云盘
* 使用直连 API 网关 `https://yun.123pan.com/b/api/share/get`（避开 `www.123pan.com` 重定向返回 HTML 页面）。
* 精确区分业务状态码：`0 / 200` 为有效，`5113` 为需提取码，`5103` 为分享已被取消，`5104` 为分享已过期；有效时提取 `data.InfoList` 作为目录树。

### 4.5 115 网盘 & 天翼云盘 & 百度网盘 & 移动云盘 (139)
* **115**：`GET https://webapi.115.com/share/snap`，识别 `state`、访问码错误与失效码，并提取 `data.list`。
* **天翼**：`GET https://cloud.189.cn/api/open/share/getShareInfoByCodeV2.action`，识别失效关键字并提取 `fileName`。
* **百度**：请求分享页识别取消/过期/侵权特征与正常提取码/文件特征。
* **移动云盘 (139)**：其 `getOutLinkInfoV6` 外链接口采用加密请求体，主动模式直接提示由打开页面后的被动读页模式识别。

### 4.6 MV3 DNR 规则与零 CORS 污染设计
`rules.json` 通过 `declarativeNetRequest` 为扩展后台发起的 `fetch()` 补充 `Referer` 与 `Origin`。所有规则均显式声明：
```json
"excludedInitiatorDomains": [
  "aliyundrive.com", "alipan.com", "quark.cn", "uc.cn", "baidu.com",
  "189.cn", "xunlei.com", "115.com", "115cdn.com", "anxia.com",
  "123pan.com", "123pan.cn", "123684.com", "123865.com", "123912.com", "139.com"
]
```
确保当用户在浏览器中直接打开任何真实网盘页面（例如旧域名 `www.aliyundrive.com`）时，扩展**绝不篡改**页面自身 XHR 的 `Origin` 头，彻底避免引发浏览器 CORS 报错。

---

## 5. 扩展与 MoePans 通信协议速查

### 网页 ⇄ 扩展 (`window.postMessage`)
* `MOEPANS_EXTENSION_READY`（扩展 → 网页）：通知扩展版本及 `passiveEnabled` / `activeEnabled` 状态。
* `MOEPANS_PING_EXTENSION`（网页 → 扩展）：页面初始化时主动握手探测。
* `MOEPANS_TRACK_OUTBOUND`（网页 → 扩展）：记录用户点击的外部网盘链接用于被动读页匹配。
* `MOEPANS_RUN_ACTIVE_TASKS`（网页 → 扩展）：下发从服务端领取的租约任务列表。
* `MOEPANS_CHECK_RESULT`（扩展 → 网页）：回推最新存活状态、`file_tree` 与提示文案，实时刷新卡片与详情弹窗。

### 扩展 / 网页 ⇄ MoePans 后端 HTTP API
* `POST /api/client/check/claim`：提交 `{ slugs, max_tasks, force }` 领取 30 秒原子租约。
* `POST /api/client/check/report`：提交 `{ slug, share_url, lease_token, mode, result, raw_code, message, file_tree, total_size, share_author }` 回传测活结果、根目录采样列表、分享总字节数与分享者昵称。

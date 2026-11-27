# MoePans 测活助手：原理与技术细节

本文档说明 `moepans-checker`（v1.2.19）与 **MoePans** 后端协同工作的技术架构、双轨协议规范、防风控设计与安全隐私边界。

## 1. 为什么需要浏览器扩展

在浏览器同源策略（CORS）与 Fetch 规范约束下，普通网页前端脚本无法直接跨域探测网盘分享链接状态，也无法设置受限来源头；另一方面，若完全由服务端单出口 IP 集中轮询，高并发下极易触发限流或风控。

`moepans-checker` 基于 **Chrome / Edge Manifest V3** 的 `host_permissions` 与 `declarativeNetRequest` 能力，在严格遵守隐私边界的前提下，将测活与目录采样任务安全地分摊到真实用户终端。

## 2. 总体架构：双轨协同与通信桥梁

```text
+------------------------------------------------------------------------+
| 用户浏览器                                                              |
|                                                                        |
|  [MoePans 网页] <-- window.postMessage --> [content_moepans.js]        |
|       |          (严格同源 origin 校验)           |                    |
|       | (1) POST /api/client/check/claim          | chrome.runtime     |
|       v                                           v                    |
|  [MoePans 后端] <--- POST /api/client/check/report --- [background.js] |
|  (租约锁 + 动态TTL + 目录敏感词审查 + 多票软下架)          ^   |        |
|                                                           |   |        |
|  [用户点击打开的网盘分享页] --> [content_netdisk.js] ------+   | fetch  |
|  (轨道一：被动读页 DOM 识别，零额外 API 请求)                   v        |
|                                                        [各网盘公开页]   |
|                                                    (轨道二：主动探测)   |
+------------------------------------------------------------------------+
```

### 轨道一：被动读页模式（默认开启，零额外请求）
1. 用户在 MoePans 详情页点击打开网盘链接时，网页通过 `MOEPANS_TRACK_OUTBOUND` 告知扩展即将访问的 `{ origin, slug, panType, shareUrl }`。
2. `background.js` 将该跳转记录缓存在内存 `pendingVisits` 中（有效期 5 分钟）。
3. 浏览器打开网盘分享页后，`content_netdisk.js` 在页面渲染完成后轻量检查公开可见状态文案（有效/需提取码/失效取消等）。
4. `background.js` 严格核对该 URL 是否命中 `pendingVisits`，命中后才向对应 MoePans 实例的 `POST /api/client/check/report` 回传 `mode: "passive"`；非 MoePans 跳转的普通网盘浏览记录直接丢弃。

### 轨道二：主动租约模式（用户可选开启 / 手动「验证链接」）
1. **领取租约**：网页向 `POST /api/client/check/claim` 发送当前页的 `slugs` 列表（单次最多领取 `max_tasks <= 5` 条）。
2. **后台低并发探测**：`background.js` 以**最大并发 2 + 250~450ms 随机抖动间隔**完成存活校验、多级目录采样、容量汇总与分享者昵称识别。
3. **带租约回传**：将 `result`（`ok | dead | uncertain`）、`raw_code`、`message`、`file_tree`、`total_size`、`tree_truncated`、`share_author` 连同一次性 `lease_token` 回传至 `POST /api/client/check/report`，并将最新状态推回当前网页实时刷新 UI。

## 3. 服务端核心算法（MoePans `CrowdCheckService`）

### 3.1 30 秒原子租约锁（防热点并发惊群）
* 每次 `claim` 对命中的 `resource_id` 签发 30 秒锁（`checking_until`）与一次性随机 `lease_token`（绑定 `resource_id` 与客户端 IP 哈希）。
* 同一时间全网仅允许 1 个客户端领取该资源任务；若客户端中途关闭页面未回传，30 秒后租约自动释放。
* 主动上报接口强制校验并消费 `lease_token`，阻断外部脚本伪造请求恶意刷死链。

### 3.2 指数退避动态 TTL 与状态机

| 资源当前状态 | 下次允许自动检测的间隔 | 说明 |
| :--- | :--- | :--- |
| `unknown`（未测） | `0`（立即允许） | 首次访问时即测 |
| `ok`（连续存活 1 次） | `6 小时` | 新热资源保持较高巡检频率 |
| `ok`（连续存活 2 次） | `24 小时` | 随 `alive_streak` 递增自动降频 |
| `ok`（连续存活 3 次） | `72 小时` | 稳定资源减少无意义请求 |
| `ok`（连续存活 >= 4 次） | `7 天 (168 小时)` | 长期稳定老资源低频保鲜 |
| `suspect`（1 票失效） | 立即允许**其他独立 IP** 复检 | 前台标黄「存疑」；同 IP 自动巡检跳过 |
| `dead`（2 票独立 IP 确认） | 永久停止自动检测 | 软下架（`status = "offline"`），支持后台一键恢复并重置状态 |
| `uncertain`（超时/429/验证码） | 内存冷却 `10 分钟` | 绝不计入失效票，避免网络波动误杀 |

### 3.3 多票软下架与目录合规审查
* 服务端不存储明文用户 IP，而是以加盐截断 SHA-256 哈希记录投票来源；累计 2 个独立 IP 确认 `dead` 后触发软下架。
* 客户端回传的 `file_tree` 文件名与 `share_author` 昵称均自动经过站内敏感词审查；命中敏感词时移入拦截队列，未命中则持久化目录树并自动回填有效体积。

## 4. 目录树采样、按需懒加载与分页策略

为兼顾预览体验与防风控，扩展对全部 10 大网盘（含 v1.2.14–v1.2.19 新增的光鸭云盘）采用统一的采样与按需展开架构：

1. **首次采样防风控上限**：单页统一按 **20 条** 拉取，首次采样最多 4 层深度 / 12 次子请求 / 80 项；仅当剩余预算足够容纳完整一页时才继续展开下一子目录，避免半页截断漏文件。存在未展开目录或后续分页时，标记 `tree_truncated: true`，前端自动在总数与体积后加 `+`（如 `80+ 项`、`118.25+ GB`）。
2. **DFS 目录展开与精确容量汇总**：对于嵌套目录结构（如光鸭云盘等），通过受控深度的 DFS 递归遍历子目录并汇总真实文件大小，在预算内尽可能提供完整精确体积。
3. **页码与游标双分页兼容**：目录节点携带 `node_id`、`expanded`、`has_more`、`next_page`；游标分页网盘由扩展在短期内存会话缓存（10 分钟 TTL）中维护分页游标，翻页至末尾自动隐藏「加载更多...」。
4. **单目录按需懒加载与无退化合并**：网页详情弹窗与扩展弹窗默认折叠目录；点击未采样文件夹的「展开加载」或「加载更多...」时，扩展仅针对该目标文件夹发 1 次请求，经 `POST /api/client/check/expand-folder` 增量合并入库（单资源上限 1000 项），局部重绘时保留折叠状态与滚动位置；复测时若库中已有更完整目录或更大精确容量不会发生覆盖退化。

## 5. 隐私保护与 MV3 隔离设计

1. **同源通信校验**：`content_moepans.js` 仅在检测到 `<meta name="moepans-crowd-check" content="1">` 的站点注入桥梁，并强制要求 `window.postMessage` 目标与来源均为 `window.location.origin`，防止跨域脚本劫持扩展指令。
2. **零 CORS 污染的 DNR 规则**：`rules.json` 对所有规则显式声明 `excludedInitiatorDomains` 覆盖全部网盘自身域名，确保用户在浏览器直接访问任何网盘网页时，扩展绝不篡改网页自身请求头。
3. **匿名探测原则**：除必要兼容场景外，后台探测默认采用 `credentials: "omit"` 匿名请求，不读取、不存储也不上传用户的网盘登录态。

## 6. 扩展与 MoePans 通信协议速查

### 网页 ⇄ 扩展（`window.postMessage`）
* `MOEPANS_EXTENSION_READY`（扩展 → 网页）：通知扩展版本及被动/主动开关状态。
* `MOEPANS_PING_EXTENSION`（网页 → 扩展）：页面初始化握手探测。
* `MOEPANS_TRACK_OUTBOUND`（网页 → 扩展）：登记用户点击的外部网盘链接用于被动读页匹配。
* `MOEPANS_RUN_ACTIVE_TASKS`（网页 → 扩展）：下发从服务端领取的租约任务列表。
* `MOEPANS_EXPAND_FOLDER`（网页 → 扩展）：按需请求展开单个未采样文件夹或拉取下一页。
* `MOEPANS_CHECK_RESULT`（扩展 → 网页）：回推最新存活状态、`file_tree` 与提示文案。

### 扩展 / 网页 ⇄ MoePans 后端 HTTP API
* `POST /api/client/check/claim`：提交 `{ slugs, max_tasks, force }` 领取 30 秒原子租约。
* `POST /api/client/check/report`：回传测活结果、目录树、总容量、截断标志与分享者昵称。
* `POST /api/client/check/expand-folder`：回传单目录懒加载或翻页结果并执行服务端增量合并。

# MoePans 测活助手 (`moepans-checker`)

[![Manifest V3](https://img.shields.io/badge/Chrome%20%2F%20Edge-Manifest%20V3-10b981?style=flat-square)](https://github.com/MoePans/moepans-checker/releases/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

专为 **MoePans** 打造的轻量级浏览器扩展（支持 Chrome / Edge / Chromium 内核浏览器）。采用**「被动读页为主 + 服务端租约主动测活为辅」**的双轨分布式架构，在客户端以真实用户网络完成网盘链接存活检测与根目录结构预览采样，既彻底消除中心服务器集中探测带来的风控封禁，又为站点提供目录级合规审查与实时目录预览能力。

> **下载地址**：请前往 [GitHub Releases](https://github.com/MoePans/moepans-checker/releases/) 下载最新版本的 `moepans-checker-extension-v*.zip`。

---

## 核心特性

* **双轨分布式测活**
  * **被动读页模式（默认开启，零额外请求）**：从 MoePans 点击跳转到网盘分享页时，页面本来就要加载；扩展仅读取当前已打开页面的公开 DOM 文本特征，识别失效或有效后静默回传，100% 真实浏览行为、零额外 API 请求。
  * **主动租约模式（可选开启，低并发防惊群）**：向 MoePans 后端申请 30 秒原子检测租约（`lease_token`），每页最多领取 5 条、最大并发 2 且带随机间隔，彻底避免热点资源被多客户端重复轰炸。
* **多网盘深度验活 + 目录结构采样**
  * 支持 **夸克、UC、阿里云盘、迅雷、123 云盘、115 网盘、天翼云盘、百度网盘** 主动探测，以及 **移动云盘（139）** 被动读页识别。
  * 在验证存活的同时提取根目录文件列表（最多 30 项：名称、目录/文件标识、文件体积）、**分享总大小**与**分享者昵称**，回传给 MoePans 用于**目录与分享者级敏感词合规审查**、**自动补全资源体积**及**详情页目录预览**。
* **零干扰 CORS 隔离**
  * 所有 `declarativeNetRequest` 请求头改写规则均配置 `excludedInitiatorDomains`，严格排除真实网盘网页域名，绝不干扰用户正常浏览任何网盘页面。
* **内置可导出诊断日志**
  * 扩展弹窗内置最近 100 条结构化测活日志，支持一键复制或导出 `.log`（自动附带扩展版本、导出时间与时区、设备平台、`User-Agent`、开关状态及每条请求的 `api=` 地址），方便快速排查接口变动。

---

## 支持的网盘与检测深度

| 网盘平台 | 主动探测方式 | 是否采样目录结构 | 被动读页识别 |
| :--- | :--- | :---: | :---: |
| **夸克网盘** | `sharepage/token` → `sharepage/detail` 两步校验 | ✅ | ✅ |
| **UC 网盘** | `sharepage/token` → `sharepage/detail` 两步校验 | ✅ | ✅ |
| **阿里云盘** | `get_share_by_anonymous` → `get_share_token` → `list_by_share` 三步校验 | ✅ | ✅ |
| **迅雷网盘** | 安卓协议 10 重 MD5 `captcha_sign` + `drive/v1/share` | ✅ | ✅ |
| **123 云盘** | 直连网关 `yun.123pan.com/b/api/share/get`（区分 `0 / 5103 / 5104 / 5113`） | ✅ | ✅ |
| **115 网盘** | `webapi.115.com/share/snap` | ✅ | ✅ |
| **天翼云盘** | `getShareInfoByCodeV2.action` | ✅ | ✅ |
| **百度网盘** | 分享页特征探测 | — | ✅ |
| **移动云盘 (139)** | 官方接口请求体加密，引导走被动读页 | — | ✅ |

---

## 快速安装（Chrome / Edge）

1. 前往 [GitHub Releases](https://github.com/MoePans/moepans-checker/releases/) 下载最新的扩展压缩包并解压到一个**固定目录**（安装后请勿删除该目录）。
2. 打开浏览器扩展管理页：
   * **Edge**：地址栏输入 `edge://extensions/`
   * **Chrome**：地址栏输入 `chrome://extensions/`
3. 开启右上角「**开发人员模式**」，点击「**加载解压缩的扩展**」，选择解压后的目录。
4. 刷新你的 MoePans 网页，右上角出现绿色的「**助手已就绪**」即表示连接成功。

---

## 隐私与安全边界

* **仅作用于 MoePans 站点**：页面桥接脚本 `content_moepans.js` 仅在检测到 `<meta name="moepans-crowd-check" content="1">` 标记时激活，不会向其他网站注入任何逻辑。
* **不追踪普通浏览**：被动读页脚本 `content_netdisk.js` 仅对**最近 5 分钟内由 MoePans 站点点击跳转打开**的网盘分享页进行状态回传；你自己平时直接打开的任何网盘分享链接绝不会上报。
* **不读取网盘 Cookie**：所有主动探测请求均显式设置 `credentials: "omit"`，不携带、不读取、不上传你的任何网盘登录凭据或个人账号信息。

---

## 技术文档

更完整的系统架构、租约防惊群算法、指数退避动态 TTL、各网盘底层协议与合规审查流转细节，请参阅：

* 📖 [原理与技术细节文档 (`docs/architecture-and-protocol.md`)](docs/architecture-and-protocol.md)

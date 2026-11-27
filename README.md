# MoePans 测活助手 (`moepans-checker` v1.2.13)

面向 [MoePans](https://github.com/MoePans/moepans-checker) 站点的轻量级浏览器扩展（Manifest V3），用于通过**双轨众包测活**协助站长自动识别失效网盘分享、采集多级目录结构、估算真实文件总大小并提取分享者昵称。

## 核心特性

* **被动读页模式（默认开启，零额外请求）**：仅在用户从 MoePans 主动点击打开网盘链接时，由内容脚本读取网盘页面提示识别有效/失效并回传，不发起任何额外探测请求。
* **主动租约测活（用户可选开启 / 详情页手动「验证链接」）**：按服务端签发的 30 秒原子租约低并发探测（每页最多 5 条、并发 2、随机抖动），避免触发网盘限流。
* **全网盘多级目录树 + 截断 `+` 提示 + 点击按需懒加载**：
  * 支持全部 9 大网盘的目录与容量探测，单页统一 20 条，首次采样最多 4 层 / 12 次子请求 / 80 项，存在未展开目录或后续分页时自动标 `+`（如 `80+ 项`、`118.25+ GB`）。
  * 网页详情弹窗与扩展弹窗均默认收起目录，点击未采样文件夹的 **`展开加载`** 或底部的 **`加载更多...`** 即可单独拉取下一层/下一页（支持页码分页及迅雷/阿里游标分页），不从头重测。
* **内置可导出诊断日志**：扩展弹窗保留最近 100 条测活记录（附环境/版本/设备元信息），支持一键复制、导出 `.log` 与清空。

## 支持的网盘与检测深度

| 网盘 | 主动探测协议 | 多级目录 / 真实总大小 / 分享者 / 按需翻页 |
| :--- | :--- | :--- |
| 夸克网盘 (`quark`) | `sharepage/token` + `sharepage/detail` 两步校验 | 全部支持（页码分页） |
| UC 网盘 (`uc`) | `sharepage/token` + `sharepage/detail` 两步校验 | 全部支持（页码分页） |
| 阿里云盘 (`aliyun`) | 匿名信息 + `get_share_token`（含公开分享无密码重试）+ `list_by_share` | 全部支持（`next_marker` 游标分页 + 锁密顶层预览兜底） |
| 百度网盘 (`baidu`) | 网页端 `/share/verify`（`sekey`）+ `/share/list`（含 HTML 兜底） | 全部支持（页码分页） |
| 天翼云盘 (`tianyi`) | `getShareInfoByCodeV2` + `checkAccessCode` + `listShareDir`（JSON/XML + 18 位 ID 精度保护） | 全部支持（页码分页） |
| 迅雷网盘 (`xunlei`) | 安卓协议 10 重 MD5 `captcha_sign` + `/drive/v1/share` + `/share/detail` | 全部支持（`next_page_token` 游标分页） |
| 123 云盘 (`123`) | `yun.123pan.com/b/api/share/get` | 全部支持（页码分页） |
| 115 网盘 (`115`) | `webapi.115.com/share/snap` | 全部支持（`offset` 分页） |
| 移动云盘 (`mobile`) | `share-kd-njs.yun.139.com/.../getOutLinkInfoV6` 免登公开接口 | 全部支持（页码分页） |

## 快速安装（Edge / Chrome 等 Chromium 浏览器）

前往 [GitHub Releases](https://github.com/MoePans/moepans-checker/releases/) 下载最新版 `.crx` 安装包或源码压缩包：

1. 打开浏览器扩展页（`edge://extensions` 或 `chrome://extensions`）并开启「开发人员模式」。
2. 将 `.crx` 文件直接拖入扩展页安装，或解压压缩包后点击「加载解压缩的扩展」选择目录。
3. 刷新 MoePans 站点页面即可自动连接（顶部显示「助手已就绪」）。

## 隐私与安全边界

* 仅在检测到 `<meta name="moepans-crowd-check" content="1">` 的 MoePans 站点激活页面通信桥梁。
* `rules.json` 通过 `excludedInitiatorDomains` 严格隔离，仅修改扩展后台主动请求的 `Referer`/`Origin`，绝不干扰用户正常浏览网盘网页。
* 除百度网页端接口为兼容已登录场景按需携带同源会话外，其余网盘探测均采用 `credentials: "omit"` 匿名模式，不收集或上传任何网盘账号 Cookie。

## 技术文档

* [原理与技术细节（双轨协议、网盘接口与懒加载设计）](docs/architecture-and-protocol.md)

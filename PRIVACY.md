# 隐私说明

版本：1.5.0；更新日期：2026-10-30。

评论译读是运行在本机 Chrome 中的 YouTube 评论翻译与中英双搜扩展。不要求创建开发者账户，没有开发者分析、广告、遥测或后端服务器。

## 中英双搜（1.5.0）

### 什么时候触发

只有在 YouTube `/results` 页面、搜索词包含中文字符，且设置中的 `dualSearch` 为开启状态时，扩展才会接管结果区域。纯英文、纯数字或其他语言的搜索保持 YouTube 原生结果，不发起额外的 B站翻译请求。

中英双搜独立于评论翻译：它不读取评论翻译的 provider、Key 或 `aiConfig`，也不会因为评论翻译暂停而停止；反过来，关闭双搜不会改动评论翻译设置。

### YouTube 同源搜索请求

初次搜索和后续分页都会向当前页面同源的 `/youtubei/v1/search?prettyPrint=false` 发送 `POST`。请求体包含：

- 从页面已公开脚本中读取的 `clientName`、`clientVersion`、`hl`、`gl` 四个字段；
- 初次请求的 `query`，以及原 URL 存在时携带的 `sp`；
- 分页请求的 continuation token。

扩展不硬编码 YouTube 客户端版本；continuation token 只保存在内存中，不写入存储、不打印到日志、不通过隐藏标签页传递。

扩展代码不读取 YouTube 的 Cookie、Authorization、visitorData 或 apiKey，不调用 YouTube Data API，也不需要 YouTube API Key。但这是浏览器同源请求：Chrome 会按 YouTube 的正常规则附带你现有的 YouTube Cookie，让请求表现为当前网页会话的一部分。**因此它不是匿名请求**，YouTube 会收到你的 IP、账户相关的正常 Cookie 等连接信息。扩展不读取这些 Cookie，也不会把它们发送给 B站。

### 发送给 B站什么

中英双搜固定使用 B站免 Key 的 Index-Translate 服务与 `Index-Translate-35B-A3B` 模型，与评论翻译当前选择的 provider 无关。

只发送：

- 你输入的中文搜索词，用于生成英文检索词；
- 右栏当前可见的英文视频标题，以及作为理解上下文的中文搜索词，用于生成中文标题。

不发送 YouTube URL、视频 ID 列表、完整页面 HTML、浏览历史、continuation token、YouTube 客户端配置、Cookie 或 Authorization。请求不带认证、不带 Key，使用 `credentials: 'omit'`、`referrerPolicy: 'no-referrer'`、`redirect: 'error'`。

Chrome 会为跨源请求自动附加扩展 Origin。1.4.0 引入的精准规则继续生效：仅对本扩展自身发往 `https://index-translate.bilibili.com/v1/chat/completions` 的 POST 移除该头，规则限定来源、路径、方法和发起扩展，不修改 User-Agent、认证字段或其他网页请求。中英双搜复用同一来源授权和这条规则。

B站作为接口运营方，仍会收到你的 IP 和上传的搜索词/标题文字。插件不宣称 B站不会留存这些内容或不会将其用于训练；具体数据处理以 B站的政策为准。

### 搜索翻译缓存

搜索翻译结果保存在 `chrome.storage.session` 的 `searchTranslations` 中，有效期 6 小时，最多 400 条。缓存键由「用途 + 文本 + 中文 query」的 SHA-256 摘要构成，搜索词与标题分开，不会互相命中；键中不保存明文搜索词或标题，但缓存值本身可能包含标题译文。

在评论面板点击「清缓存」会同时清空搜索翻译缓存；关闭浏览器、禁用或重新加载扩展也会清空。搜索缓存不会写入 `chrome.storage.local`，不会云同步。

### 请求节奏、超时与失败

搜索词和标题翻译与评论翻译共用固定 B站客户端的 1 秒串行间隔，但搜索路径不读取评论翻译的模型或 Key。搜索词优先翻译；标题只为当前可见条目排队，滚动后再处理新进入视口的标题。

界面侧单次搜索翻译最多等待 45 秒；YouTube 搜索请求本身 20 秒超时（可通过来源参数覆盖，但有上限）。某一栏失败只在该栏显示错误和重试，不会自动改用多个收费模型，也没有付费 fallback。关闭双搜、切换搜索词或离开结果页会取消正在进行的请求，迟到结果不会插入新页面。扩展不打开隐藏标签页。

### 权限与授权

中英双搜没有新增 manifest 权限，复用 B站来源的可选主机权限。设置页的「授权中英双搜」按钮只在用户点击的手势中申请 `https://index-translate.bilibili.com/*` 这一个来源，不申请其他网站权限，不读取、不索取、不保存任何 Key。

YouTube 同源搜索不需要额外主机权限，也不需要 YouTube API Key。未授权 B站来源时，左栏中文结果仍可加载，右栏会提示去设置页授权；此时不会向 B站发送搜索词或标题。

### 已知边界

中英双搜依赖 YouTube 网页公开的搜索协议。YouTube 改版、字段变化或限制同源请求时可能失效；关闭双搜即可恢复原生结果。英文栏只表示使用英文检索词搜索，不保证视频内容、字幕或音轨是英语；标题翻译和搜索词改写的语义质量不保证。扩展不承诺固定结果数量、固定耗时或固定成功率。

## 评论数据发送到哪里

### B站 Index-Translate 免费模式（1.5.0 主推荐）

向官方免费公网接口 `https://index-translate.bilibili.com/v1/chat/completions` 发送当前这一条待译评论，以及可选的视频标题和当前回复已加载的父评论；关闭「使用评论语境」后只发送评论。不获取字幕、不上传整页 HTML、不发送视频 URL 或频道档案，也不发送浏览历史。

该预设不需要 API Key，请求不携带 `Authorization`、`Cookie` 或 `Referer`，使用 `credentials: 'omit'`、`referrerPolicy: 'no-referrer'`、`redirect: 'error'`。即使本机配置被手工填入 Key，该预设也不会读取或发送它。

Chrome 会为跨源请求自动附加扩展 Origin。本版使用 declarativeNetRequestWithHostAccess，仅对本扩展发往该官方翻译端点的 POST 移除这一头，与官方匿名客户端一致；不改其他网页请求，不伪造 User-Agent，不增加认证或 Cookie。规则保存在本机，只在该来源获授权时生效。

B站作为接口运营方，仍会收到你的 IP 地址和上传的评论文字。插件不宣称 B站不会留存这些内容或不会将其用于训练；具体数据处理以 B站的政策为准。Index-Translate 模型采用 Apache-2.0 许可，该许可针对模型代码/权重，不代表该公网 API 的数据处理或留存政策。

发送前会匿名 GET `https://index-translate.bilibili.com/v1/models` 核对模型是否存在；该请求不带认证，结果缓存 10 分钟。该目录只用于确认模型 ID 存在，不作为价格证明，也不代表永久免费或无限额度。

### Google 免密钥翻译

向 `https://clients5.google.com/translate_a/t` 发送待翻译的评论文字。无需密钥，不附带 Google 登录 Cookie。Google 隐私政策：https://policies.google.com/privacy 。

### 硅基流动（SiliconFlow）零价模式

翻译请求只发往 `https://api.siliconflow.cn/v1/chat/completions`，内容为当前一条评论及可选的视频标题、父评论。核价与模型可用性检查读取公开价格页 `https://www.siliconflow.cn/models`，以及带用户 Key 的 `/v1/models` 账户模型列表。公开价格页请求**不带 Key**；账户模型列表与翻译请求使用用户的硅基流动 API Key 认证。硅基流动及其上游模型提供方可能按各自条款记录或使用请求内容，不能声称零保留；国内 `siliconflow.cn` 与国际 `siliconflow.com` 是不同服务与不同政策主体。

### OpenRouter 仅免费模式

只向 `https://openrouter.ai/api/v1/chat/completions` 发送待译评论及可选的标题、父评论；查询额度访问 `/api/v1/key`，刷新免费模型访问 `/api/v1/models`。翻译和额度查询请求会带有用户的 OpenRouter API Key 认证，公开模型目录请求不带 Key。翻译内容可能被 OpenRouter 路由到其上游模型提供方，不能声称零保留或不被用于训练。

### DeepSeek 与自定义接口

向用户自己填写并授权的 OpenAI 兼容聊天服务发送评论及可选的标题、父评论。请求会携带该服务自己的 API Key 认证。服务方可能收费，也可能按自身条款记录或使用请求内容；价格与数据处理政策由该服务决定。

评论文字中自带的用户名、网址或个人信息也会作为内容发送。各服务方仍可接收 IP 等正常连接信息，数据处理受所选服务方政策约束。评论翻译与 AI 服务请求不附带浏览器登录 Cookie；中英双搜的 YouTube 同源搜索是例外，见上文。插件不上传浏览历史、视频字幕或整页内容；中英双搜会发送中文搜索词和右栏可见标题，见上文。

## 密钥与配置

B站 Index-Translate 预设不需要 Key，其 Key 输入框会隐藏并强制清空；从其他预设切到 B站预设时也会移除旧 Key，后台请求不读取、不保存、不发送 Key。中英双搜同样不读取、不保存、不发送任何 Key。

硅基流动、OpenRouter、DeepSeek 和自定义接口的 API Key 由用户在扩展设置页本地输入，保存于本机 `chrome.storage.local`，**没有加密**，不进行云同步。页面密码框仅用于遮挡显示，不是加密。

Key 只保留在当前配置对应的服务中：切换任何预设都会清空设置页中的旧 Key，保存后旧配置被新配置替换，需要为新服务重新填写；插件不会把一个服务的 Key 发给另一个服务。B站预设不会收到其他服务的 Key。Key 只在向对应服务发请求时放入 Authorization 认证头，不放入请求 URL、翻译提示词、YouTube 页面、中英双搜请求或 Google 免费翻译请求。请求拒绝自动 HTTP 重定向。

设置状态和后台错误只使用预设错误码，可附带白名单阶段、数值 HTTP/API 状态码及响应类型分类；不回显上游错误原文、Key、URL 或请求正文。

## 公开模型目录与免费说明

B站预设对 `https://index-translate.bilibili.com/v1/models` 做匿名 GET，仅核对所选模型 ID 是否存在，缓存 10 分钟；不把该目录当作价格证明。接口目前由 B站官网作为免费公网 API 提供，但插件不承诺永久免费、无限额度或 SLA；可能限流、调整模型或停止服务。中英双搜固定使用其中的 35B 模型，同样不作永久可用承诺。

SF 免费模式需要确认模型价格为零。插件对 `www.siliconflow.cn/models` 只做公开 GET 读取与纯数据解析：不注入脚本、不使用 `eval`、不执行页面返回的任何代码，也不把账户 Key 发给该页面。解析结果用于与账户 `/v1/models` 求交集，只在两者都确认免费时才发送请求；目录里没有价格信息的模型不按名称推断免费，名称含 Pro 的模型直接排除。核价失败时停止发送，没有付费 fallback，也不会自动改用其他服务。官网目录缓存 10 分钟，账户模型列表缓存 5 分钟。

## 本地缓存

评论译文和过期时间存于 `chrome.storage.session`，标识采用包含配置与待译内容的 SHA-256 摘要，不将明文 Key、标题或父评论存入缓存标识。缓存中的译文仍可能包含原评论保留的用户名、链接等。缓存有过期时间、条数与总大小上限，关闭浏览器或重新加载扩展时清空。

中英双搜的搜索译文单独保存在同一 `chrome.storage.session` 的 `searchTranslations` 中，6 小时、最多 400 条，缓存键由用途、文本和中文 query 的 SHA-256 构成，搜索词与标题分开；关闭浏览器或重新加载扩展同样清空。

面板可清缓存，并会同时清空评论与搜索译文；已显示在网页中的译文或标题译文保留至刷新或关闭页面。更换模型、Key、服务、语境或翻译提示版本后，使用不同缓存标识。

## 请求节奏、额度与费用

B站评论预设单条串行，两次请求开始时间至少间隔 1000 ms，单次 fetch 超时 25 秒；超过 8000 字符的评论不截断，直接提示过长。内容脚本另有 100 秒 watchdog 处理挂起与切换视频后的迟到结果。遇到 429 会暂停一段时间，不连续重试，也不会自动切换收费服务。

中英双搜的搜索词/标题翻译与评论翻译共用 1 秒串行节奏；界面侧单次翻译最多等待 45 秒，YouTube 搜索请求 20 秒超时。它固定使用 B站免 Key 服务，不产生插件侧费用，但可能被限流，且没有永久免费或 SLA 承诺；不会为了补齐某一栏而调用收费模型。

B站免费接口不产生插件侧费用，但可能限流，且不提供永久免费或 SLA 承诺。SF 模式单条串行，间隔至少 2.1 秒，单次超时 25 秒。OpenRouter 模式最多 6 条合并、串行间隔至少 3.2 秒，额度以 OpenRouter 为准。DeepSeek 与自定义接口可能产生费用。

打开 AI 设置页不会自动测试连接。保存并启用 AI 后，打开的 YouTube 页面若自动翻译开启，会开始请求可见评论；这可能产生所选服务费用。点击「测试 AI 翻译」只发送固定测试样例和测试用语境，不读取当前网页的评论；点击「重新翻译」会绕过缓存再次请求，也会消耗请求次数或产生费用。中英双搜的标题翻译在滚动时按可见条目触发，关闭双搜后不再发起新的搜索翻译请求。

关闭自动翻译后不再启动新的自动评论请求，已发送的请求可能完成但不会再向页面插入结果。可随时切回 Google 模式。

## 权限

`storage` 保存设置和会话缓存；`activeTab` 用于点击扩展图标时识别页面；内容脚本只匹配 `www.youtube.com` 和 `m.youtube.com`；Google 主机权限用于原免密钥服务。

AI 访问来源为可选主机权限，保存 AI 设置时仅向 Chrome 申请所选服务的来源，默认不获取所有网站权限。B站预设只申请 `https://index-translate.bilibili.com/*`；SF 模式申请 `https://api.siliconflow.cn/*` 与 `https://www.siliconflow.cn/*`；OpenRouter 免费模式申请 `https://openrouter.ai/*`。公网仅允许 HTTPS；HTTP 仅限 `localhost` 和 `127.0.0.1`，本机连接不提供传输加密。Chrome 的主机权限匹配不区分端口。

中英双搜没有新增 manifest 权限，复用上述 B站来源的可选主机权限；「授权中英双搜」只在用户点击时申请这一个来源。YouTube 同源搜索使用页面自身的网络能力，不申请额外的 YouTube 主机权限，也不需要 YouTube API Key。

插件不自动发帖、点赞、订阅、发送私信或展开回复。公开 Google 入口、B站免费接口、自定义 AI 服务、SF 公开价格页与免费额度、OpenRouter 免费额度均可能受额度、网络或接口变更影响。

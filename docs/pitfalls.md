# 踩过的坑

做这个扩展时真的碰到的，和从原型（AllKeep 的扩展）学来的。改代码前看一遍。

## 契约

- **契约里的正则是 `(?i)` 开头的写法，JavaScript 不认。** `new RegExp('(?i)…')` 直接抛错。`src/lib/secret.ts` 把开头的 `(?i)` 摘下来变成 `i` 标志。单元测试对着契约里的每一条规则检查「能编译」，契约以后加了 JavaScript 写不出来的写法，测试会红。
- **`max_length_checked: 200` 契约没说清是什么意思。** 这里的理解：去掉首尾空白后超过 200 个字符的文字不检查（那是文章，不是密码）。别的客户端如果理解成「只检查前 200 个字符」，两边就不一致了。
- **共用规则不能自带副本，但浏览器可能从没连上过核心。** 像密码的规则只从 `GET /v1/meta` 取，取不到时带文字的存入直接说「没存入」加原因，不上传也不丢。那几句话（已存入、排着队……）和两个上限由 `build.mjs` 从 `contract/openapi.yaml` 生成，不手写。

## Manifest V3

- **service worker 随时会被浏览器停掉。** 内存里什么都不能指望：排着队的条目在 `chrome.storage.local`，等回答的「像密码」提问在 `chrome.storage.session`（只在内存里，可能是密码的东西等回答时不落盘）。
- **没有 `alarms` 权限，重试靠定时器。** 有条目排着队时每 20 秒试一次；定时器里调用扩展接口会让 worker 继续活着。worker 被停掉之后，靠 `online` 事件、浏览器启动、下一次点击再醒。要更稳得加 `alarms` 权限。
- **`chrome.scripting.executeScript({ func })` 传的是函数的源码。** `src/page.ts` 里的函数不能引用函数体外的任何东西，构建时不能压缩改名（`build.mjs` 里 `minify: false`）。
- **`chrome.permissions.request` 必须在点击的处理函数里直接调用**，前面不能有 `await`，否则浏览器不弹提问，直接失败。
- **匹配模式里不能带端口。** `http://127.0.0.1:8794/*` 是非法的，要写 `http://127.0.0.1/*`。
- **`activeTab` 只在用户亲手点了之后才有。** 没有它，`tabs.get` 连地址都拿不到，`executeScript` 直接失败。测试里要么给测试构建加主机权限，要么用调试协议真的点。
- **`if (false) { … }` 不会被 esbuild 删掉**（不开压缩时）。测试用的钩子用带标签的代码块加 `dropLabels` 去掉，端到端测试检查正式构建里没有 `keTest`。
- **语言别用 `chrome.i18n.getUILanguage()` 判断。** Mac 上的 Chromium 用 `--lang=zh-CN` 启动时，它返回 `zh-CN`，但 `_locales` 实际加载的是系统语言的那一份，结果按钮是英文、核心回的话是中文。现在语言取自消息文件里的 `lang` 这一条，两边不可能不一致。
- **`zh_TW` 不会回退到 `zh_CN`**，会回退到缺省语言（英文）。构建时把 `zh_CN` 复制一份成 `zh_TW`。

## 图片

- **别的网站的图片，扩展读不到字节。** 没有 CORS 头的跨站图片，页面里 `fetch` 不行，画到 canvas 上会被污染，service worker 没有那个主机的权限也不行。大部分网站的图片都放在别的域名上。现在的做法：读不到就把图片的地址当链接存入。要真的存图片本身，得申请所有网站的主机权限，这和「权限最少」冲突，没做。
- **`executeScript` 的返回值只能是能序列化的东西。** 图片从页面拿回来时转成 data URL。
- **service worker 里有 `OffscreenCanvas` 和 `createImageBitmap`**，转 WebP 不需要另开页面。SVG 在 worker 里解不了，会走上面「存成链接」那条路。
- Chrome 的 canvas 输出的 WebP 头有三种写法（`VP8 `、`VP8L`、`VP8X`），取尺寸时都要认。

## 测试

- **Playwright 里加载扩展要 `channel: 'chromium'`**，旧的无头模式加载不了扩展。
- **装好后自己打开的选项页会抢走当前标签页。** 用调试协议点工具栏按钮之前，先等选项页开完，再把要点的页面切到前面，不然点到的是选项页。
- **`Extensions.triggerAction` 要在浏览器级的会话上调，`targetId` 要用 `tab` 类型的目标**，用页面的目标会报 `Action can only be triggered on a tab target`。
- **Playwright 不许启动参数里出现不带 `-` 的词**（它当成要打开的网页），所以 Mac 上不能用 `-AppleLanguages (zh-CN)` 换语言。`KE_LANG=zh` 的做法是测试构建把中文的消息文件放到浏览器会去找的位置。
- **上一句话还没消失时，下一句已经来了。** 断言那一句话之前先等到它变成期望的那句。
- **这个仓库的提交会过 gitleaks。** 「像密码」的测试样例要写成看起来不像真凭据的样子（重复的字符），不要关掉扫描。
- **核心的开发端口 8791 在 Cheney 的 Mac 上被别的服务占着**（2026-11-24 看到的是 `browser-relay` 的 `relay/server.mjs`，对 `/v1/meta` 回 `{"error":"not found"}`）。对着真的核心跑之前先确认 8791 上答话的是核心。
- 本机的 `rm`、`cp` 是带确认的别名，脚本里用 `command rm -f`。

## 从原型学来的

- 请求不带浏览器的 cookie（`credentials: 'omit'`）：这个浏览器在核心那里只凭设备的凭据被认出来，撤销才真的管用。
- 右键菜单给的 `selectionText` 是压平了的，没有换行，还可能被截断。要保留换行得到页面里读一次选区。
- Mac 上的 Chrome 在文字上右键会自动选中那个词，所以右键菜单里常常同时出现「网页」和「选中的文字」两项，浏览器会把它们收进一个子菜单。这是浏览器的行为，改不了。

## 图片的告知（QA #87）

- **图片存成了它的网址，那一句要说实话。** 右键「存入这张图片」读不到图片的字节（别的站的图、SVG）时，存的是图片的网址（`imageAsLink`）。刚存下来的，说「这张图片取不到，存入了它的链接。」；**在离线队列里等着的，只说扩展本地知道的事：「这张图片取不到，排队的是它的链接。」**（`queued_image_as_link`；不说「会改存」，那是在替核心保证以后一定存入，Project 7213889512），不能把已经存下来的那句接在队列那句后面：队列那句说「还没存入」，后面再说「存入了」就是自相矛盾（QA 复验抓到的）。之前已经存过的（`duplicate`）和没存成的，仍然是核心原来的那句，那才是真的。纯函数是 `lib/messages.ts` 的 `sentenceInstead`（参数 `Said`：`done` / `waiting` / `added` 三样各只在它为真的地方说），有单元测试。
- **压缩的说明放在选项页，不放右键菜单，不弹窗，也不在每次存入的那句里。** `opt_images`，在「怎么用」下面一行小字。这一个入口核实过：右键图片菜单（原图不上传，最长边按契约的 `image_long_edge_px`）。别的入口没核，不写。
- **动图被画成一张静态图，要自己数帧，只在多于一帧且图真的存下了时才说。** `createImageBitmap` + `OffscreenCanvas` 只画一帧。不能因为类型是 `image/gif` 就说，静态 GIF 没丢东西；反过来 APNG、动态 WebP 一样只剩一帧，也不能因为不是 GIF 就不说（#87 裁定 2026-11-28）。按字节数，不按类型：`lib/frames.ts` 的 `imageFrames` 看文件头认格式（和网页的 `src/frames.ts` 是同一份算法）。GIF 顺着块数图像描述符（`lib/gif.ts`）；APNG 读第一个 `IDAT` 之前的 `acTL` 帧数；WebP 只有 `VP8X` 头里的动画标志置位才数 `ANMF` 块，带 `VP8X` 但没有动画标志的（色彩配置、透明度、元数据）是静态图。多于一帧才在核心那句后面加 `gif_one_frame`「动图只保留了一帧。」；说「一帧」，不说「第一帧」。排队的、重复的、没存成的、图因配额没存下的（`saved_image_skipped_quota`）都不加。HEIC 序列、动态 AVIF 不在范围内。
- **选项页那一行是市场主稿的原话。** `opt_images` = 「存入的图片会先在你的设备上处理，原图不上传。」（marketing `14726f8` 的 `content/copy-drafts/image-save-notices.md`）。「不写的」那几样不要加。

## 圆角和色表（QA #107，spec e139a47）

- **只换 `src/tokens.css`，设置页的卡片、输入框、按钮会全变成 14px。** 三处原来都写 `var(--ke-radius)`，新刻度里卡片是 20、按钮是 999（胶囊），输入框才是 14。所以换色表时必须同时改组件选择器：`.card` 用 `--ke-radius-card`，`button` 用 `--ke-radius-control`，`input` 仍用 `--ke-radius`。`tests/e2e/extension.test.mjs` 里 W8 那条用真的设置页（展开「高级设置」）读浏览器算出来的圆角：卡片 20px、地址输入框 14px、保存按钮 999px。
- **`src/tokens.css` 是 spec 的逐字副本，没有同步脚本，手拷。** `cp ../spec/design/tokens.css src/tokens.css`，再 `diff` 一次确认两边一样；半份（只抄圆角或只抄色表）会让同一个界面里新旧两套值混在一起。
- **页内提示（`src/page.ts`）在宿主页面的 shadow root 里，读不到我们的 CSS 变量，圆角只能写死。** 提示框 14px（= `--ke-radius`），两个按钮 999px（= `--ke-radius-control`）。`tests/unit/tokens.test.ts` 把这两个写死的数和 `tokens.css` 对着，刻度以后再改时会先红；同一条 e2e 在带按钮的提示（像密码的提问）上读计算值。提示的颜色（`#0B0B0B`、`#2C2C2C`、`#6B6B6B`）这次没动，也没有测试固定它们。

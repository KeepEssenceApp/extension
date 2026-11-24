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
- 本机的 `rm`、`cp` 是带确认的别名，脚本里用 `command rm -f`。

## 从原型学来的

- 请求不带浏览器的 cookie（`credentials: 'omit'`）：这个浏览器在核心那里只凭设备的凭据被认出来，撤销才真的管用。
- 右键菜单给的 `selectionText` 是压平了的，没有换行，还可能被截断。要保留换行得到页面里读一次选区。
- Mac 上的 Chrome 在文字上右键会自动选中那个词，所以右键菜单里常常同时出现「网页」和「选中的文字」两项，浏览器会把它们收进一个子菜单。这是浏览器的行为，改不了。

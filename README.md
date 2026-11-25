# KeepEssence extension

KeepEssence 的浏览器扩展：把网页、文字、链接、图片存进来。
The KeepEssence browser extension: save pages, text, links and images.

状态：1.0.0，可以开内测。Chromium 系浏览器（Chrome、Edge、Brave），Manifest V3。还没上架任何商店，先以「加载已解压的扩展」的方式用。

## 它做什么

| 你做的 | 存入的 |
|---|---|
| 点工具栏上的 KeepEssence 按钮，或按 `Alt+Shift+S`（Mac 上是 ⌥⇧S） | 当前网页：地址、标题；有选中的文字时一起存入 |
| 右键 › 存入这个网页到 KeepEssence | 当前网页 |
| 选中文字，右键 › 存入选中的文字到 KeepEssence | 这段文字（保留换行），来源是当前网页 |
| 在链接上右键 › 存入这个链接到 KeepEssence | 这个链接 |
| 在图片上右键 › 存入这张图片到 KeepEssence | 图片本身：转成 WebP，长边不超过 1600 像素，来源是当前网页 |

- **一个动作**。没有弹窗，没有要再点一下的窗口。完成时页面右下角说一句话，几秒后自己消失。
- **不说比事实多的话**。核心答复了才说「已存入」；之前存过就说存过；没存入说原因；没联网就说排着队，联网后自动存入，那时不再出声。
- **像密码的内容先问**。选中的文字像密码或凭据时，页面上问一句，两个按钮：存入、不存。不悄悄上传，也不悄悄丢掉。识别规则不在扩展里，是从核心的 `GET /v1/meta` 取来的那一份。
- **只有「只存入」档的权限**。扩展看不到任何已存入的内容，没有任何读的界面，不收通知。
- **界面上不出现凭据**。接入用短码，凭据存在浏览器里，不显示、不能复制。
- 页面不让扩展动的地方（浏览器自己的页面、扩展商店）：工具栏按钮上出一个标记，再发一条系统通知，说的是同一句话。
- 中文和英文，跟随浏览器的语言。

## 装上

不想自己构建的话：到 [最新的发布](https://github.com/KeepEssenceApp/extension/releases/latest) 下载 `keepessence-extension.zip`，解压到一个不会删的文件夹，然后从下面「打开 `chrome://extensions`」那一步接着做，选解压出来的那个文件夹。
Without building it: download `keepessence-extension.zip` from the [latest release](https://github.com/KeepEssenceApp/extension/releases/latest), unpack it into a folder you will keep, then continue below from “open `chrome://extensions`” and choose that folder.

自己构建：

需要 Node 22.18 以上。

```
npm ci
npm run build      # 生成 dist/ 和 keepessence-extension-<版本>.zip
```

打开 `chrome://extensions`（Edge 是 `edge://extensions`，Brave 是 `brave://extensions`），打开右上角的「开发者模式」，点「加载已解压的扩展程序」，选 `dist/` 这个目录。装好后浏览器会自己打开扩展的选项页。从拼图图标的菜单里把「存入到 KeepEssence」固定到工具栏。

浏览器记的是目录，不是副本：重新 `npm run build` 之后，到扩展卡片上点一下刷新。快捷键在 `chrome://extensions/shortcuts` 里可以改；如果 `Alt+Shift+S` 被别的扩展占了，要在那里手动设一次。

## 接入

1. 选项页上显示一个短码（比如 `K7M-2QX`）和这个浏览器的名称（缺省是「Chrome on Mac」这样，可以改；改了会换一个短码）。
2. 在一台管理档的设备上打开 KeepEssence（选项页上的「打开 KeepEssence」会打开允许页），核对短码，点「允许」。
3. 选项页变成「已接入，这个浏览器叫……」。之后选项页上只有三样：名称、KeepEssence 地址、「断开」。

短码 10 分钟有效，只能用一次；过期或被拒绝后点「再取一个短码」。「断开」会撤销这个设备，立即生效。在 KeepEssence 的 助手设置 › 设备 里也可以改名和撤销；被撤销后，下一次存入会排着队，并打开选项页让你重新接入。

还没接入就点了存入：这一条排着队，接入后自动存入。

### 自己架设的 KeepEssence

选项页里「自己架设的 KeepEssence」可以改地址（缺省 `https://keepessence.app`）。改的时候浏览器会问一次是否允许扩展访问那个地址。改了地址要重新接入；还排着队的条目不会带到新地址。

## 它能看到什么

| 权限 | 用来做什么 |
|---|---|
| `activeTab` | 只在你点了按钮、快捷键或右键菜单之后，只在那一个标签页里：读地址、标题和选中的文字，读你右键点的图片，显示那一句话 |
| `scripting` | 把那一句话放进页面，读选中的文字和图片。不点不注入，注入的东西不留在页面里 |
| `contextMenus` | 右键菜单里的四项 |
| `storage` | 存 KeepEssence 地址、这个浏览器的名称和凭据、从核心取来的共用规则、排着队的条目 |
| `notifications` | 只在页面放不了那句话的时候用 |
| `https://keepessence.app/*` | 只和你的 KeepEssence 说话。改成自己架设的地址时，再单独请求那一个地址 |

没有内容脚本，不在任何页面里常驻；不读别的标签页；请求不带浏览器的 cookie；不收集任何数据。你不点它的时候，它只做一件事：把排着队的条目送出去。安装时浏览器会列出两项：读写 keepessence.app 上的数据、显示通知。

## 开发

```
npm run typecheck     # 类型检查
npm test              # 单元测试：像密码的识别（对着契约里的规则）、排队、那一句话怎么选、每种东西发什么
npm run build         # dist/ 和 zip
npm run test:e2e      # 端到端：真的 Chromium 里加载扩展（先 npx playwright install chromium）
npm run fake-core     # 一个假的核心，http://127.0.0.1:8794，只有扩展用到的那几个接口
```

目录：

| 路径 | 内容 |
|---|---|
| `contract/openapi.yaml` | 契约的副本。接口只在 [spec/contract](https://github.com/KeepEssenceApp/spec/tree/main/contract) 定，不在这里改 |
| `src/background.ts` | service worker：三个入口、存入的流程、排队、像密码先问 |
| `src/page.ts` | 放进页面里跑的三个函数：那一句话、读选中的文字、读图片 |
| `src/options.*` | 选项页：接入、断开、地址 |
| `src/lib/` | 不碰浏览器的部分：`secret`（像密码的识别）、`queue`（排队）、`messages`（那一句话）、`items`（发什么）；以及 `api`（契约里用到的那几个接口）、`image`、`store` |
| `src/tokens.css` | [spec/design/tokens.css](https://github.com/KeepEssenceApp/spec/blob/main/design/tokens.css) 的副本 |
| `src/generated/` | `build.mjs` 从契约生成：那几句话和两个上限，给从没连上过核心的浏览器用。不进仓库 |
| `dev/fake-core.mjs` | 假的核心，读契约里的规则和上限 |
| `tests/unit/`、`tests/e2e/` | 测试 |
| `docs/pitfalls.md` | 踩过的坑 |

用到的接口只有这些：`GET /v1/meta`、`POST /v1/device-codes`、`GET /v1/device-codes/{code}`、`POST /v1/items`、`POST /v1/assets`、上传地址、`POST /v1/assets/{id}/complete`、`GET /v1/devices/me`、`DELETE /v1/devices/me`。存入的请求只有契约里 `SaveRequest` 的那几个字段，不带标签，不带初筛信息。

### 测试怎么跑的

自动化的浏览器按不了工具栏按钮、快捷键和右键菜单。所以有两套端到端测试：

- `tests/e2e/extension.test.mjs` 用测试构建（`dist-test/`，`node build.mjs --test`）。它比正式构建多三样：能动 `http://127.0.0.1` 上的测试网页；缺省地址是本机的核心；service worker 里多一个 `keTest`，直接调三个入口后面的处理函数。按下之后的一切都是真的代码、真的页面。测试构建不打包。
- `tests/e2e/packaged.test.mjs` 用正式构建（`dist/`），什么都不加。它用浏览器的调试协议真的「点」一下工具栏按钮（`Extensions.triggerAction`），`activeTab` 照常授予；让浏览器以为 `keepessence.app` 在本机，由假的核心用测试证书应答，没有任何请求离开本机。

对着真的核心跑（核心在本机起来之后）：

```
KE_CORE_URL=http://127.0.0.1:8791 KE_MANAGE_CREDENTIAL=<一台管理档设备的凭据> npm run test:e2e
```

凭据从环境变量给，不要写进文件。`KE_LANG=zh npm run test:e2e` 用中文跑；`HEADED=1` 可以看着浏览器跑。

## 参与

见 [贡献指南](https://github.com/KeepEssenceApp/.github/blob/main/CONTRIBUTING.md)。许可证：[AGPL-3.0](LICENSE)。

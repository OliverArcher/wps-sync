# wps-sync

> **在无法安装 WPS 个人版客户端的环境里，把 WPS 个人云盘与本地目录做双向同步。**

很多受管控的办公电脑装不了 WPS 个人版客户端：软件走白名单、装包被拦、或者干脆禁止个人产品入内。
可云盘里躺着的仍然是自己的工作文件。

官方没有提供独立的同步接口，于是本项目**复用网页版登录会话**，自己实现了两套 HTTP 通道、
快照状态机与一套 Fluent 风格的桌面界面，把"装不了客户端"这件事绕过去。

- 纯 Node 引擎，**零第三方运行时依赖**（Node ≥ 22）
- 桌面端 Electron + Fluent UI React v9，Win11 资源管理器观感，仅浅色
- 删除**只记账、绝不自动删**；重命名 / 移动会跟随，不产生副本

> ⚠️ 本项目使用 WPS 网页版的**未公开接口**，非官方工具。接口随时可能变更，见文末[免责声明](#免责声明)。

---

## 目录

- [功能特性](#功能特性)
- [下载](#下载)
- [从源码运行](#从源码运行)
- [配置](#配置)
- [命令行参考](#命令行参考)
- [工作原理](#工作原理)
- [云端→本地定时拉取（可选）](#云端本地定时拉取可选)
- [打包](#打包)
- [已知限制](#已知限制)
- [免责声明](#免责声明)

---

## 功能特性

### 双向同步

| 能力 | 说明 |
| --- | --- |
| 本地 → 云端 | 本地新增 / 修改的文件自动上传（覆盖同一 file id，不产生副本） |
| 云端 → 本地 | 核对云端新增 / 修改并下载；也可交由下方的定时守护自动完成 |
| 比对判据 | **sha1**（不是 mtime）。大小只作第一层便宜筛子——"大小不变内容变"不会被漏掉 |
| 快照状态机 | 状态落在 `data/state.json`，不做全量重传；日常只哈希变更候选 |
| 重命名 / 移动跟随 | 本地改名或挪位置 → 云端**同一个 file id** 跟着 rename / move，不产生副本 |
| 云端改名 / 挪位置 | 反向同样跟随：云端旧路径消失 + 新路径出现且 sha1 相同 → 本地跟着改，不重复下载 |
| 冲突处理 | 两端都改且 sha1 不同 → **两份都留**（云端版本另存为 `xxx (云端版本 时间戳).ext`），本地原件不动 |
| 排除规则 | 按文件名与相对路径的**任意一段**匹配；排除项完全不参与同步判定，也不会被当成新增 |

### 删除：只记账，不自动删

同步**不会**删除任何一端的文件。发现"某一端消失了"时，只在删除台账里记一条：

| 状态 | 含义 |
| --- | --- |
| 待处理 | 待你人工确认 |
| 已删除 | 已确认处理 |
| 已忽略 | 判定为无需处理 |

- 本地已消失、云端仍在 → 可一键把**云端**文件移入回收站（可还原）
- 云端已消失、本地仍有 → 可把**本地**文件备份后移入回收站
- 支持多选批量处理；内部每 10 个一组逐项复核，**遇错立即停止**

### 云端文件管理

浏览目录、下载、新建文件夹、重命名、移动、复制、移入回收站 —— 都在界面里完成，不必开浏览器。

### 桌面界面

- Win11 资源管理器观感：icon-only 左侧栏、Fluent 组件、细滚动条、仅浅色主题
- 页面：首页（云端文件）/ 传输（实时日志）/ 删除日志 / 设置
- 系统托盘：双击开窗，右键退出；**关闭窗口 ≠ 退出程序**
- 登录：拉起独立浏览器实例完成网页登录，自动抓取会话，无需手工复制 Cookie

### 本地监听 + 定时拉取

- 本地文件变动由 `fs.watch` 触发自动上传；预检 `size + mtime` 后哈希确认，避免"只被碰过、内容没变"的空跑
- 云端变动靠**定时守护**（Windows 计划任务，无窗口）周期拉取，见下方专节

---

## 下载

到 [Releases](../../releases) 下载：

```
wps-sync-0.2.0-win-x64.zip
```

免安装绿色版：**解压后用 `wps-sync.exe` 启动即可**，不需要管理员权限，也不需要预装 Node。

数据默认跟着程序目录走（`config.json`、`data/` 都在 exe 旁边），整个文件夹复制到哪都能用。

> 为什么不是单文件 portable：单文件版每次运行都要把自己解压到 `%TEMP%` 下的随机目录，
> 开第二个实例时两个启动器会抢同一个解压目录，第二个直接卡在启动器里（连 JS 都没执行到），
> 单实例锁形同虚设。绿色版没有这个问题，启动也更快。

---

## 从源码运行

依赖 **Node ≥ 22**（用到全局 `fetch` / `WebSocket`）。引擎侧零第三方包。

```bash
git clone https://github.com/OliverArcher/wps-sync.git
cd wps-sync
cp config.example.json config.json     # 然后按需修改
node src/wpscli.mjs login              # 拉起浏览器登录，自动抓会话
node src/wpscli.mjs status             # 看会话状态（不发请求，不烧接口）
```

桌面界面：

```bash
cd app
npm install
npm run build      # 构建前端 → dist/
npm start          # 启动应用
```

开发模式（两个终端）：

```bash
cd app
npm run dev                            # 终端 1：vite dev server（5173）
# 终端 2（PowerShell）：$env:WPS_SYNC_DEV=1; npm start
```

> `start.bat` 是双击启动用的包装器，它会先清掉 `ELECTRON_RUN_AS_NODE`。
> 某些从 Electron 派生的终端会带上这个变量，那样 Electron 会以纯 Node 启动，
> 主进程 `require('electron')` 拿不到 `app`，直接崩。

---

## 配置

所有行为由根目录的 `config.json` 驱动，**同步目录不写死在代码里**。
从 `config.example.json` 复制一份再改：

```json
{
  "driveId": "你的云盘 id（必填）",
  "syncMode": "size-only",
  "sync": { "concurrency": 4, "maxQps": 8, "followRename": true },
  "pairs": [
    { "name": "我的文档", "enabled": true,
      "localDir": "D:/YourLocalFolder", "cloudPath": "YourCloudFolder" }
  ],
  "exclude": ["~$*", "*.tmp", "*.bak", "desktop.ini", "*.cdc", "*.lnk"]
}
```

| 键 | 说明 |
| --- | --- |
| `driveId` | **必填**。云盘 id，同一个账号下所有目录共用。界面「设置」页可填 |
| `pairs[]` | 同步对：`localDir` ↔ `cloudPath`。可配多组，各自独立开关 |
| `sync.concurrency` | 并发数。注意这不等于请求速率，限速由 `maxQps` 单独兜底 |
| `sync.maxQps` | **全局请求速率上限，安全红线，不要调高**（原因见[已知限制](#已知限制)） |
| `sync.followRename` | 是否跟随重命名 / 移动（默认开） |
| `sync.ignoreOldFiles` | 是否忽略"很久没动过"的文件 |
| `cloudPull.enabled` | 定时拉取总开关；`intervalMin` 为周期（分钟） |
| `exclude[]` | 排除规则，`~$*` 之类的通配，同时作用于文件名与路径的任意一段 |

首次使用建议先在界面里跑一次全量建库（建立快照），再启用定时拉取。
**没有快照时守护会拒绝启动** —— 引擎会把"云端不存在"误解为"云端什么都没有"，
从而把本地文件全部当成新文件重传。

---

## 命令行参考

引擎是一个独立可跑的 CLI，界面只是它的外壳。

```bash
node src/sync2.mjs --build                 # 建库：遍历云端 + 扫本地 → 写快照
node src/sync2.mjs --plan                  # 只算计划，不传输
node src/sync2.mjs --once                  # 本地变更 → 上传到云端
node src/sync2.mjs --check                 # 云端核对：报告新增/变更/消失（不下载）
node src/sync2.mjs --check --download      # 云端核对并下载到本地
node src/sync2.mjs --check-path <子路径>    # 只核对某个子树
node src/sync2.mjs --cloudsync             # 只做下行核对 + 下载（守护调用的就是这个）
node src/sync2.mjs --cloudsync --dry-run   # 只报告，不下载
node src/sync2.mjs --startup               # 启动一站式：先上行，再核对 + 下载
node src/sync2.mjs --deletions             # 打印待处理的删除台账
node src/sync2.mjs --purge-cloud <key>     # 把某条记录的云端文件移入回收站
node src/sync2.mjs --mark <key> ignored    # 标记某条记录（handled / ignored / pending）
```

会话与辅助：

```bash
node src/wpscli.mjs status                 # 查看会话
node src/wpscli.mjs login                  # 浏览器登录
node src/wpscli.mjs login --sid <值>       # 兜底：手工回填会话（浏览器 F12 → Cookies）
node src/wpscli.mjs ls / tree / down / up  # 手工验证
```

**退出码约定**

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 2 | 配置 / 会话缺失（例如没有 `driveId`、没有 `wps_sid`） |
| 3 | 另一个同步正在跑，**本轮什么都没做** —— 不要当成成功，否则用户的操作会被静默丢弃 |

---

## 工作原理

```
           WPS 个人云盘（网页版）
                    │
     ┌──────────────┴──────────────┐
     │ 通道 A（主力）               │ 通道 B（备用）
     │ Cookie: wps_sid             │ Cookie: wps_sid
     │ 列目录 / 下载 / 建目录 /      │ 官方工具中心接口
     │ 上传任意格式 / 覆盖          │ ⚠ 只接受白名单扩展名
     └──────────────┬──────────────┘
                    │
        src/core/webdrive.mjs（通道 A 客户端）
                    │
        src/sync2.mjs（快照同步器）
                    │
        data/state.json 快照 · data/deletions.json 删除台账
                    │
              本地同步目录（config.json 的 pairs 驱动）
```

- **通道 A 是主力**：能上传任意扩展名的文件（含 CAD 图纸等二进制格式），不消耗官方工具中心的调用配额
- **通道 B 降为备用**：有扩展名白名单，二进制格式传不上去，只保留重命名、回收站观测等补充能力

几个关键设计：

| 设计 | 原因 |
| --- | --- |
| 用 sha1 而非 mtime 判等 | 云端 mtime 是**上传时间**，与本地修改时间可能差好几天，拿来比较必然误判 |
| 全局限速 + 429 指数退避 | 云端列目录在并发稍高时就会开始返回 429，必须按请求速率限流而不是只控并发 |
| 写操作串行（跨进程文件锁） | 两个同步同时跑会互相覆盖快照文件，并踩到临时文件 `ENOENT`。锁记 pid，进程死了自动过期 |
| 重命名跟随而不重建 | 云端同一个 file id 直接 `rename` / `move`，避免"一改名就全量重传" |
| 排除项不进快照判定 | 否则被排除的文件会在每次遍历时被误判成"消失"，污染删除台账 |

---

## 云端→本地定时拉取（可选）

桌面外壳只有**本地**文件系统的监听，没有任何周期性定时器；而引擎的单次运行只上行、不列云端。
结果是：手机或网页端改了云端，这台电脑永远不会知道。

因此附了一个常驻守护，按周期调用引擎的下行模式：

```
Windows 计划任务（登录时触发）
   └─ wscript.exe resources/engine/cloudpull.vbs     ← 无窗口
        └─ wps-sync.exe daemon.mjs                   ← 借用 Electron 自带的运行时当 node 用
             └─ sync2.mjs --cloudsync                ← 只做云端 → 本地
```

它**不依赖系统安装 Node**，也不需要重新打包桌面外壳（引擎源码在 asar 之外）。

安装（**以管理员身份**运行，或直接双击 `.cmd`，它会自动提权）：

```powershell
powershell -ExecutionPolicy Bypass -File install-cloudpull-task.ps1
powershell -ExecutionPolicy Bypass -File install-cloudpull-task.ps1 -Interval 15   # 顺带改周期
powershell -ExecutionPolicy Bypass -File install-cloudpull-task.ps1 -Uninstall     # 卸载
```

- 拉取周期读 `config.json` 的 `cloudPull.intervalMin`
- 日志写在 `data/cloudpull.log`（独立于界面同步的 `sync.log`，避免混在一起）
- 与界面同步撞锁时子进程退出码为 3，守护会缩短等待、稍后重试，不丢事件
- 找不到 `data/state.json` 快照时**拒绝启动**，防止把本地文件全量当成新文件重传

---

## 打包

```bash
cd app
npm install
npx electron-builder --win --dir      # 产出 pack/win-unpacked
```

然后把 `pack/win-unpacked` 整个目录压成

```
wps-sync-0.2.0-win-x64.zip
```

国内网络下可加镜像环境变量加速：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npx electron-builder --win --dir
```

**打包后的目录约定**（改代码前必须知道）：

| 项 | 位置 | 为什么 |
| --- | --- | --- |
| 引擎 `src/`、`icons/`、`daemon.mjs`、`cloudpull.vbs`、`config.json` | `resources/engine/`（**不进 asar**） | 同步要 spawn 子进程直接跑 `.mjs`，子进程读不了 asar |
| `config.json`、`data/` | exe 旁边（绿色版）；只读位置则回退到 `%APPDATA%` | 便携：文件夹复制到哪数据跟到哪；快照体积大且每次同步都变，不能打进 asar |
| 计划任务安装脚本 | exe 旁边（`extraFiles`） | ps1 用 `$PSScriptRoot` 定位引擎目录 |
| `state.json` 快照 | **不打包** | 各机器首次运行后自己建库 |

详见 `app/electron-builder.yml`；对应代码在 `app/src/main.cjs` 的
`ENGINE` / `pickUserRoot()` / `ensureUserData()`。

---

## 已知限制

1. **云端列目录有速率红线**：并发 8（约 22 次/秒）时就会开始出现 429，实测约 10% 的目录被拒。
   已内置全局限速（`sync.maxQps`，默认 8）+ 指数退避重试 + 失败目录降速补列。
   **任何云端批量操作都要先考虑限速。**
2. **云端核对没有增量通道**（三条思路均已证伪：目录 mtime 不随子项冒泡、漫游接口不是变更日志、
   `files/recent` 不存在）。因此核对只能遍历目录，降低开销只能靠：只列配置的 pair 范围、
   降低频率、日常变更即传。
3. **通道 B 有扩展名白名单**：`upload_new_file` 等只接受常见文档格式，二进制格式会被拒绝；
   走通道 A 可上传任意格式。
4. **两条通道的 id 体系不通用**：网页端是数字 id，官方工具中心是字符串 id，不要混用。
5. **接口未公开**：官方若变更实现，功能可能失效；通道 B 可作退路。
6. **写操作必须串行**：新增任何写操作都要纳入引擎的 `WRITE_MODES`，否则可能与界面同步撞车。
7. **秒传（服务端）不存在**：上传时服务端不返回"命中已有内容"的标志，浏览器之所以跳过直传是它
   自己缓存了校验值。若要省流量只能自建客户端缓存（尚未实现）。
8. **`fs.watch` 分不清"被碰过"和"内容变了"**：文件系统只告诉你文件被动过。
   已用预检（size 相同 + mtime 变 → 哈希确认）兜底，一致就静默丢弃，不空跑、不刷日志。

---

## 免责声明

- 本项目为**非官方工具**，与金山办公 / WPS 无任何关联，未获其授权或认可。
- 它使用 WPS 网页版的未公开接口，通过**用户本人的登录会话**访问**用户本人的云盘**。
  请仅用于同步你自己有权访问的文件，并自行确认符合服务条款。
- 逆向得到的接口随时可能变更或失效，由此造成的问题请自行评估。
- 同步工具天然涉及数据搬运。**首次使用前请先做好备份**；建议先用 `--plan` / `--dry-run`
  观察它打算做什么，再放开真正执行。
- 本软件按"原样"提供，不附带任何明示或暗示的担保。使用风险由使用者自行承担。

---

## 致谢

- [**songying2024/wps-cloud**](https://github.com/songying2024/wps-cloud)（MIT）——
  `src/core/kdocs-core.mjs` 的独立引擎层提取自该项目 v2.8.1，特此署名。
- [rclone](https://rclone.org/)（MIT）—— 早期 WebDAV 桥接方案使用的同步引擎，
  现已不是主路径，如需复现该路径请自行下载 `rclone.exe` 放入 `tools/`。
- [Fluent UI React v9](https://github.com/microsoft/fluentui) —— 桌面界面的组件库
  （注意 `@fluentui/react-components` 是 v9；v8 的 `@fluentui/react` 是另一套东西）。

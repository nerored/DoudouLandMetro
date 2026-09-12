# 豆豆国的地铁 — Design System

> 本文件是 UI 的**唯一契约**：所有颜色、字号、间距、组件形态都必须能指回这里。
> 从既有代码里抽取（2026-09-13，1~7 号线时代的样式）+ 本次「全网 17 条线路 + 手机适配」重构的设计决定。
> 改 UI 之前先读它；需要新 token 就先加到这里，再用。

## 1. Atmosphere & Identity

**一块放在地铁站里的纸质地名牌。** 米纸底 + 墨色字 + 线路自己的颜色，安静、干净、有手感；
地图是主角，所有控件都是**服务地图的浮层**，而不是和地图抢地方的面板墙。

签名（signature）：**「抽屉升降」**——手机/竖屏上所有控件收进底部的一张抽屉（拖动把手三档：
peek / 半开 / 全开），桌面上同一套内容变成右侧固定 dock。抽屉的把手行永远显示**当前控制列车**
的实时胶囊（线路徽标 · 当前站 → 下一站 · 速度），所以「收起控件」不等于「丢失状态」。

第二签名：**线路马赛克**——17 条线路的颜色块组成一条可横向滑动的色带（不是 17 张卡片），
点一下「只看这条线」，地图立刻安静下来。

## 2. Color

### Palette（浅色，本项目只做浅色）

| Role | Token | Value | Usage |
|---|---|---|---|
| 纸底 | `--paper` | `#f2efe8` | 页面底色、地图外围 |
| 地图纸 | `--map-a` / `--map-b` | `#fbfaf6` → `#eeeade` | 舞台的径向渐变 |
| 卡片面 | `--card` | `#ffffff` | 抽屉/dock 里的卡片 |
| 面板面 | `--surface-2` | `#fbfaf6` | dock 背景、输入框底 |
| 分隔线 | `--edge` | `#d9d3c6` | 1px 分隔、卡片描边 |
| 主墨色 | `--ink` | `#22303d` | 标题、正文 |
| 次级墨 | `--ink-soft` | `#5b6b7b` | 标签、说明 |
| 弱墨 | `--ink-faint` | `#8b9199` | 版权、极次级信息 |
| 品牌蓝 | `--line` | `#0d6cb5` | 主行动、选中态、1 号线之外的中性强调 |
| 深蓝 | `--line-dark` | `#0a558c` | 按压态、蓝色文字 |
| 暖橙 | `--accent` | `#e0742a` | 次强调（只在「目标站」这类语义上用） |
| 成功 | `--ok` | `#2f8f5b` | TTS 正常等 |
| 警示 | `--warn` | `#8a5a08` | TTS 受限、暂停运营 |
| 线路色 | `M.lines[].color` | 17 条各一 | **只用于线路本身**：轨道、站点点、徽标、色块 |
| 抽屉把手 | `--handle` | `#c9c1b2` | 拖动把手 |

### Rules
- **线路色只表示线路**，绝不用来装饰界面；界面强调色固定是 `--line`。
- 一个界面里同时出现的强调色不超过 2 个（`--line` + 语义色）。
- 状态色只用于状态：`--warn` 表示「受限/暂停」，`--ok` 表示「正常」。
- 阴影一律带蓝墨色偏（`rgba(30,40,50,…)`），不用纯黑。

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Tracking | Usage |
|---|---|---|---|---|---|
| Title | 17px | 800 | 1.2 | -0.01em | 品牌名、抽屉标题 |
| H2 | 15px | 700 | 1.3 | 0 | 卡片标题、tab 标签 |
| Body | 13.5px | 500 | 1.45 | 0 | 站点名、按钮文字 |
| Body/sm | 12.5px | 500 | 1.4 | 0 | 键值对、次级文字 |
| Caption | 11.5px | 500 | 1.35 | 0.01em | 标签、说明、英文站名 |
| Micro | 10.5px | 500 | 1.3 | 0.02em | 版权、极次级信息 |
| Num | 继承 | 700 | 1.2 | 0.01em | 所有数字（`font-variant-numeric: tabular-nums`） |

### Font Stack
- 正文：`-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`
  （**系统字体，零外部依赖**——这是项目硬约束，不引入 web font）
- 数字：同上 + `font-variant-numeric: tabular-nums`（里程、速度、ETA 不会跳字）

### Rules
- **正文不小于 12.5px**（地图上的标签除外，它按缩放变化）。
- 只有 Title/H2 用 700+；正文用 500，靠颜色和间距分层，不靠加粗。
- 数字一律 tabular-nums。

## 4. Spacing & Layout

### Base Unit
4px。token：`--s1 4 / --s2 8 / --s3 12 / --s4 16 / --s5 20 / --s6 24`。
半径：`--r-xs 8 / --r-sm 10 / --r 12 / --r-lg 16 / --r-pill 999`（容器用大半径，内部元素用小半径）。

### Shell（**这是本次重构的核心**）
- `#app` 是 shell：宽屏横屏 `display:grid; grid-template-columns: 1fr clamp(300px,26vw,360px)`；
  竖屏/手机 `grid-template-columns: 1fr`，`#panel` 变成 `position:absolute` 的**底部抽屉**。
- **滚动归属**（唯一一处可滚）：dock/抽屉的 `.panel-body` 拥有纵向滚动
  （`min-block-size:0` + `overflow:auto`）。地图舞台**从不滚动**，页面整体也**从不滚动**（`body{overflow:hidden}`）。
- 全高一律 `100dvh`，不用 `100vh`。
- 抽屉三档高度由 `#app[data-snap]` 决定：`peek`（把手行 56px + 状态行 48px）/ `half`（52dvh）/ `full`（86dvh）。
- 手机横屏（高度 ≤ 560px）不再用抽屉，改用 **右侧 dock 320px**，让地图保住整屏高度。

### Breakpoints（用状态命名，不用设备名）
| 名字 | 条件 | 布局 |
|---|---|---|
| `--bp-wide` | `(min-width: 821px) and (min-aspect-ratio: 1/1)` | 右侧 dock + 地图 |
| 其余（窄屏 / 竖屏） | 默认 | 底部抽屉 + 地图 |
| 矮横屏 | `(max-height: 560px)` | 右侧 dock（窄） |

### Rules
- 触控目标 ≥ 44px（tab、按钮、站点行、色块）；间距用 `--s*`。
- 安全区：抽屉与 dock 的 padding 都加 `env(safe-area-inset-*)`。
- 内容压力（必须扛住）：空列表、40 字长站名（省略号）、无空格英文名（`overflow-wrap:anywhere`）、
  375px 宽下不出现横向滚动。

## 5. Components

### tabbar（5 个 tab：线路 / 列车 / 导航 / 站点 / 图例）
- **Structure**: `<div class="tabs" role="tablist">` + `<button class="tab" role="tab" aria-selected>`（图标 + 文字 + 可选计数）
- **Spacing**: 高 52px，tab 内 gap `--s2`；选中态用 2px 底部条（`--line`）
- **States**: default（`--ink-soft`）/ hover（背景 `--surface-2`）/ active（`scale(.98)`）/ selected（`--ink` + 底条）/ focus-visible（2px outline）
- **Accessibility**: `role=tablist/tab/tabpanel`，键盘左右键切换，`aria-controls` 指向面板
- **Motion**: 底条 `transform: scaleX()` 140ms；面板切换淡入 140ms
- **Layout**: `stack` 的头部；**不滚动**

### line-chip（线路色块 + 名称 + 站数）
- **Structure**: `<button class="lchip" data-line="6"><i style="background:#color"></i>6 号线<em>56</em></button>`
- **Variants**: `on`（只看该线，边框用线路色 + 浅底）
- **States**: default / hover / active / focus-visible / `on`
- **Accessibility**: `aria-pressed`
- **Layout**: `reel`（横向滑动，`scroll-snap-type: x proximity`），一行 3~4 个

### row-btn（站点行）
- **Structure**: `<button class="row-btn" data-st="id"><span class="no">1|05</span><span class="nm">骡马市</span><span class="tag">换乘</span></button>`
- **Spacing**: 高 48px，内边距 `--s3`
- **States**: default / hover / active / focus / `.here`（当前站，蓝底浅）/ `.target`（目标站，橙描边）
- **Accessibility**: 原生 button；文字 13.5px；长名省略号
- **Layout**: `stack`，父级 `.panel-body` 是滚动归属

### train-card（每线一列，共 17 张，横向 reel）
- **Structure**: `<button class="tchip"><i class="tchip-dot"></i><b class="tchip-line">6号线</b><span class="tchip-pos">望丛祠 → 兰家沟</span></button>`
- **Variants**: `on`（当前控制列车：线路色描边 + 浅底）
- **Layout**: `reel`（横向滑动）；**这是 17 列车唯一的切换入口**，所以不能藏进二级菜单

### kpi（键值对）
- **Structure**: `<span class="kpi"><i>预计到达</i><b>4 分 12 秒</b></span>`
- **States**: 无值显示 `—`；数字 tabular-nums
- **Layout**: `cluster`

### btn（按钮）
- **Variants**: `btn-primary`（蓝底）/ `btn`（白底描边）/ `btn-quiet`（无框，文字色）/ `btn-mini`（HUD 里，高 44px）
- **States**: default / hover（背景微移）/ active（`scale(.97)`）/ focus-visible / `[disabled]`（0.45 透明）
- **Motion**: 140ms `--ease-out`

### field（表单）
- **Variants**: `select`（交路）/ `search`（站点搜索，带前置图标与清除按钮）
- **States**: default / focus（描边变 `--line` + 2px focus ring）/ filled
- **Accessibility**: 显式 `<label>`；搜索框 `type="search"` + `aria-label`

### sheet（底部抽屉，手机上）
- **Structure**: `#panel` + `.sheet-handle`（把手行，含 `--handle` 横条 + 状态胶囊）+ `.tabs` + `.panel-body`
- **States**: `data-snap=peek|half|full`；拖动中 `dragging`（关闭过渡）
- **Accessibility**: 把手是 `<button aria-label="展开/收起控制面板">`，可点可拖；键盘 Enter 循环三档
- **Motion**: `transform: translateY()` 260ms `--ease-out`（GPU）；`prefers-reduced-motion` 时改为 0ms 直跳

### hud（地图左上角状态）
- **Structure**: 品牌行（标题 + 刷新/声音两个 44px 按钮）+ **状态胶囊行**（线路徽标 · 当前站 → 下一站 · 速度/阶段）+ 可折叠的详情行（里程/ETA/目标）
- **States**: `folded`（只留品牌行 + 胶囊行）；点品牌行切换
- **Layout**: `imposter`（绝对定位浮在舞台上），`pointer-events:none`，内部控件单独恢复

### legend（在「图例」tab 里的站点符号说明 + 版本行）
- **Structure**: 符号网格（换乘 / 普通 / 端点 / 在建·暂停）+ 版本行 `#verRow` + 数据来源与版权
- **Constraint**: `#verRow` 必须在 `#panel` 内（发版查更新的入口）；**地图上不再有图例浮层**
- **Layout**: 面板内普通卡片；地图左下角留给比例尺与地图本身

### reel（横向滑动条）
- `overflow-x:auto` + `scroll-snap-type: x proximity` + `scrollbar-width: none`；
  两端加渐隐遮罩（`mask-image`）提示「还能滑」；键盘可达（可聚焦 + 方向键）。
- 归属：**reel 拥有自己的横向滚动**，不与 `.panel-body` 的纵向滚动冲突（`touch-action: pan-x`）。

## 6. Motion & Interaction

| Type | Duration | Easing | Usage |
|---|---|---|---|
| Micro | 140ms | `--ease-out` | 按钮按压、tab 底条、chip 选中 |
| Standard | 240ms | `--ease-out` | 折叠展开、tab 面板切换 |
| Emphasis | 320ms | `cubic-bezier(.16,1,.3,1)` | 抽屉拖动松手吸附 |

### Rules
- 只动 `transform` / `opacity`；抽屉用 `translateY`，绝不改 `height`。
- 每个可点元素都有 hover / active / focus-visible 三态；抽屉把手额外有拖动反馈。
- `prefers-reduced-motion: reduce` → 所有过渡降到 1ms（不是删除交互，只是去掉位移感）。
- 不做无意义的装饰动画：地图上的脉冲圈、气泡是**信息**（下一站/到达时间），保留。

## 7. Depth & Surface

### Strategy
**mixed（纸张体系）**：dock/抽屉里的卡片 = 描边（`1px --edge`）+ 极浅阴影；
浮在地图上的 HUD/图例/把手 = 玻璃面（半透明纸 + `backdrop-filter: blur(10px)` + 1px 内描边 + 分层阴影）。

| Level | Value | Usage |
|---|---|---|
| Subtle | `0 1px 2px rgba(30,40,50,.06)` | 卡片静止 |
| Default | `0 2px 10px rgba(30,40,50,.10)` | 抽屉、dock |
| Floating | `0 8px 28px rgba(30,40,50,.16)` | HUD、图例、悬浮窗、气泡 |

## 8. 运行时规则（不变量）

这些是上面所有组件的“不可协测”约束，自检里都有对应断言：

1. **舞台不滚动，页面不滚动**：`html,body{overflow:hidden}`，唯一可滚元素是 `.panel-body`。
   禁止 `scrollIntoView`（会把 document 一起滚，固定外壳就错位）——用 `panelBody.scrollTop` 手算。
2. **抽屉三档由 JS 算**：`--sheet-t`（向下推的 px）与 `--sheet-h`（当前遮住多少）写在 `#app` 的内联样式上，
   CSS 只消费；地图浮层（图例/比例尺/字幕/toast）用 `bottom: calc(... + var(--sheet-h))` 自动避让。
3. **地图信息密度按舞台宽度分档**：`stage.w < 480` 时只保留**当前控制列车**的贴片与到站气泡
   （强调圈全画），否则 17 列车的标签会把手机地图盖满。
4. **站名标签按屏幕分两档**：宽舞台（`stage.w >= 700`）15px、窄舞台 11px，都是**屏幕恒定**
   （`labelScale = screenPx / (15 * view.k)`，不再设上限或下限）；数量交给小视口预算（面积/16000，16~34）+ 防重叠淘汰。
   同优先级的标签用**空间哈希**打散（按纬度取会把预算全花在最北边那一撮）。
   25% 遮挡阈值不得放宽。
5. **地图适配范围为可见带**：`fitView` 用 `舞台高 - 抽屉可见高` 做适配，否则竖屏上全网会被抽屉压掉一半。
6. **地图浮层只有 HUD / 比例尺 / 指北针**：图例、版本、版权都在面板的「图例」tab（不再压地图）。
7. **底图道路层按缩放分档**：`k >= CFG.roadsFullZoom` 完整 / `CFG.roadsHideZoom <= k < 上面` 只留主线 /
   更低整层不画（实测道路层占一帧栅格时间的一半以上，而隐藏档线宽不足 1px）。
   **阈值必须“咬得住”**：要高于各布局全网适配 zoom（0.17~0.28），否则会出现“要缩到很高才隐藏”的无效档。
8. **列表布局按屏幕分**：宽屏（dock）用网格 / 竖向列表把空間用满（线路 3 列、切换列车 1 列多行）；
   手机/抽屉用横滑带。双击站点行 = 视角聚焦到该站（居中到可见区 + 字号至少 1.5x + 关掉跟随）。
9. **倒计时一律走锚点**（`anchorMake` / `anchorSec` + 每帧 `paintCountdowns`）：
   任何“剩余秒数”不得直接写死文本，否则 10x 下会一跳好几秒；切倍速时锚点自愈不跳变。
9. **关声音 = 立即静音**：清空语音队列 + `speechSynthesis.cancel()` + 令牌作废看门狗。
10. **触控目标 ≥44px**，且每个可点元素都有 hover / active / focus-visible 三态。

## 9. Accessibility Constraints & Accepted Debt

### Constraints
- 目标 WCAG 2.1 AA：正文对比 ≥ 4.5:1（`--ink` on `--paper` = 11.4:1 ✓，`--ink-soft` = 5.1:1 ✓）；
  所有交互元素可见 focus ring；键盘可达（tab 序：HUD 按钮 → 图例 → tab → 内容 → 悬浮窗）；
  `prefers-reduced-motion` 生效；触控目标 ≥ 44px；`aria-live` 用于报站字幕与 toast。
- 抽屉/面板用真语义：`<aside>`、`role="tablist"`、`<button>`（不用 div 当按钮）。

### Accepted Debt
| Item | Location | Why accepted | Owner / Exit |
|---|---|---|---|
| 没有暗色模式 | 全局 | 本项目是「纸质地名牌」单主题；暗色需要重做底图配色 | 用户提出时再做 |
| 地图上的站名标签不参与 WCAG 对比要求 | SVG 标签 | 标签会按缩放变化且允许被隐藏，不作为正文 | 长期 |
| 抽屉拖动不做惯性抛物线 | 手机抽屉 | 三档吸附已够用；惯性需要额外物理参数与测试 | 有反馈时再做 |
| 未跑 Lighthouse（无 Playwright/本机无 Linux Chrome） | 全局 | 本机只有 Windows 宿主 Edge 无头；用应用自带 87 项断言 + 多视口截图代替 | 环境具备时补跑 |

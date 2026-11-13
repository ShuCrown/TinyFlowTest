# 录制器跨系统适配分析与改造方案

- 日期：2026-11-12
- 分支：`ui-design`
- 起因：「当前系统操作记录似乎只对 antd 5.5 相关系统适用，切换系统后录制步骤就失效了，适用场景太受限」
- 状态：**方案待批准。分析期间工作树出现并发改动，诊断第 2 条已有未提交修复，详见 §10**

---

## 1. 结论摘要

用户判断方向正确，但失效机制比「只支持 antd 5.5」更具体：

- **基础步骤（点击 / 输入 / 导航 / 取值）其实是通用的**，不依赖 antd。
- **真正崩的是复合组件**（Select / Cascader / DatePicker / Dropdown / 弹窗表格选择器）。
- 存在一条**交叉污染路径**，会让非 antd 系统必然回放失败（见 §2 第 7 条）。
- 当前设计把 ARIA 契约**最差**的库（antd v5 可见项没有 `role=option`）当成了默认路径，这是方向性错误。

推荐方向：**通用 ARIA 内核 + 按文档解析规则集 + DSL 自包含**，分 4 个独立可发布阶段落地。

> 注：7 条诊断中第 2 条（点击被静默丢弃）在工作树中已有未提交修复，其余 6 条全部仍然成立。
> 主因是第 7 条交叉污染，兜底点击并不能修复它。详见 §10。

---

## 2. 诊断（精确到行）

| # | 位置 | 问题 |
|---|---|---|
| 1 | `src/dsl/panel-rules.ts:48-107` | 5 条规则里 4 条的 panel/item 选择器是 `.ant-*` 类名。`RULES_LIBRARY`(:13) 声明了但**全仓无人引用**，没有按系统切换的入口 |
| 2 | `src/recorder/dom-recorder.ts:824-843` | ~~`clickTargetFor` 返回 null → `onClick`(:249) 直接 return，**整次点击不落盘**~~ **已修复（工作树未提交，见 §10）**。原问题：无 role 的 `<div>` / `<li>` 自研下拉全部丢失 |
| 3 | `src/recorder/dom-recorder.ts:384-408` | `onHover` 在 `matchElement` 为 null 时不跳过 → 任何带 `aria-expanded` / `aria-haspopup` 的元素悬停都生成 hover 节点（MUI 的 `div[role=combobox]` 正中） |
| 4 | `src/dsl/panel-rules.ts:121-123` | `isGeneratedId` 只认 `rc_select_*`。Element Plus `el-id-*`、MUI `mui-*` 这类自增 id 被 `stableId`(`dom-recorder.ts:1044`) 判为稳定，`css/#…` 排到候选首位（`cssTier` tier 0），重挂载即失效 |
| 5 | `cluster.ts:154,226,278`；`chrome-recorder.ts:634,648`；`panel.ts:156` | 行为写死在 rule **id** 上（`antd-cascader` / `antd-modal` / `antd-select`），换库即失效 |
| 6 | `dom-recorder.ts:1038`；`engine.ts:2413` | 表单标签锚点写死 `.ant-form-item` |
| 7 | **`panel-rules.ts:65` + `chrome-recorder.ts:588`** | **最致命**：Element Plus 的 `input[role=combobox]` 会先命中 `antd-select`，但它的 panel `.ant-select-dropdown` 在该页不存在 → 转换期把**错误的面板选择器写进 DSL**，回放必然等不到面板 |

### 2.1 第 7 条的现成证据

`public/demo/customers.html`（375 行）**完全没有 antd 类名**，是纯 HTML + ARIA 的 fixture。它的悬浮菜单链路：

1. 触发器带 `[aria-haspopup="menu"]` → 命中 `antd-dropdown` 的 trigger（这条选择器是 ARIA 的）；
2. `onHover` 因 `rule.triggerAction === "hover"` 记录 hover，`semantic.rule = "antd-dropdown"`；
3. 菜单项是 `button[role=menuitem]`，但 `antd-dropdown` 的 panel 是 `.ant-dropdown`（该页不存在）→ `matchElement` 返回 null；
4. 走 `overlayItemSemantic`(`dom-recorder.ts:927`) → 产出的 semantic **没有 `rule` 字段**；
5. `cluster.ts:137` 的 `if (!overlayStart && next.rule !== rule) break;` → 直接 break；
6. `picks.length === 0` → 簇折叠失败，退化成 hover + click 两个独立节点。

`overlayStart` 为 false 的原因是触发器**有** rule（`cluster.ts:93`：`overlayOpen === true && !semantic.rule`）。

**结论：项目自己的 demo 页已经在走降级路径。** 「ARIA 触发器 + antd 类名面板」的混合规则表本身就内部不一致。

### 2.2 文档缺失

`panel-rules.ts:6` 引用 `docs/record-to-steps-redesign.md` 附录 A（选择器白名单 / 禁止项、升级前必须重跑的探针），**该文件在仓库中不存在**。因此：

- 今天没有任何可执行的规则验证载体；
- 白名单 / 禁止项只能从 `isDeniedCss`(`panel-rules.ts:134-147`) 反推。

---

## 3. 外部证据（已核对真实源码，非记忆）

### 3.1 MUI `SelectInput.js`

```
trigger : div[role=combobox]
          aria-expanded / aria-haspopup="listbox"
          aria-controls={open ? listboxId : undefined}   ← 仅展开时挂，与 antd 同
          tabIndex=0, id = mui-component-select-${name}
list    : ul[role=listbox]  id = useId()                 ← 不稳定
item    : li[role=option][aria-selected][data-value]     ← 真值在 data-value
展开时机 : handleMouseDown → update(true, event)          ← mousedown，与 antd 同
```

与 antd 同构，**只差类名和值属性**（antd 用 `title`，MUI 用 `data-value`）。现有 `clickElement` 的 pointer 事件序列(`engine.ts:1852`)可直接复用。

### 3.2 Element Plus `select.vue`

```
trigger : input[role=combobox]
          aria-controls={contentId}    ← 关闭时也存在，与 antd/MUI 不同
          aria-expanded / aria-haspopup="listbox" / aria-activedescendant
          readonly（非 filterable 时）
          实际点击落在 .el-select__wrapper（@click.prevent="toggleMenu"）
list    : el-scrollbar 渲染为 ul[role=listbox]，id = contentId
          wrap class .el-select-dropdown__wrap / view class .el-select-dropdown__list
item    : el-option → li.el-select-dropdown__item
```

现有 `backfillTrigger` / `preGesturePopupId` 逻辑够用；`findScrollable`(`engine.ts:1258`) 按 computed style 判定，天然兼容 el-scrollbar。

### 3.3 Radix Select（本地 `node_modules/@radix-ui/react-select` 实测）

产物中出现的 role：`combobox`、`listbox`、`option`、`group`、`presentation`。契约齐全。id 来自 `@radix-ui/react-id` → `useId`，不稳定。

### 3.4 Playwright `selectorGenerator.ts`（可直接搬的三个机制）

**① 打分顺序（ARIA 优先，css 兜底）**

```
kTestIdScore            = 1        data-testid
kOtherTestIdScore       = 2        其它 data-test*
kRoleWithNameScore      = 100      role + accessible name
kPlaceholderScore       = 120
kLabelScore             = 140
kAltTextScore           = 160
kTextScore              = 180
kTitleScore             = 200
kCSSIdScore             = 500      css #id
kRoleWithoutNameScore   = 510
kCSSInputTypeNameScore  = 520
kCSSTagNameScore        = 530
kNthScore               = 10000
kCSSFallbackScore       = 10000000
```

**② `isGuidLike(id)`：与组件库无关的不稳定 id 判定**

统计字符类（lower / upper / digit / other，`-` `_` 跳过）跳变次数，`transitionCount >= id.length / 4` 即判为 guid-like，拒绝用作 `#id` 定位。**这条可直接取代 `rc_select_*` 专属正则。**

**③ 录制时验唯一 + 永不返回空**

- 每个候选当场 `querySelectorAll`，`elements.length === 1` 即 perfect strict match，立即 break；
- 不唯一时取 nth 或父级嵌套，`index > 5` 直接弃用该候选；
- `generateSelector` 末尾恒有 `cssFallback(...)`，**绝不返回 null**；
- 先 retarget 到最近可交互祖先：`closest('button,select,input,[role=button],[role=checkbox],[role=radio],a,[role=link]')`。

### 3.5 与本仓现状的对照

`chrome-recorder.ts:715-724` 的 `IMPORT_STRATEGY_RANK` 把 **css(3) 排在 label(4) / text(6) 之前**，与 Playwright 相反。原注释的理由是「同名字符串在背景列表与弹窗里各有一份，先生效会点错」。

正解不是压低文本优先级，而是**用 scope + 录制时唯一性验证**消除歧义（Playwright 机制 ③）。

---

## 4. 推荐方案

**通用 ARIA 内核 + 按文档解析规则集 + DSL 自包含。**

```
                 ┌──────────────────────────┐
   target doc ──▶│ detectRuleSet(doc)       │  按 DOM 指纹选 1 个 pack
                 │  = aria core + 1 pack    │  （不是所有 pack 的并集）
                 └────────────┬─────────────┘
                              │ rules（attach 时解析一次）
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
  DomRecorder           OverlayWatcher         Replay engine
   (semantic)            (弹层生命周期)        (读 node.panel.*)
        │                     │                     ▲
        └──────▶ clusterSteps ┘                     │
                (能力字段切簇)                       │
                        ▼                           │
              importChromeRecorder ──▶ FlowDsl ─────┘
              写自包含 panel.items/rows/itemScope
```

无环。核心是砍掉今天的**双真相源**：engine 既查全局 `PANEL_RULES`（`panel.ts:27`）又读 `meta.rule`，两边可能不一致。

### 4.1 阶段划分（每段独立可发布）

#### 阶段 1a · 定位与事件通用化（6 文件，最小可发布单元）

| 文件 | 改动 |
|---|---|
| `src/dsl/panel-rules.ts` | `isGeneratedId` → `isGuidLike` + 已知生成器模式（`rc_select_` / `el-id-` / `mui-` / `:r\d:`） |
| `src/recorder/dom-recorder.ts` | ~~`clickTargetFor` 永不返回 null~~ **已完成（§10）**；剩余：`onHover`(:384) 改为**只在悬浮真的开了面板时记录**（复用 OverlayWatcher 证据，不查 `rule.triggerAction`）；`formLabelFor`(:1033) 去 `.ant-form-item`，改通用 label 容器 + `aria-labelledby`；`DIALOG_SCOPE`(:1011) 去 antd 类名 |
| `src/recorder/chrome-recorder.ts` | `withDialogScope` 去类名；`IMPORT_STRATEGY_RANK` 把 role+name 提到 css 前，**但仅当该候选在录制 scope 内验证唯一** |
| `src/replay/engine.ts` | `closestLabelControls`(:2413) 去 `.ant-form-item` |
| `public/demo/aria-select.html` | 新增 fixture：ARIA 版 select / date / dialog |
| `test/locator-portability.test.mjs` | 新增探针测试 |

**交付价值**：非 antd 系统的基础步骤不再丢点击、不再刷 hover 噪声、不再被自增 id 坑。

#### 阶段 1b · 规则集解析 + ARIA 内核 + 自包含 DSL（11 文件，**超过 8 个，明确 acknowledge**）

| 文件 | 改动 |
|---|---|
| `src/dsl/rule-packs/antd.ts` | 新增：现有类名表整体搬入，**rule id 不改名**（旧记录零迁移） |
| `src/dsl/rule-packs/aria.ts` | 新增：`[role=combobox]` / `[role=listbox]` / `[role=option]` / `[role=menu]` / `[role=menuitem]` / `[role=dialog]` |
| `src/dsl/rule-packs/index.ts` | 新增：registry + `detectRuleSet(doc)`，**每文档只选 1 个 pack + core** |
| `src/dsl/panel-rules.ts` | 拆出 core；`PanelRule` 加能力字段 `kind:"dropdown"\|"dialog"` / `multiColumn` / `filteredSingle`；`matchElement(el, rules)` 显式传规则集 |
| `src/dsl/types.ts` | `PickerPanel` 加 `items` / `rows` / `itemScope` / `valueAttr` / `multiColumn`（全部可选） |
| `src/recorder/dom-recorder.ts` | attach 时解析一次规则集并注入 |
| `src/recorder/overlay.ts` | `OVERLAY_SELECTOR` 改为按规则集构造 |
| `src/recorder/cluster.ts` | 5 处 id 硬编码 → 能力字段；允许 `overlayItem` 成员加入已由规则起簇的段 |
| `src/recorder/chrome-recorder.ts` | `pickerNodeFromCluster` 写入自包含 `panel.*` |
| `src/replay/panel.ts` | `pickerRule` / `pickScopes` 优先读 `node.panel.*`，缺失才回退规则表 |
| `src/replay/engine.ts` | 同上；`pickScopes` 用 `multiColumn` 而非 `rule.id === "antd-cascader"` |

**交付价值**：MUI / Radix / Element Plus / 任何 ARIA 合规系统的复合组件能折成 picker 并回放；antd 行为逐位不变（回归测试保证）；demo 页悬浮菜单能折叠（今天不能）。

#### 阶段 2 · 无 ARIA 的行为兜底（4 文件）

把 `OverlayWatcher` 升级成 `PopupModel`：

- 浮层识别：点击后新出现的元素，按几何 + z-index + DOM 位置（body 末尾 / portal）判定；
- 条目推断：浮层内**同构重复兄弟节点**；
- 值来源：`textContent` → `title` → `data-*`；
- commit：点击后使浮层消失的按钮；
- 全部标 `needsConfirm` + 置信度，工作台可一键把推断出的选择器**固化进记录**。

**这一段才是真正解决「自研系统」的。** 涉及 `overlay.ts` → `popup-model.ts`、`dom-recorder.ts`、`cluster.ts` + fixtures/tests。

#### 阶段 3 · 按系统显式绑定 + 版本管理（5 文件）

- `src/lib/types.ts`：`TargetSystem.uiLibrary`
- `src/dsl/types.ts`：`SystemConfig.uiLibrary`
- `src/pages/SystemsPage.tsx`：库选择器，探测结果可手工覆盖
- `src/pages/RecordWorkbenchPage.tsx`：把 pack 传给 recorder（attach 点在 :342 / :609）
- `src/dsl/rule-packs/index.ts`：pack id + version 写进录制 JSON 与 DSL meta

**交付价值**：新增组件库从此只加数据文件，不改逻辑。

### 4.2 最小方案（不推荐，但列出）

只往现有 `PANEL_RULES` 塞 `.el-*` / `.Mui*` 别名 + 扩 `isGeneratedId` 正则，**2 文件**。

- 能救 Element Plus / MUI；
- 救不了自研系统；
- **会让 §2 第 7 条交叉污染更严重**（更多库的 trigger 命中错误的 pack）；
- 触发 §6 的规模爆炸。

若只想先救一个已知系统，这是最快路径；否则不推荐。

---

## 5. 关键决策

1. **每文档解析 1 个 pack，不做选择器大联合** —— 见 §6 规模攻击。
2. **DSL 自包含**，回放不再依赖全局规则表；这是跨系统可移植的根。
3. **能力字段取代 rule id 分支**，行为由数据驱动。
4. **rule id 不改名**，旧记录零迁移、代码可回滚。
5. **零新依赖**：`isGuidLike` 是搬逻辑不是装包，用户侧零安装成本。

---

## 6. 最脆弱假设与攻击角度

### 6.1 最脆弱假设（premise collapse）

> **「目标系统实现了 ARIA 复合框契约」**

- 已验证成立：MUI、Element Plus、Radix。
- **不成立**：antd v5 可见项（无 `role=option`，只在 0x0 镜像里）、Vue2 Element UI、多数自研 div 组件。

**若假设不成立会怎样**：1a + 1b 只解决一半，复合组件仍退化成扁平步骤。

**设计变形**：1b 必须保留类名 pack，阶段 2 必须做行为兜底 —— **不能删掉类名规则**。若第二个目标系统是无 ARIA 自研栈，1a 之后应直接跳阶段 2。

### 6.2 攻击角度

| 角度 | 结论 |
|---|---|
| **依赖失败** | 无新外部依赖，无降级问题。`isGuidLike` 是搬逻辑不是装包 |
| **规模爆炸（命中，已变形设计）** | `matchElement` 每事件遍历 规则 × 选择器 次 `closest()`。5 个 pack 并成大表 = 125+ 次/事件，`mouseover` 高频会卡顿；`hasVisiblePanel` / `visibleItems` 还带 `getComputedStyle`。→ **这就是决策 1 的由来，也是最小方案被否的技术原因** |
| **回滚成本** | 新增 DSL 字段全部可选，旧代码忽略；旧记录 `meta.rule="antd-select"` 仍由 antd pack 解析。代码回滚后旧记录照常回放，新记录退化到通用选择器但**不损坏数据**，无迁移 |

---

## 7. 验证

### 7.1 基线（已实测，含 §10 的并发改动）

```bash
node --test test/*.test.mjs        # → tests 96 / pass 96 / fail 0
./node_modules/.bin/tsc --noEmit   # → exit 0（干净）
```

注：`.workbuddy/memory/2026-11-09.md` 记录的「124 个既存类型错误」已不复现，当前 typecheck 干净。
分析开始时基线为 90 pass；`test/dom-recorder-click-target.test.mjs` 新增 6 条后为 96 pass。

### 7.2 每阶段验收

- 上述两条命令必须保持 **96+ pass / exit 0**；
- 新增探针测试，对每个 fixture 断言：
  1. `matchElement` 的 zone / rule 命中正确；
  2. 生成的 `panel.items` 选择器在该页**唯一命中**；
  3. `isGuidLike` 对 `el-id-*` / `mui-*` / `rc_select_*` / `:r1:` 的判定符合预期；
- `pnpm dev` 手工跑三页录制 → 回放：
  - antd 版（回归，行为必须逐位不变）
  - ARIA 版（`public/demo/aria-select.html`）
  - 无 ARIA 自研版（阶段 2 新增）
- **1b 额外断言**：`public/demo/customers.html` 的悬浮菜单能折成 picker（今天不能，见 §2.1）。

### 7.3 环境注意

- 构建需指定项目外的 `--outDir`（清空 `dist` 会被 WorkBuddy safe-delete 拦截）：
  `pnpm exec vite build --outDir /tmp/tinyflow-verify-dist`
- 跨域目标依赖开发期同源代理（`src/lib/proxy.ts` + `vite.config.ts` 的 `/__tinyflowtest/config`、`/__tinyflowtest/target`）；静态部署下 `proxied=false`，只能录制同源目标。**这与组件库无关，但换系统时必须先确认代理已切到目标 origin**（`activateProxyTarget`）。

---

## 8. 未知项（明确延后，附 owner）

| 项 | 说明 | Owner / 时点 |
|---|---|---|
| 各库自增 id 的确切格式 | Element Plus `el-id-`、MUI `mui-` 需在 fixture 探针里实测确认。`isGuidLike` 与格式无关，**不阻塞决策** | 实现者 / 阶段 1a 内 |
| `docs/record-to-steps-redesign.md` 缺失 | 附录 A 白名单只能从 `isDeniedCss` 反推。把探针落成测试文件即可，**不必补文档** | 实现者 / 阶段 1b 内 |
| 第二个目标系统的技术栈 | 决定阶段 2 与 3 的优先级（见 §6.1）。**需用户确认** | 用户 / 批准方案时 |

---

## 9. 参考来源

- MUI `SelectInput.js`：https://raw.githubusercontent.com/mui/material-ui/master/packages/mui-material/src/Select/SelectInput.js
- Element Plus `select.vue`：https://raw.githubusercontent.com/element-plus/element-plus/dev/packages/components/select/src/select.vue
- Playwright `selectorGenerator.ts`：https://raw.githubusercontent.com/microsoft/playwright/main/packages/injected/src/selectorGenerator.ts
- Radix Select：本地 `node_modules/@radix-ui/react-select/dist/*.mjs`

### 本仓关键文件

| 文件 | 行数 | 角色 |
|---|---|---|
| `src/dsl/panel-rules.ts` | 316 | 规则表 + 匹配 + 可见性（三方共用） |
| `src/recorder/dom-recorder.ts` | 1253 | DOM 事件录制（含 §10 的未提交修复） |
| `src/recorder/chrome-recorder.ts` | 991 | 步骤 → DSL 转换 |
| `src/recorder/cluster.ts` | 369 | 步骤 → 意图簇 |
| `src/recorder/overlay.ts` | 92 | 无规则组件的弹层生命周期 |
| `src/replay/engine.ts` | 2726 | 回放执行 |
| `src/replay/panel.ts` | 186 | 面板绑定与开合谓词 |
| `public/demo/customers.html` | 375 | 现有 fixture（纯 ARIA，无 antd 类名） |

行号与行数核对时间：2026-11-12 14:52（工作树含未提交改动）。

---

## 10. 工作树漂移记录

分析进行中（14:48）工作树出现并发改动，本文档已按改动后的真实状态核对行号。

```
 M src/recorder/dom-recorder.ts          (+16 / -3)
M  vite.config.ts                        (+23 / -1，已 staged)
?? test/dom-recorder-click-target.test.mjs  (新增，6 条用例)
?? docs/                                 (本文档)
```

### 10.1 诊断第 2 条已被修复

`clickTargetFor` 已导出并补上全量兜底，不再返回 null：

```ts
export function clickTargetFor(raw: Element, match: RuleMatch | null): Element | null {
  if (match && (match.zone === "item" || match.zone === "row")) return match.element;
  const actionable = raw.closest(ACTIONABLE_SELECTOR);
  if (actionable && !actionable.closest("svg") && !isPlainField(actionable)) return actionable;
  if (match?.zone === "trigger") return controlFor(match.element);
  return fallbackClickTarget(raw);   // ← 新增
}

function fallbackClickTarget(raw: Element): Element | null {
  const doc = raw.ownerDocument;
  if (raw === doc.body || raw === doc.documentElement) return null;
  if (isPlainField(raw)) return null;
  return raw;
}
```

配套 `test/dom-recorder-click-target.test.mjs` 覆盖：自定义 div、嵌套 span、纯输入控件不记、原生 button、页面根节点不记、规则命中的表格行优先。

### 10.2 与本方案的差异

| 项 | 本方案原提议 | 工作树实现 | 评价 |
|---|---|---|---|
| 兜底目标 | 最近可交互祖先 → 弹层内同构条目 → css 路径 | 直接返回 `raw`（实际被点元素） | 更简单，事件冒泡后父级 handler 仍会触发，可接受 |
| 排除项 | 页面根节点 | 页面根节点 + 纯输入控件 | 一致，且多排除了输入控件（意图由 change 表达），更干净 |
| `cursor:pointer` | 未强制 | 测试桩里备了 `getComputedStyle`，但实现未使用 | 无需引入，避免每事件读 computed style |

### 10.3 遗留待验证项（不是已确认的 bug）

1. **噪声转移**：以前「静默丢弃」的容器级点击现在会被记录，随后在 `chrome-recorder.ts:154` 的 `isContainerClick` 处被跳过并产生 warning。需实跑一遍确认 warning 量是否可接受；若过多，应在录制端而非转换端收敛。
2. **嵌套落点稳定性**：记录 `raw`（如按钮内的 `<span>` / 图标）时，css 路径指向子节点；子节点被应用重渲染后路径可能失效。原提议的「最近可交互祖先」对此更稳。需在无 ARIA fixture 上实测后再决定是否加一层 retarget。
3. **阶段 1a 剩余项未动**：`onHover` 噪声、`isGuidLike`、`.ant-form-item`、`DIALOG_SCOPE` 均保持原状。

### 10.4 对方案的影响

- 阶段 1a 的文件数不变（`dom-recorder.ts` 仍有 hover / label / dialog 三处要改），但工作量减少约 1/4。
- 诊断第 1、3、4、5、6、7 条**全部仍然成立**，尤其是第 7 条交叉污染 —— 它才是「切换系统就失效」的主因，兜底点击并不能修复它。
- 批准方案前应先确认 `vite.config.ts` 的 staged 改动意图，避免与本方案冲突。
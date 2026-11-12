import type { ChromeRecorderStep } from "./chrome-recorder.ts";
import type { Detection } from "../dsl/panel-rules.ts";

/**
 * 录制步骤 → 意图簇。
 *
 * 输入是与 Chrome Recorder 同构的 steps（可带 semantic），输出按原顺序排列的段：
 * 折叠成功的 picker 簇，以及没被折叠的单步。转换器只消费这个序列，不再自己猜。
 *
 * 切簇依据（docs 5.2）：
 * - 开簇：触发器步骤（zone=trigger 的 click / hover），或「无语义点击后紧跟弹窗内交互」；
 * - 成员：同一规则、面板展开期间的筛选 / 选项 / 行；
 * - 收簇：下一次触发器点击、出现导航、或弹窗的提交按钮；
 * - 没有 semantic 的外部 JSON 走结构降级，标 needsConfirm。
 */

export interface ClusterStep {
  step: ChromeRecorderStep;
  index: number;
}

export interface PickerCluster {
  kind: "picker";
  /** panel-rules 的规则 id；结构降级时为 structural。 */
  rule: string;
  mode: "inline" | "dialog";
  detection: Detection;
  source: "semantic" | "structural";
  trigger: ClusterStep;
  filters: ClusterStep[];
  picks: ClusterStep[];
  commit?: ClusterStep;
  /** 被折叠的原始 step 下标，转换期据此跳过它们。 */
  indices: number[];
  confidence: number;
  needsConfirm: boolean;
  warnings: string[];
}

export interface StepSegment {
  kind: "step";
  at: ClusterStep;
}

export type RecordingSegment = PickerCluster | StepSegment;

export interface ClusterResult {
  segments: RecordingSegment[];
  pickers: number;
  warnings: string[];
}

interface Found {
  cluster: PickerCluster;
  end: number;
}

export function clusterSteps(steps: ChromeRecorderStep[]): ClusterResult {
  const segments: RecordingSegment[] = [];
  const warnings: string[] = [];
  let pickers = 0;
  let i = 0;

  while (i < steps.length) {
    const found =
      readSemanticCluster(steps, i) ??
      readDialogCluster(steps, i) ??
      readStructuralCluster(steps, i);

    if (found) {
      segments.push(found.cluster);
      warnings.push(...found.cluster.warnings);
      pickers += 1;
      i = found.end;
      continue;
    }

    segments.push({ kind: "step", at: { step: steps[i]!, index: i } });
    i += 1;
  }

  return { segments, pickers, warnings };
}

/**
 * 有语义提示的组件：Select / Cascader / DatePicker / hover 菜单。
 * 触发器之后，同规则、面板展开期间的步骤都属于这个簇。
 */
function readSemanticCluster(steps: ChromeRecorderStep[], start: number): Found | null {
  const trigger = steps[start]!;
  const semantic = trigger.semantic;
  // 无规则组件：靠弹层生命周期起簇（Phase 3），成员由 overlayItem 标注。
  const overlayStart = semantic?.overlayOpen === true && !semantic.rule;
  if (!overlayStart) {
    if (!semantic || semantic.zone !== "trigger") return null;
    if (trigger.type !== "click" && trigger.type !== "hover") return null;
    if (!semantic.rule) return null;
  }

  const rule = overlayStart ? "overlay" : semantic!.rule!;
  const filters: ClusterStep[] = [];
  const picks: ClusterStep[] = [];
  const indices = [start];
  let commit: ClusterStep | undefined;
  let end = start + 1;

  for (let j = start + 1; j < steps.length; j += 1) {
    const step = steps[j]!;
    const next = step.semantic;
    if (step.type === "navigate") break;

    if (!next) {
      // 面板里的键盘确认（Enter / Tab）属于这个意图；其它无语义步骤到此为止。
      if (step.type === "keydown" && (step.key === "Enter" || step.key === "Tab")) {
        indices.push(j);
        end = j + 1;
        continue;
      }
      break;
    }

    if (next.zone === "trigger") {
      // 同一个触发器再点一次 = 第二次打开，新簇从这里开始。
      if (step.type === "click" && next.popupOpen === false) break;
      if (!overlayStart && next.rule !== rule) break;
      if (step.type === "change") {
        // 还没选过值时的面板内输入 = 搜索筛选；
        // 已经选过值后的触发器 change = 组件回写选中值，吸收掉（哪怕面板还没关）。
        if (next.popupOpen === true && picks.length === 0) filters.push({ step, index: j });
        indices.push(j);
        end = j + 1;
        continue;
      }
      break;
    }

    if (!overlayStart && next.rule !== rule) break;

    if (next.zone === "item" || next.zone === "row") {
      if (next.commit) {
        commit = { step, index: j };
        indices.push(j);
        end = j + 1;
        break;
      }
      // 行/选项里的勾选是点击的副作用（外部 JSON 也可能带进来），不能算第二次选择。
      if (step.type === "change") {
        indices.push(j);
        end = j + 1;
        continue;
      }
      // 级联把「再点一次同一个父项」当展开/无操作，不能再算一级路径；
      // 同一父项可重复点击，路径里同名但跨列（如 北京→北京）的 selectors 不同，不会误删。
      if (rule === "antd-cascader" && isSameCascaderItem(picks.at(-1)?.step, step)) {
        indices.push(j);
        end = j + 1;
        continue;
      }
      picks.push({ step, index: j });
      indices.push(j);
      end = j + 1;
      continue;
    }

    if (next.zone === "panel") {
      if (step.type === "change" || step.type === "click") {
        filters.push({ step, index: j });
        indices.push(j);
        end = j + 1;
        continue;
      }
    }

    break;
  }

  if (picks.length === 0) return null;

  // 点击展开的触发器上，鼠标移入会先记一次 hover；它不是打开动作。
  // 把紧挨着的同目标 hover 折进簇里，回放不再多一次无效悬停。
  const hoverPrecursor = hoverPrecursorIndex(steps, start);
  if (hoverPrecursor !== null) indices.unshift(hoverPrecursor);

  const detection: Detection = overlayStart ? "heuristic" : semantic!.detection ?? "class";
  const warnings: string[] = [];
  const needsConfirm = overlayStart || detection === "heuristic";
  if (overlayStart) warnings.push("无规则组件的弹层按 overlay 生命周期折叠，请确认选择项");
  else if (needsConfirm) warnings.push(`${rule} 的定位靠时序启发式，已标 needsConfirm`);

  return {
    cluster: {
      kind: "picker",
      rule,
      mode: semantic.panelRole === "dialog" ? "dialog" : "inline",
      detection,
      source: "semantic",
      trigger: { step: trigger, index: start },
      filters,
      picks,
      commit,
      indices,
      confidence: overlayStart ? 0.6 : detection === "aria" ? 0.9 : 0.85,
      needsConfirm,
      warnings,
    },
    end,
  };
}

/**
 * 紧挨在触发器点击之前的 hover 是否是同一目标。
 *
 * antd Dropdown 的 trigger 可配 hover 或 click：配 click 时鼠标移入仍会先触发 hover，
 * 但面板此时没开（popupOpen=false），真正的打开动作是随后的 click。
 * 只有「点击前面板未展开 + 同规则同目标」才折叠，避免误删 hover 展开的菜单。
 */
function hoverPrecursorIndex(steps: ChromeRecorderStep[], start: number): number | null {
  if (start === 0) return null;
  const hover = steps[start - 1];
  const trigger = steps[start];
  if (!hover || !trigger) return null;
  if (hover.type !== "hover" || trigger.type !== "click") return null;
  if (hover.semantic?.zone !== "trigger" || trigger.semantic?.zone !== "trigger") return null;
  if ((hover.semantic.rule ?? null) !== (trigger.semantic?.rule ?? null)) return null;
  if (trigger.semantic?.popupOpen !== false) return null;
  return sameTarget(hover, trigger) ? start - 1 : null;
}

/**
 * 弹窗选择器：开启按钮是业务按钮，录制不到语义，只能在它之后找弹窗交互。
 * 弹窗里的普通输入（无 semantic）也算成员；嵌套组件只当筛选，不当选择项。
 */
function readDialogCluster(steps: ChromeRecorderStep[], start: number): Found | null {
  const trigger = steps[start]!;
  if (trigger.type !== "click" || trigger.semantic) return null;

  const filters: ClusterStep[] = [];
  const picks: ClusterStep[] = [];
  const indices = [start];
  let commit: ClusterStep | undefined;
  let sawDialog = false;
  let end = start + 1;

  for (let j = start + 1; j < steps.length; j += 1) {
    const step = steps[j]!;
    if (step.type === "navigate") break;
    const next = step.semantic;
    if (next?.zone === "trigger") break;

    if (next?.rule === "antd-modal") {
      sawDialog = true;
      if (next.commit) {
        commit = { step, index: j };
        indices.push(j);
        end = j + 1;
        break;
      }
      if (next.zone === "item" || next.zone === "row") {
        // 勾选控件的 change 是点击副作用，不能算第二次选择。
        if (step.type !== "change") picks.push({ step, index: j });
        indices.push(j);
        end = j + 1;
        continue;
      }
      indices.push(j);
      end = j + 1;
      continue;
    }

    if (!sawDialog) {
      // 弹窗还没出现：先把无语义的输入/点击当作候选筛选步骤，
      // 真正出现弹窗交互后才保留这个簇，否则整簇作废。
      if (next?.zone === "item" || next?.zone === "row") return null;
      if (!next && (step.type === "change" || step.type === "click")) {
        filters.push({ step, index: j });
      }
      indices.push(j);
      end = j + 1;
      continue;
    }

    // 弹窗内：无语义输入（筛选）与嵌套组件都算筛选步骤。
    if (!next || step.type === "change" || step.type === "click") {
      if (!next || next.zone === "panel" || next.zone === "item" || next.zone === "row") {
        filters.push({ step, index: j });
        indices.push(j);
        end = j + 1;
        continue;
      }
    }
    break;
  }

  if (!sawDialog || picks.length === 0) return null;

  const warnings: string[] = [];
  if (!commit) warnings.push("弹窗选择器未识别到提交按钮，回放按弹窗消失判定");

  return {
    cluster: {
      kind: "picker",
      rule: "antd-modal",
      mode: "dialog",
      detection: "aria",
      source: "semantic",
      trigger: { step: trigger, index: start },
      filters,
      picks,
      commit,
      indices,
      confidence: commit ? 0.8 : 0.7,
      needsConfirm: !commit,
      warnings,
    },
    end,
  };
}

/**
 * 外部 Chrome Recorder JSON 的结构降级：click → 同目标 change → 若干带 text 的 click。
 * 没有语义时无法区分「点选项」和「点表格行」，所以一律 needsConfirm。
 */
function readStructuralCluster(steps: ChromeRecorderStep[], start: number): Found | null {
  const trigger = steps[start]!;
  if (trigger.type !== "click" || trigger.semantic) return null;

  const change = steps[start + 1];
  if (!change || change.type !== "change" || !sameTarget(trigger, change)) return null;

  const picks: ClusterStep[] = [];
  const indices = [start, start + 1];
  let end = start + 2;

  for (let j = start + 2; j < steps.length; j += 1) {
    const step = steps[j]!;
    if (step.type !== "click" || step.semantic || !hasTextSelector(step)) break;
    picks.push({ step, index: j });
    indices.push(j);
    end = j + 1;
  }

  if (picks.length === 0) return null;

  const warnings = ["缺少语义提示，已按结构折叠（click → change → 选项点击），请确认选择项是否正确"];
  return {
    cluster: {
      kind: "picker",
      rule: "structural",
      mode: "inline",
      detection: "heuristic",
      source: "structural",
      trigger: { step: trigger, index: start },
      filters: [{ step: change, index: start + 1 }],
      picks,
      indices,
      confidence: 0.5,
      needsConfirm: true,
      warnings,
    },
    end,
  };
}

function sameTarget(a: ChromeRecorderStep, b: ChromeRecorderStep): boolean {
  return JSON.stringify(a.selectors ?? []) === JSON.stringify(b.selectors ?? []);
}

function hasTextSelector(step: ChromeRecorderStep): boolean {
  return (step.selectors ?? []).some((group) =>
    group.some((selector) => selector.startsWith("text/") || selector.startsWith("text=")),
  );
}

/**
 * 级联的同一列条目是否就是上一次点击的那个条目。
 * 必须同时有列序号：没有列信息的外部 JSON 无法区分「重复点击」和「跨列同名值」，
 * 宁可保留也不误删。
 */
function isSameCascaderItem(
  previous: ChromeRecorderStep | undefined,
  current: ChromeRecorderStep,
): boolean {
  const before = previous?.semantic;
  const after = current.semantic;
  if (!before || !after || before.column === undefined || after.column === undefined) {
    return false;
  }
  return (
    before.column === after.column &&
    before.value === after.value &&
    before.index === after.index
  );
}

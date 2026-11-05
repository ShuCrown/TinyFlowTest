import type { Strategy, TargetRef } from "../dsl/index.ts";

/** 元素指纹：采集器与录制选择器共用的一套候选来源。 */
export interface ElementFingerprint {
  tag: string;
  type?: string;
  role?: string;
  name?: string;
  id?: string;
  testid?: string;
  placeholder?: string;
  ariaLabel?: string;
  labelText?: string;
  text?: string;
  value?: string;
  checked?: boolean;
  classes?: string[];
  css?: string;
  xpath?: string;
  bbox?: { x: number; y: number; width: number; height: number };
  frameUrl?: string;
}

/**
 * 指纹 → 有序候选链：
 * testid → role+name → label → placeholder → text → name → css → xpath。
 * 与 FlowTest/packages/recorder/src/collector.ts 保持一致。
 */
export function fingerprintToTarget(fp: ElementFingerprint): TargetRef {
  const strategies: Strategy[] = [];
  if (fp.testid) strategies.push({ type: "testid", value: fp.testid });
  const accessible = fp.ariaLabel || fp.labelText || fp.placeholder || fp.text;
  if (fp.role && accessible) {
    strategies.push({ type: "role", role: fp.role, name: accessible, exact: true });
  }
  if (fp.labelText) strategies.push({ type: "label", value: fp.labelText, exact: true });
  if (fp.placeholder) strategies.push({ type: "placeholder", value: fp.placeholder });
  if (fp.text && fp.text.length <= 60) {
    strategies.push({ type: "text", value: fp.text, exact: true });
  }
  if (fp.name) strategies.push({ type: "name", value: fp.name });
  if (fp.css) strategies.push({ type: "css", value: fp.css });
  if (fp.xpath) strategies.push({ type: "xpath", value: fp.xpath });
  if (strategies.length === 0) {
    strategies.push({ type: "css", value: fp.tag });
  }
  return {
    label: accessible || fp.name || fp.tag,
    strategies,
    fingerprint: {
      tag: fp.tag,
      role: fp.role,
      visibleText: fp.text,
      anchorText: fp.labelText,
      testid: fp.testid,
      name: fp.name,
      placeholder: fp.placeholder,
    },
    strict: true,
  };
}

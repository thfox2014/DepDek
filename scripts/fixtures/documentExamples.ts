import type { DocumentExamples } from "../../src/lib/documentScenes";

// Entirely fictional household documents. Never import this fixture into native UI.
export const documentExamples: DocumentExamples = {
  find: {
    answer: "说明书把滤网清洁分成三步：取出、冲洗、装回。清洁前先关闭电源；细节可以直接核对下面的原文。",
    source: {
      name: "洗碗机使用说明.pdf", path: "家电 / 厨房 / 使用说明", section: "日常清洁 · 滤网",
      heading: "滤网的日常清洁",
      paragraphs: [
        { text: "本页是虚构的说明书节选，仅用于产品原型。真实操作请查看对应设备的原厂说明书。" },
        { text: "清洁前，先关闭设备电源，待内部冷却。", relevant: true },
        { text: "1. 按照机身标识，轻轻旋转并取出滤网。\n2. 用清水冲洗滤网，去除残留物。\n3. 装回原位，确认滤网已经锁紧。", relevant: true },
        { text: "不同型号的拆装方式可能不同。不要将此示例当作你家设备的操作指南。" },
      ],
    },
  },
  organize: {
    title: "厨房改造",
    files: [
      { id: "quote-current", name: "厨房改造报价-修订版.pdf", group: "方案与报价", note: "含新增插座与台面调整", kind: "preferred" },
      { id: "quote-old", name: "厨房改造报价.pdf", group: "方案与报价", note: "初次报价，可回溯", kind: "original" },
      { id: "quote-copy", name: "厨房改造报价-副本.pdf", group: "方案与报价", note: "与初次报价内容相同，不自动删除", kind: "duplicate" },
      { id: "measurements", name: "橱柜尺寸.pdf", group: "测量与图纸", note: "与厨房改造关联", kind: "normal" },
      { id: "receipt", name: "家电发票.pdf", group: "购买凭证", note: "与厨房家电关联", kind: "normal" },
    ],
    versions: [
      { label: "初次报价 · 保留", name: "厨房改造报价.pdf", changes: ["台面：原方案", "插座：2 组", "预算：21,800 元（虚构）"] },
      { label: "修订版 · 建议当前使用", name: "厨房改造报价-修订版.pdf", changes: ["台面：调整为一体式", "插座：增加到 4 组", "预算：23,900 元（虚构）"] },
    ],
  },
  prepare: {
    title: "周末的露营，资料在手边。",
    subtitle: "不必挨个文件找。围绕这次出发，准备一份刚刚好的资料包。",
    items: [
      { id: "booking", title: "营地预订确认", source: "营地预订确认.pdf", detail: "示例预订：周六入住，周日离开。仅用于展示，不是真实订单。" },
      { id: "route", title: "路线与集合点", source: "路线与集合点.pdf", detail: "保留原始路线资料的引用；原型不会调用地图，也不会规划实际路线。" },
      { id: "equipment", title: "一家人的装备清单", source: "露营装备清单.md", detail: "示例清单含帐篷、睡袋、餐具与照明；可以按需要从资料包中移除。" },
      { id: "entry", title: "营地入场说明", detail: "当前示例资料里没有入场说明。正式版可继续查找，或添加营地发来的通知。" },
    ],
  },
};

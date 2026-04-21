# Canvas Handsontable Compatible Table

基于 Canvas 的表格组件，并提供 Handsontable 常见 API 兼容层，目标是在业务代码里尽量做到“低改动替换”。

## 安装与导入

```js
import Handsontable, { registerAllModules } from "canvas-handsontable-compat";
import "canvas-handsontable-compat/styles";

registerAllModules();
```

兼容常见导入路径：

```js
import { registerAllModules } from "canvas-handsontable-compat/registry";
import { BasePlugin } from "canvas-handsontable-compat/base";
```

## 快速开始

```js
const hot = new Handsontable(container, {
  data: [
    ["A1", "B1"],
    ["A2", "B2"],
  ],
  rowHeaders: true,
  colHeaders: true,
  width: "100%",
  height: 320,
});
```

## 目前已兼容的关键能力

- 实例化和基础配置：`data`、`columns`、`rowHeaders`、`colHeaders`、`width/height`、`colWidths/rowHeights`。
- 数据 API：
  - `getData` / `getDataAtCell` / `getDataAtRow` / `getDataAtCol` / `getDataAtRowProp`
  - `setDataAtCell` / `setDataAtRowProp` / `loadData` / `populateFromArray`
- 选择与编辑：
  - `selectCell` / `deselectCell` / `getSelectedLast` / `getSelectedRangeLast`
  - 键盘导航、双击编辑、`Enter/F2` 编辑、`Delete/Backspace` 清空
- 结构修改：
  - `alter("insert_row_*" | "remove_row" | "insert_col_*" | "remove_col")`
- Hook 系统：
  - `addHook` / `addHookOnce` / `removeHook` / `hasHook` / `runHooks`
  - 支持 settings 里同名 hook 回调
- 插件兼容入口：
  - `getPlugin("copyPaste")`
  - `getPlugin("undoRedo")`
- 元数据：
  - `getCellMeta` / `setCellMeta` / `removeCellMeta`

## 已知边界

这个版本是“兼容层 + Canvas 渲染核心”的可运行基线，不是 Handsontable 全量功能镜像。以下高级能力尚未完整实现：

- 全插件生态（filters、nestedHeaders、formulas、mergeCells 等）
- 复杂编辑器/验证器/renderer 生态细节
- 所有 Hook 的完整参数语义一致性
- 自动列宽、冻结、排序、移动列行等高级交互

如果你有现网代码，可按“真实 API 使用清单”继续补齐，我可以继续按优先级逐项对齐。

## 本地验证

```bash
npm test
npm run demo
# 打开 http://localhost:4173/demo/
```

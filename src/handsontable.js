import { DataModel } from "./data-model.js";

const DEFAULT_SETTINGS = {
  data: [],
  columns: undefined,
  width: "100%",
  height: 320,
  stretchH: "none",
  rowHeaders: true,
  colHeaders: true,
  rowHeaderWidth: 48,
  colHeaderHeight: 28,
  colWidths: 120,
  rowHeights: 24,
  viewportRowRenderingOffset: 6,
  viewportColumnRenderingOffset: 3,
  enterBeginsEditing: true,
  outsideClickDeselects: true,
  readOnly: false,
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const normalize2D = (value) => {
  if (!Array.isArray(value)) return [];
  if (value.length > 0 && !Array.isArray(value[0])) return [value];
  return value;
};

const toTSV = (grid) =>
  grid.map((row) => row.map((cell) => `${cell ?? ""}`).join("\t")).join("\n");

const fromTSV = (text) =>
  text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line, idx, all) => !(idx === all.length - 1 && line === ""))
    .map((line) => line.split("\t"));

class SelectionRange {
  constructor(fromRow, fromCol, toRow = fromRow, toCol = fromCol) {
    this.from = { row: fromRow, col: fromCol };
    this.to = { row: toRow, col: toCol };
  }

  get normalized() {
    return {
      r1: Math.min(this.from.row, this.to.row),
      c1: Math.min(this.from.col, this.to.col),
      r2: Math.max(this.from.row, this.to.row),
      c2: Math.max(this.from.col, this.to.col),
    };
  }

  toArray() {
    const { r1, c1, r2, c2 } = this.normalized;
    return [r1, c1, r2, c2];
  }
}

export class Handsontable {
  static editors = {
    TextEditor: class TextEditor {},
  };

  static renderers = {
    TextRenderer(instance, td, row, col, prop, value) {
      return `${value ?? ""}`;
    },
  };

  static plugins = {};

  static helper = {
    stringify(value) {
      return value == null ? "" : `${value}`;
    },
  };

  static hooks = {
    _global: new Map(),
    add(name, fn) {
      if (!this._global.has(name)) this._global.set(name, new Set());
      this._global.get(name).add(fn);
    },
    remove(name, fn) {
      this._global.get(name)?.delete(fn);
    },
    run(instance, name, ...args) {
      const handlers = this._global.get(name);
      if (!handlers) return undefined;
      let last;
      for (const handler of handlers) {
        last = handler.call(instance, ...args);
      }
      return last;
    },
  };

  constructor(container, settings = {}) {
    if (!container || typeof container.appendChild !== "function") {
      throw new Error("Handsontable requires a valid DOM container.");
    }

    this.rootElement = container;
    this.container = container;
    this.guid = `hot_${Math.random().toString(36).slice(2, 11)}`;
    this.isDestroyed = false;
    this.hooks = new Map();
    this.cellMeta = new Map();
    this.pluginsCache = new Map();
    this.undoStack = [];
    this.redoStack = [];
    this.selection = null;
    this.selectionAnchor = null;
    this.dragging = false;
    this.scrollLeft = 0;
    this.scrollTop = 0;
    this.editing = false;
    this.listeners = [];
    this._raf = null;

    this.updateSettings(settings, true);
    this._buildDom();
    this._bindEvents();
    this._applyContainerSize();
    this._syncGeometry();
    this._renderSoon();
    this._runHook("afterInit");
  }

  _buildDom() {
    this.rootElement.innerHTML = "";
    this.rootElement.classList.add("hot-canvas");
    if (!this.rootElement.style.position) this.rootElement.style.position = "relative";
    if (!this.rootElement.style.overflow) this.rootElement.style.overflow = "hidden";
    this.rootElement.tabIndex = this.rootElement.tabIndex >= 0 ? this.rootElement.tabIndex : 0;

    this.scrollHost = document.createElement("div");
    this.scrollHost.style.position = "absolute";
    this.scrollHost.style.inset = "0";
    this.scrollHost.style.overflow = "auto";

    this.spacer = document.createElement("div");
    this.spacer.style.width = "1px";
    this.spacer.style.height = "1px";
    this.scrollHost.appendChild(this.spacer);

    this.canvas = document.createElement("canvas");
    this.canvas.style.position = "absolute";
    this.canvas.style.inset = "0";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.outline = "none";
    this.canvas.tabIndex = -1;
    this.ctx = this.canvas.getContext("2d");

    this.editor = document.createElement("textarea");
    this.editor.style.position = "absolute";
    this.editor.style.display = "none";
    this.editor.style.zIndex = "2";
    this.editor.style.margin = "0";
    this.editor.style.padding = "2px 4px";
    this.editor.style.border = "2px solid #4c8bf5";
    this.editor.style.borderRadius = "0";
    this.editor.style.font = "12px sans-serif";
    this.editor.style.resize = "none";
    this.editor.style.boxSizing = "border-box";

    this.rootElement.appendChild(this.scrollHost);
    this.rootElement.appendChild(this.canvas);
    this.rootElement.appendChild(this.editor);
  }

  _bindEvents() {
    const on = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      this.listeners.push(() => target.removeEventListener(type, handler, options));
    };

    on(this.scrollHost, "scroll", () => {
      this.scrollLeft = this.scrollHost.scrollLeft;
      this.scrollTop = this.scrollHost.scrollTop;
      this._positionEditor();
      this._renderSoon();
      this._runHook("afterScrollVertically");
      this._runHook("afterScrollHorizontally");
    });

    on(this.canvas, "mousedown", (event) => this._onMouseDown(event));
    on(window, "mousemove", (event) => this._onMouseMove(event));
    on(window, "mouseup", () => {
      this.dragging = false;
      this._runHook("afterSelectionEnd", ...(this.getSelectedLast() ?? []));
    });
    on(this.canvas, "dblclick", () => this.beginEditing());
    on(this.rootElement, "keydown", (event) => this._onKeyDown(event));
    on(this.editor, "keydown", (event) => this._onEditorKeyDown(event));
    on(this.editor, "blur", () => this.finishEditing(true));

    on(document, "mousedown", (event) => {
      if (!this.settings.outsideClickDeselects) return;
      if (this.rootElement.contains(event.target)) return;
      this.deselectCell();
    });

    const resizeObserver = new ResizeObserver(() => {
      this._syncGeometry();
      this._renderSoon();
    });
    resizeObserver.observe(this.rootElement);
    this.listeners.push(() => resizeObserver.disconnect());
  }

  _runHook(name, ...args) {
    let result;
    const settingHook = this.settings[name];
    if (typeof settingHook === "function") {
      result = settingHook.apply(this, args);
    }
    const local = this.hooks.get(name);
    if (local) {
      for (const fn of local) {
        const hookResult = fn.apply(this, args);
        if (hookResult !== undefined) result = hookResult;
      }
    }
    const globalResult = Handsontable.hooks.run(this, name, ...args);
    if (globalResult !== undefined) result = globalResult;
    return result;
  }

  addHook(name, fn) {
    if (!this.hooks.has(name)) this.hooks.set(name, new Set());
    this.hooks.get(name).add(fn);
  }

  addHookOnce(name, fn) {
    const wrapper = (...args) => {
      this.removeHook(name, wrapper);
      return fn.apply(this, args);
    };
    this.addHook(name, wrapper);
  }

  removeHook(name, fn) {
    this.hooks.get(name)?.delete(fn);
  }

  hasHook(name) {
    if (typeof this.settings[name] === "function") return true;
    if (this.hooks.get(name)?.size) return true;
    if (Handsontable.hooks._global.get(name)?.size) return true;
    return false;
  }

  runHooks(name, ...args) {
    return this._runHook(name, ...args);
  }

  getSettings() {
    return this.settings;
  }

  updateSettings(nextSettings = {}, init = false) {
    this.settings = { ...DEFAULT_SETTINGS, ...this.settings, ...nextSettings };
    const hasData = Object.prototype.hasOwnProperty.call(nextSettings, "data");
    const hasColumns = Object.prototype.hasOwnProperty.call(nextSettings, "columns");
    if (!this.model || hasData || hasColumns || init) {
      this.model = new DataModel(this.settings.data ?? [], this.settings.columns);
    }

    if (!init) {
      this._applyContainerSize();
      this._syncGeometry();
      this._renderSoon();
    }
  }

  _applyContainerSize() {
    const { width, height } = this.settings;
    this.rootElement.style.width = typeof width === "number" ? `${width}px` : width;
    this.rootElement.style.height = typeof height === "number" ? `${height}px` : height;
  }

  _syncGeometry() {
    if (!this.canvas) return;
    const rect = this.rootElement.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    this.viewportWidth = Math.max(1, Math.floor(rect.width));
    this.viewportHeight = Math.max(1, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.viewportWidth * ratio);
    this.canvas.height = Math.floor(this.viewportHeight * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this._updateSpacer();
  }

  _updateSpacer() {
    const width = this._headerWidth() + this._sumCols();
    const height = this._headerHeight() + this._sumRows();
    this.spacer.style.width = `${Math.max(width, this.viewportWidth)}px`;
    this.spacer.style.height = `${Math.max(height, this.viewportHeight)}px`;
  }

  _headerWidth() {
    return this.settings.rowHeaders ? Number(this.settings.rowHeaderWidth) || 0 : 0;
  }

  _headerHeight() {
    return this.settings.colHeaders ? Number(this.settings.colHeaderHeight) || 0 : 0;
  }

  countRows() {
    return this.model.countRows();
  }

  countCols() {
    return this.model.countCols();
  }

  colToProp(col) {
    const def = this.model.columnDefs?.[col];
    if (def?.data !== undefined) return def.data;
    return col;
  }

  propToCol(prop) {
    const defs = this.model.columnDefs ?? [];
    const idx = defs.findIndex((def) => def.data === prop);
    return idx >= 0 ? idx : Number(prop);
  }

  getColWidth(col) {
    const cfg = this.settings.colWidths;
    if (typeof cfg === "function") return Number(cfg(col)) || 120;
    if (Array.isArray(cfg)) return Number(cfg[col]) || 120;
    if (cfg && typeof cfg === "object") return Number(cfg[col]) || 120;
    return Number(cfg) || 120;
  }

  getRowHeight(row) {
    const cfg = this.settings.rowHeights;
    if (typeof cfg === "function") return Number(cfg(row)) || 24;
    if (Array.isArray(cfg)) return Number(cfg[row]) || 24;
    if (cfg && typeof cfg === "object") return Number(cfg[row]) || 24;
    return Number(cfg) || 24;
  }

  _sumCols() {
    let total = 0;
    for (let col = 0; col < this.countCols(); col += 1) total += this.getColWidth(col);
    return total;
  }

  _sumRows() {
    let total = 0;
    for (let row = 0; row < this.countRows(); row += 1) total += this.getRowHeight(row);
    return total;
  }

  _getColStart(col) {
    let x = this._headerWidth();
    for (let c = 0; c < col; c += 1) x += this.getColWidth(c);
    return x;
  }

  _getRowStart(row) {
    let y = this._headerHeight();
    for (let r = 0; r < row; r += 1) y += this.getRowHeight(r);
    return y;
  }

  _cellRect(row, col) {
    const x = this._getColStart(col);
    const y = this._getRowStart(row);
    return {
      x,
      y,
      width: this.getColWidth(col),
      height: this.getRowHeight(row),
    };
  }

  _pickCell(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left + this.scrollLeft;
    const y = clientY - rect.top + this.scrollTop;
    const headerWidth = this._headerWidth();
    const headerHeight = this._headerHeight();
    if (x < headerWidth || y < headerHeight) return null;

    let col = -1;
    let colX = headerWidth;
    for (let c = 0; c < this.countCols(); c += 1) {
      colX += this.getColWidth(c);
      if (x < colX) {
        col = c;
        break;
      }
    }

    let row = -1;
    let rowY = headerHeight;
    for (let r = 0; r < this.countRows(); r += 1) {
      rowY += this.getRowHeight(r);
      if (y < rowY) {
        row = r;
        break;
      }
    }

    if (row < 0 || col < 0) return null;
    return { row, col };
  }

  _onMouseDown(event) {
    this.listen();
    this.finishEditing(true);
    const cell = this._pickCell(event.clientX, event.clientY);
    if (!cell) return;
    this.dragging = true;
    this.selectionAnchor = { ...cell };
    this.selectCell(cell.row, cell.col);
    event.preventDefault();
  }

  _onMouseMove(event) {
    if (!this.dragging || !this.selectionAnchor) return;
    const cell = this._pickCell(event.clientX, event.clientY);
    if (!cell) return;
    this.selectCell(this.selectionAnchor.row, this.selectionAnchor.col, cell.row, cell.col, false, false);
  }

  _onKeyDown(event) {
    if (this.editing) return;
    this._runHook("beforeKeyDown", event);
    if (event.defaultPrevented) return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      this.copySelectionToClipboard();
      event.preventDefault();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
      this.pasteFromClipboard();
      event.preventDefault();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      this.undo();
      event.preventDefault();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      this.redo();
      event.preventDefault();
      return;
    }

    const selected = this.getSelectedLast();
    if (!selected) return;
    let [r1, c1, r2, c2] = selected;
    const target = { row: r2, col: c2 };
    const shift = event.shiftKey;
    const maxRow = Math.max(0, this.countRows() - 1);
    const maxCol = Math.max(0, this.countCols() - 1);

    switch (event.key) {
      case "ArrowUp":
        target.row = clamp(target.row - 1, 0, maxRow);
        break;
      case "ArrowDown":
        target.row = clamp(target.row + 1, 0, maxRow);
        break;
      case "ArrowLeft":
        target.col = clamp(target.col - 1, 0, maxCol);
        break;
      case "ArrowRight":
        target.col = clamp(target.col + 1, 0, maxCol);
        break;
      case "Tab":
        target.col = clamp(target.col + (event.shiftKey ? -1 : 1), 0, maxCol);
        break;
      case "Enter":
        if (this.settings.enterBeginsEditing) {
          this.beginEditing();
          event.preventDefault();
          return;
        }
        target.row = clamp(target.row + (event.shiftKey ? -1 : 1), 0, maxRow);
        break;
      case "F2":
        this.beginEditing();
        event.preventDefault();
        return;
      case "Delete":
      case "Backspace":
        this._clearSelection();
        event.preventDefault();
        return;
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          this.beginEditing(event.key);
          event.preventDefault();
        }
        return;
    }

    if (shift) {
      this.selectCell(r1, c1, target.row, target.col);
    } else {
      this.selectCell(target.row, target.col);
    }
    event.preventDefault();
  }

  _onEditorKeyDown(event) {
    if (event.key === "Escape") {
      this.finishEditing(false);
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      this.finishEditing(true);
      event.preventDefault();
    }
  }

  _clearSelection() {
    const selected = this.getSelectedLast();
    if (!selected) return;
    const [r1, c1, r2, c2] = selected;
    const changes = [];
    for (let row = r1; row <= r2; row += 1) {
      for (let col = c1; col <= c2; col += 1) {
        const oldValue = this.getDataAtCell(row, col);
        if (oldValue == null || oldValue === "") continue;
        changes.push([row, this.colToProp(col), oldValue, null]);
      }
    }
    if (changes.length === 0) return;
    if (this._runHook("beforeChange", changes, "edit") === false) return;
    for (const [row, prop, _old, next] of changes) {
      this.model.setCell(row, this.propToCol(prop), next);
    }
    this._pushHistory(changes);
    this._runHook("afterChange", changes, "edit");
    this.render();
  }

  _visibleRows() {
    const fromOffset = Math.max(0, this.scrollTop - this._headerHeight());
    const toOffset = fromOffset + this.viewportHeight;
    let acc = 0;
    const rows = [];
    const extra = Number(this.settings.viewportRowRenderingOffset) || 0;
    for (let row = 0; row < this.countRows(); row += 1) {
      const height = this.getRowHeight(row);
      const rowStart = acc;
      const rowEnd = acc + height;
      if (rowEnd >= fromOffset - extra * height && rowStart <= toOffset + extra * height) {
        rows.push(row);
      }
      acc = rowEnd;
    }
    return rows;
  }

  _visibleCols() {
    const fromOffset = Math.max(0, this.scrollLeft - this._headerWidth());
    const toOffset = fromOffset + this.viewportWidth;
    let acc = 0;
    const cols = [];
    const extra = Number(this.settings.viewportColumnRenderingOffset) || 0;
    for (let col = 0; col < this.countCols(); col += 1) {
      const width = this.getColWidth(col);
      const colStart = acc;
      const colEnd = acc + width;
      if (colEnd >= fromOffset - extra * width && colStart <= toOffset + extra * width) {
        cols.push(col);
      }
      acc = colEnd;
    }
    return cols;
  }

  _renderSoon() {
    if (this._raf != null) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this.render();
    });
  }

  render() {
    if (this.isDestroyed) return;
    this._updateSpacer();

    const ctx = this.ctx;
    const vw = this.viewportWidth;
    const vh = this.viewportHeight;
    ctx.clearRect(0, 0, vw, vh);

    const headerW = this._headerWidth();
    const headerH = this._headerHeight();
    const offsetX = this.scrollLeft;
    const offsetY = this.scrollTop;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, vw, vh);

    const rows = this._visibleRows();
    const cols = this._visibleCols();

    if (this.settings.colHeaders) {
      ctx.fillStyle = "#f3f5f8";
      ctx.fillRect(0, 0, vw, headerH);
    }
    if (this.settings.rowHeaders) {
      ctx.fillStyle = "#f3f5f8";
      ctx.fillRect(0, 0, headerW, vh);
    }

    ctx.strokeStyle = "#d3d7df";
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (const col of cols) {
      const x = this._getColStart(col) - offsetX;
      const w = this.getColWidth(col);
      const drawX = Math.round(x) + 0.5;
      ctx.moveTo(drawX, 0);
      ctx.lineTo(drawX, vh);
      if (this.settings.colHeaders) {
        ctx.fillStyle = "#2f3847";
        ctx.font = "12px sans-serif";
        ctx.textBaseline = "middle";
        const label = this._columnHeaderLabel(col);
        ctx.fillText(label, x + 6, headerH / 2);
      }
      if (col === cols[cols.length - 1]) {
        const edge = Math.round(x + w) + 0.5;
        ctx.moveTo(edge, 0);
        ctx.lineTo(edge, vh);
      }
    }

    for (const row of rows) {
      const y = this._getRowStart(row) - offsetY;
      const h = this.getRowHeight(row);
      const drawY = Math.round(y) + 0.5;
      ctx.moveTo(0, drawY);
      ctx.lineTo(vw, drawY);
      if (this.settings.rowHeaders) {
        ctx.fillStyle = "#2f3847";
        ctx.font = "12px sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText(`${row + 1}`, 6, y + h / 2);
      }
      if (row === rows[rows.length - 1]) {
        const edge = Math.round(y + h) + 0.5;
        ctx.moveTo(0, edge);
        ctx.lineTo(vw, edge);
      }
    }
    ctx.stroke();

    const selected = this.selection?.normalized;

    for (const row of rows) {
      for (const col of cols) {
        const rect = this._cellRect(row, col);
        const x = rect.x - offsetX;
        const y = rect.y - offsetY;
        if (x + rect.width < headerW || y + rect.height < headerH) continue;
        if (x > vw || y > vh) continue;

        if (
          selected &&
          row >= selected.r1 &&
          row <= selected.r2 &&
          col >= selected.c1 &&
          col <= selected.c2
        ) {
          ctx.fillStyle = "rgba(76, 139, 245, 0.12)";
          ctx.fillRect(x + 1, y + 1, rect.width - 1, rect.height - 1);
        }

        const value = this.getDataAtCell(row, col);
        const display = this._displayValue(row, col, value);
        ctx.fillStyle = "#1c2533";
        ctx.font = "12px sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText(display, x + 6, y + rect.height / 2);
      }
    }

    if (selected) {
      const start = this._cellRect(selected.r1, selected.c1);
      const end = this._cellRect(selected.r2, selected.c2);
      const boxX = start.x - offsetX;
      const boxY = start.y - offsetY;
      const boxW = end.x + end.width - start.x;
      const boxH = end.y + end.height - start.y;
      ctx.strokeStyle = "#4c8bf5";
      ctx.lineWidth = 2;
      ctx.strokeRect(boxX + 1, boxY + 1, boxW - 2, boxH - 2);
    }

    this._positionEditor();
    this._runHook("afterRender", false);
  }

  _displayValue(row, col, value) {
    const meta = this.getCellMeta(row, col);
    if (typeof meta.renderer === "function") {
      return meta.renderer(this, null, row, col, this.colToProp(col), value) ?? "";
    }
    if (typeof this.settings.renderer === "function") {
      return this.settings.renderer(this, null, row, col, this.colToProp(col), value) ?? "";
    }
    return value == null ? "" : `${value}`;
  }

  _columnHeaderLabel(col) {
    const cfg = this.settings.colHeaders;
    if (Array.isArray(cfg)) return `${cfg[col] ?? ""}`;
    if (typeof cfg === "function") return `${cfg(col) ?? ""}`;
    if (!cfg) return "";

    let n = col;
    let label = "";
    do {
      label = String.fromCharCode(65 + (n % 26)) + label;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return label;
  }

  _positionEditor() {
    if (!this.editing || !this.selection) return;
    const { r2, c2 } = this.selection.normalized;
    const rect = this._cellRect(r2, c2);
    this.editor.style.left = `${rect.x - this.scrollLeft + 1}px`;
    this.editor.style.top = `${rect.y - this.scrollTop + 1}px`;
    this.editor.style.width = `${Math.max(20, rect.width - 2)}px`;
    this.editor.style.height = `${Math.max(20, rect.height - 2)}px`;
  }

  beginEditing(initialValue = null) {
    const selected = this.getSelectedLast();
    if (!selected) return;
    const [, , row, col] = selected;
    const meta = this.getCellMeta(row, col);
    if (meta.readOnly || this.settings.readOnly) return;
    this.editing = true;
    const value = initialValue == null ? this.getDataAtCell(row, col) : initialValue;
    this.editor.value = value == null ? "" : `${value}`;
    this.editor.style.display = "block";
    this._positionEditor();
    this.editor.focus();
    this.editor.select();
    this._runHook("afterBeginEditing", row, col);
  }

  finishEditing(save = true) {
    if (!this.editing) return;
    const selected = this.getSelectedLast();
    this.editing = false;
    this.editor.style.display = "none";
    if (!save || !selected) {
      this._runHook("afterFinishEditing", false);
      this.render();
      return;
    }
    const [, , row, col] = selected;
    this.setDataAtCell(row, col, this.editor.value, "edit");
    this._runHook("afterFinishEditing", true);
  }

  getData(...args) {
    return this.model.getData(...args);
  }

  getDataAtCell(row, col) {
    return this.model.getCell(row, col);
  }

  getDataAtRow(row) {
    return this.getData(row, 0, row, Math.max(0, this.countCols() - 1))[0] ?? [];
  }

  getDataAtCol(col) {
    const out = [];
    for (let row = 0; row < this.countRows(); row += 1) {
      out.push(this.getDataAtCell(row, col));
    }
    return out;
  }

  getDataAtRowProp(row, prop) {
    return this.getDataAtCell(row, this.propToCol(prop));
  }

  getSourceData() {
    return this.model.getSourceData();
  }

  getSourceDataAtRow(row) {
    return this.model.getSourceData()[row] ?? null;
  }

  loadData(data) {
    this.model.setData(data ?? []);
    this.selection = null;
    this._updateSpacer();
    this.render();
    this._runHook("afterLoadData", false);
  }

  setDataAtRowProp(row, prop, value, source = "edit") {
    this.setDataAtCell(row, this.propToCol(prop), value, source);
  }

  setDataAtCell(rowOrChanges, col, value, source = "edit") {
    const batch = Array.isArray(rowOrChanges)
      ? rowOrChanges.map((entry) => [entry[0], entry[1], entry[2]])
      : [[rowOrChanges, col, value]];
    const normalizedChanges = [];

    for (const [row, colLike, nextValue] of batch) {
      const numericCol = typeof colLike === "number" ? colLike : this.propToCol(colLike);
      const prop = this.colToProp(numericCol);
      const oldValue = this.getDataAtCell(row, numericCol);
      if (oldValue === nextValue) continue;
      normalizedChanges.push([row, prop, oldValue, nextValue]);
    }

    if (normalizedChanges.length === 0) return;
    if (this._runHook("beforeChange", normalizedChanges, source) === false) return;

    const appliedChanges = [];
    for (const [row, prop, oldValue, nextValue] of normalizedChanges) {
      const colIndex = this.propToCol(prop);
      const meta = this.getCellMeta(row, colIndex);
      if (meta.readOnly || this.settings.readOnly) continue;
      this.model.setCell(row, colIndex, nextValue);
      appliedChanges.push([row, prop, oldValue, nextValue]);
    }

    if (appliedChanges.length === 0) return;
    this._pushHistory(appliedChanges);
    this.render();
    this._runHook("afterChange", appliedChanges, source);
  }

  _pushHistory(changes) {
    this.undoStack.push(changes.map((c) => [...c]));
    this.redoStack = [];
  }

  undo() {
    const changes = this.undoStack.pop();
    if (!changes) return;
    for (const [row, prop, oldValue] of changes) {
      const col = this.propToCol(prop);
      this.model.setCell(row, col, oldValue);
    }
    this.redoStack.push(changes);
    this.render();
    this._runHook("afterChange", changes, "undo");
  }

  redo() {
    const changes = this.redoStack.pop();
    if (!changes) return;
    for (const [row, prop, _oldValue, newValue] of changes) {
      const col = this.propToCol(prop);
      this.model.setCell(row, col, newValue);
    }
    this.undoStack.push(changes);
    this.render();
    this._runHook("afterChange", changes, "redo");
  }

  populateFromArray(row, col, input, _endRow, _endCol, _source, source = "populateFromArray") {
    const matrix = normalize2D(input);
    const changes = [];
    matrix.forEach((line, rOffset) => {
      line.forEach((cell, cOffset) => {
        const r = row + rOffset;
        const c = col + cOffset;
        const prop = this.colToProp(c);
        const oldValue = this.getDataAtCell(r, c);
        changes.push([r, prop, oldValue, cell]);
      });
    });

    if (changes.length === 0) return;
    if (this._runHook("beforeChange", changes, source) === false) return;
    for (const [r, prop, _old, next] of changes) {
      this.model.setCell(r, this.propToCol(prop), next);
    }
    this._pushHistory(changes);
    this.render();
    this._runHook("afterChange", changes, source);
  }

  getCellMeta(row, col) {
    const key = `${row}:${col}`;
    const base = this.cellMeta.get(key) ?? {};
    const prop = this.colToProp(col);
    const generated =
      typeof this.settings.cells === "function"
        ? this.settings.cells.call(this, row, col, prop) ?? {}
        : {};
    return { ...generated, ...base };
  }

  setCellMeta(row, col, key, value) {
    const metaKey = `${row}:${col}`;
    const current = this.cellMeta.get(metaKey) ?? {};
    current[key] = value;
    this.cellMeta.set(metaKey, current);
  }

  removeCellMeta(row, col, key) {
    const metaKey = `${row}:${col}`;
    const current = this.cellMeta.get(metaKey);
    if (!current) return;
    delete current[key];
    this.cellMeta.set(metaKey, current);
  }

  getSelected() {
    return this.selection ? [this.selection.toArray()] : null;
  }

  getSelectedLast() {
    return this.selection?.toArray() ?? null;
  }

  getSelectedRangeLast() {
    return this.selection ?? null;
  }

  selectCell(row, col, endRow = row, endCol = col, scrollToCell = true, triggerHooks = true) {
    if (this.countRows() <= 0 || this.countCols() <= 0) return false;
    const safeRow = clamp(row, 0, this.countRows() - 1);
    const safeCol = clamp(col, 0, this.countCols() - 1);
    const safeEndRow = clamp(endRow, 0, this.countRows() - 1);
    const safeEndCol = clamp(endCol, 0, this.countCols() - 1);
    this.selection = new SelectionRange(safeRow, safeCol, safeEndRow, safeEndCol);
    if (scrollToCell) this.scrollViewportTo(safeEndRow, safeEndCol);
    this.render();
    if (triggerHooks) {
      this._runHook("afterSelection", safeRow, safeCol, safeEndRow, safeEndCol);
      this._runHook("afterSelectionEnd", safeRow, safeCol, safeEndRow, safeEndCol);
    }
    return true;
  }

  deselectCell() {
    this.selection = null;
    this.finishEditing(false);
    this.render();
    this._runHook("afterDeselect");
  }

  scrollViewportTo(row, col) {
    const rect = this._cellRect(row, col);
    const left = rect.x;
    const right = rect.x + rect.width;
    const top = rect.y;
    const bottom = rect.y + rect.height;

    if (left < this.scrollLeft) this.scrollHost.scrollLeft = left;
    if (right > this.scrollLeft + this.viewportWidth) {
      this.scrollHost.scrollLeft = right - this.viewportWidth;
    }
    if (top < this.scrollTop) this.scrollHost.scrollTop = top;
    if (bottom > this.scrollTop + this.viewportHeight) {
      this.scrollHost.scrollTop = bottom - this.viewportHeight;
    }
  }

  alter(action, index, amount = 1) {
    let hookName = null;
    switch (action) {
      case "insert_row":
      case "insert_row_above":
      case "insert_row_before":
        this.model.insertRows(index, amount);
        hookName = "afterCreateRow";
        break;
      case "insert_row_below":
      case "insert_row_after":
        this.model.insertRows(index + 1, amount);
        hookName = "afterCreateRow";
        break;
      case "remove_row":
        this.model.removeRows(index, amount);
        hookName = "afterRemoveRow";
        break;
      case "insert_col":
      case "insert_col_start":
      case "insert_col_before":
        this.model.insertCols(index, amount);
        hookName = "afterCreateCol";
        break;
      case "insert_col_end":
      case "insert_col_after":
        this.model.insertCols(index + 1, amount);
        hookName = "afterCreateCol";
        break;
      case "remove_col":
        this.model.removeCols(index, amount);
        hookName = "afterRemoveCol";
        break;
      default:
        return;
    }
    this._updateSpacer();
    this.render();
    if (hookName) this._runHook(hookName, index, amount, action);
  }

  getPlugin(name) {
    if (this.pluginsCache.has(name)) return this.pluginsCache.get(name);
    const plugin = this._createPlugin(name);
    this.pluginsCache.set(name, plugin);
    return plugin;
  }

  _createPlugin(name) {
    if (name === "copyPaste") {
      return {
        copy: () => this.copySelectionToClipboard(),
        paste: (data) => {
          const selected = this.getSelectedLast();
          if (!selected) return;
          const [row, col] = selected;
          this.populateFromArray(row, col, normalize2D(data));
        },
      };
    }
    if (name === "undoRedo") {
      return {
        undo: () => this.undo(),
        redo: () => this.redo(),
      };
    }
    return {
      isEnabled: () => false,
    };
  }

  async copySelectionToClipboard() {
    const selected = this.getSelectedLast();
    if (!selected) return;
    const [r1, c1, r2, c2] = selected;
    const grid = this.getData(r1, c1, r2, c2);
    const text = toTSV(grid);
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    }
  }

  async pasteFromClipboard() {
    if (!navigator.clipboard?.readText) return;
    const selected = this.getSelectedLast();
    if (!selected) return;
    const [row, col] = selected;
    const text = await navigator.clipboard.readText();
    const data = fromTSV(text);
    this.populateFromArray(row, col, data);
  }

  listen() {
    this.rootElement.focus();
  }

  isListening() {
    return document.activeElement === this.rootElement || this.rootElement.contains(document.activeElement);
  }

  unlisten() {
    this.rootElement.blur();
  }

  validateCells(callback) {
    if (typeof callback === "function") callback(true);
  }

  destroyEditor(revertOriginal = false) {
    this.finishEditing(!revertOriginal);
  }

  suspendRender() {}

  resumeRender() {
    this.render();
  }

  destroy() {
    if (this.isDestroyed) return;
    this.finishEditing(false);
    this.listeners.forEach((off) => off());
    this.listeners = [];
    this.rootElement.innerHTML = "";
    this.rootElement.classList.remove("hot-canvas");
    this.isDestroyed = true;
    this._runHook("afterDestroy");
  }
}


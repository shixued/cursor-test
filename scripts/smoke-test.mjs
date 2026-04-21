import assert from "node:assert/strict";
import Handsontable, { registerAllModules } from "../src/index.js";

registerAllModules();

class FakeClassList {
  constructor() {
    this._set = new Set();
  }
  add(name) {
    this._set.add(name);
  }
  remove(name) {
    this._set.delete(name);
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.style = {};
    this.children = [];
    this.innerHTML = "";
    this.tabIndex = -1;
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.scrollLeft = 0;
    this.scrollTop = 0;
    this.value = "";
    this.parent = null;
  }
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  contains(target) {
    if (target === this) return true;
    return this.children.some((child) => child.contains?.(target));
  }
  addEventListener(type, handler) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }
  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 640, height: 320 };
  }
  focus() {
    globalThis.document.activeElement = this;
  }
  blur() {
    if (globalThis.document.activeElement === this) {
      globalThis.document.activeElement = null;
    }
  }
  select() {}
}

const fakeCtx = {
  clearRect() {},
  setTransform() {},
  fillRect() {},
  beginPath() {},
  moveTo() {},
  lineTo() {},
  stroke() {},
  fillText() {},
  strokeRect() {},
};

class FakeCanvas extends FakeElement {
  constructor() {
    super("canvas");
    this.width = 0;
    this.height = 0;
  }
  getContext() {
    return fakeCtx;
  }
}

globalThis.window = {
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
};
Object.defineProperty(globalThis, "navigator", {
  value: {},
  configurable: true,
});
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = (cb) => {
  cb();
  return 1;
};
globalThis.cancelAnimationFrame = () => {};
globalThis.document = {
  activeElement: null,
  createElement(tag) {
    if (tag === "canvas") return new FakeCanvas();
    return new FakeElement(tag);
  },
  addEventListener() {},
  removeEventListener() {},
};

const container = new FakeElement("div");

const hot = new Handsontable(container, {
  data: [
    ["A1", "B1"],
    ["A2", "B2"],
  ],
  colHeaders: true,
});

assert.equal(hot.countRows(), 2);
assert.equal(hot.countCols(), 2);
assert.equal(hot.getDataAtCell(0, 1), "B1");

hot.setDataAtCell(1, 1, "UPDATED");
assert.equal(hot.getDataAtCell(1, 1), "UPDATED");
assert.equal(hot.getSourceDataAtCell(1, 1), "UPDATED");

hot.setDataAtCell([[0, 0, "BATCH-A", "batch"]]);
assert.equal(hot.getDataAtCell(0, 0), "BATCH-A");

hot.selectCell(0, 0, 1, 1);
assert.deepEqual(hot.getSelectedLast(), [0, 0, 1, 1]);

hot.populateFromArray(0, 0, [
  ["X", "Y"],
  ["M", "N"],
]);
assert.equal(hot.getDataAtCell(0, 0), "X");
assert.equal(hot.getDataAtCell(1, 1), "N");
assert.equal(hot.countEmptyRows(), 0);
assert.equal(hot.countEmptyCols(), 0);

hot.undo();
assert.equal(hot.getDataAtCell(0, 0), "BATCH-A");
hot.redo();
assert.equal(hot.getDataAtCell(0, 0), "X");

hot.alter("insert_row_below", 0, 1);
assert.equal(hot.countRows(), 3);
hot.alter("remove_row", 1, 1);
assert.equal(hot.countRows(), 2);
assert.deepEqual(hot.getColHeader(), ["A", "B"]);
assert.deepEqual(hot.getRowHeader(), ["1", "2"]);

assert.equal(hot.isUndoAvailable(), true);
hot.clearUndo();
assert.equal(hot.isUndoAvailable(), false);
assert.equal(hot.isRedoAvailable(), false);

hot.batch(() => {
  hot.setSourceDataAtCell(0, 0, "SRC");
  hot.setSourceDataAtRow(1, ["ROW", "VALUE"]);
});
assert.equal(hot.getSourceDataAtCell(0, 0), "SRC");
assert.equal(hot.getDataAtCell(1, 0), "ROW");
assert.equal(hot.getDataAtCell(1, 1), "VALUE");

hot.clear();
assert.equal(hot.isEmptyRow(0), true);
assert.equal(hot.isEmptyCol(0), true);

const objectHot = new Handsontable(new FakeElement("div"), {
  data: [{ name: "Alice", profile: { score: 7 } }],
  columns: [{ data: "name" }, { data: "profile.score" }],
});
assert.equal(objectHot.getDataAtCell(0, 1), 7);
objectHot.setSourceDataAtCell(0, "profile.score", 8);
assert.equal(objectHot.getSourceDataAtCell(0, "profile.score"), 8);
assert.equal(objectHot.getDataAtCell(0, 1), 8);
objectHot.destroy();

hot.destroy();
assert.equal(hot.isDestroyed, true);

console.log("Smoke test passed.");

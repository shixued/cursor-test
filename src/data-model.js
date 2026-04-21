const isPlainObject = (value) =>
  Object.prototype.toString.call(value) === "[object Object]";

const isEmptyValue = (value) => value == null || value === "";

const toPath = (prop) => {
  if (Array.isArray(prop)) return prop;
  if (typeof prop === "number") return [prop];
  if (typeof prop !== "string" || prop.trim() === "") return [prop];
  return prop.split(".");
};

const readAtPath = (target, prop) => {
  if (target == null) return null;
  const path = toPath(prop);
  let current = target;
  for (const key of path) {
    if (current == null) return null;
    current = current[key];
  }
  return current ?? null;
};

const writeAtPath = (target, prop, value) => {
  const path = toPath(prop);
  if (!path.length) return;
  let current = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (!isPlainObject(current[key])) {
      current[key] = {};
    }
    current = current[key];
  }
  current[path[path.length - 1]] = value;
};

const normalizeColumnDefs = (columns, sampleObject) => {
  if (!Array.isArray(columns) || columns.length === 0) {
    if (sampleObject && isPlainObject(sampleObject)) {
      return Object.keys(sampleObject).map((key) => ({
        data: key,
        read: (row) => readAtPath(row, key),
        write: (row, value) => writeAtPath(row, key, value),
      }));
    }
    return [];
  }

  return columns.map((column, index) => {
    if (typeof column === "function") {
      return {
        data: index,
        read: (row) => column(row),
        write: () => {},
      };
    }

    if (typeof column === "string" || typeof column === "number") {
      return {
        data: column,
        read: (row) => readAtPath(row, column),
        write: (row, value) => writeAtPath(row, column, value),
      };
    }

    if (isPlainObject(column)) {
      if (typeof column.data === "function") {
        return {
          data: index,
          read: (row) => column.data(row),
          write: () => {},
        };
      }
      const prop = column.data ?? index;
      return {
        data: prop,
        read: (row) => readAtPath(row, prop),
        write: (row, value) => writeAtPath(row, prop, value),
      };
    }

    return {
      data: index,
      read: (row) => row?.[index] ?? null,
      write: (row, value) => {
        row[index] = value;
      },
    };
  });
};

export class DataModel {
  constructor(data = [], columns) {
    this.columnsSetting = columns;
    this.setData(data);
  }

  setColumns(columns) {
    this.columnsSetting = columns;
    this._refreshColumnDefs();
  }

  setData(data = []) {
    this.sourceData = Array.isArray(data) ? data : [];
    this.objectMode =
      this.sourceData.length > 0 && !Array.isArray(this.sourceData[0]);
    this._refreshColumnDefs();
  }

  _refreshColumnDefs() {
    const sample = this.objectMode ? this.sourceData[0] : null;
    this.columnDefs = normalizeColumnDefs(this.columnsSetting, sample);
  }

  countRows() {
    return this.sourceData.length;
  }

  countCols() {
    if (this.objectMode) return this.columnDefs.length;
    const dataColCount = this.sourceData.reduce(
      (max, row) => Math.max(max, Array.isArray(row) ? row.length : 0),
      0
    );
    const columnsCount = Array.isArray(this.columnsSetting)
      ? this.columnsSetting.length
      : 0;
    return Math.max(dataColCount, columnsCount);
  }

  countEmptyRows(ending = true) {
    const cols = this.countCols();
    const isRowEmpty = (row) => {
      if (cols === 0) return true;
      for (let col = 0; col < cols; col += 1) {
        if (!isEmptyValue(this.getCell(row, col))) return false;
      }
      return true;
    };

    if (ending) {
      let total = 0;
      for (let row = this.countRows() - 1; row >= 0; row -= 1) {
        if (!isRowEmpty(row)) break;
        total += 1;
      }
      return total;
    }

    let total = 0;
    for (let row = 0; row < this.countRows(); row += 1) {
      if (isRowEmpty(row)) total += 1;
    }
    return total;
  }

  countEmptyCols(ending = true) {
    const rows = this.countRows();
    const cols = this.countCols();
    const isColEmpty = (col) => {
      if (rows === 0) return true;
      for (let row = 0; row < rows; row += 1) {
        if (!isEmptyValue(this.getCell(row, col))) return false;
      }
      return true;
    };

    if (ending) {
      let total = 0;
      for (let col = cols - 1; col >= 0; col -= 1) {
        if (!isColEmpty(col)) break;
        total += 1;
      }
      return total;
    }

    let total = 0;
    for (let col = 0; col < cols; col += 1) {
      if (isColEmpty(col)) total += 1;
    }
    return total;
  }

  ensureRow(row) {
    while (this.sourceData.length <= row) {
      this.sourceData.push(this.objectMode ? {} : []);
    }
  }

  getCell(row, col) {
    if (row < 0 || col < 0 || row >= this.countRows()) return null;
    const rowData = this.sourceData[row];
    if (this.objectMode) {
      const def = this.columnDefs[col];
      if (!def) return null;
      return def.read(rowData);
    }
    if (!Array.isArray(rowData)) return null;
    return rowData[col] ?? null;
  }

  setCell(row, col, value) {
    if (row < 0 || col < 0) return;
    this.ensureRow(row);
    const rowData = this.sourceData[row];
    if (this.objectMode) {
      const def = this.columnDefs[col];
      if (!def) return;
      def.write(rowData, value);
      return;
    }
    if (!Array.isArray(rowData)) {
      this.sourceData[row] = [];
    }
    this.sourceData[row][col] = value;
  }

  getSourceCell(row, propOrCol) {
    if (row < 0 || row >= this.countRows()) return null;
    const rowData = this.sourceData[row];
    if (this.objectMode) {
      const prop =
        typeof propOrCol === "number" ? this.columnDefs[propOrCol]?.data : propOrCol;
      if (prop == null) return null;
      return readAtPath(rowData, prop);
    }
    const col = typeof propOrCol === "number" ? propOrCol : Number(propOrCol);
    if (Number.isNaN(col) || col < 0) return null;
    return Array.isArray(rowData) ? rowData[col] ?? null : null;
  }

  setSourceCell(row, propOrCol, value) {
    if (row < 0) return;
    this.ensureRow(row);
    const rowData = this.sourceData[row];
    if (this.objectMode) {
      const prop =
        typeof propOrCol === "number" ? this.columnDefs[propOrCol]?.data : propOrCol;
      if (prop == null) return;
      writeAtPath(rowData, prop, value);
      return;
    }
    const col = typeof propOrCol === "number" ? propOrCol : Number(propOrCol);
    if (Number.isNaN(col) || col < 0) return;
    if (!Array.isArray(this.sourceData[row])) this.sourceData[row] = [];
    this.sourceData[row][col] = value;
  }

  setSourceRow(row, value) {
    if (row < 0) return;
    this.ensureRow(row);
    if (this.objectMode) {
      this.sourceData[row] = isPlainObject(value) ? { ...value } : {};
    } else {
      this.sourceData[row] = Array.isArray(value) ? [...value] : [];
    }
  }

  getData(r1 = 0, c1 = 0, r2 = this.countRows() - 1, c2 = this.countCols() - 1) {
    if (this.countRows() === 0 || this.countCols() === 0) return [];
    const startRow = Math.max(0, Math.min(r1, r2));
    const endRow = Math.min(this.countRows() - 1, Math.max(r1, r2));
    const startCol = Math.max(0, Math.min(c1, c2));
    const endCol = Math.min(this.countCols() - 1, Math.max(c1, c2));
    const output = [];
    for (let row = startRow; row <= endRow; row += 1) {
      const line = [];
      for (let col = startCol; col <= endCol; col += 1) {
        line.push(this.getCell(row, col));
      }
      output.push(line);
    }
    return output;
  }

  insertRows(index, amount = 1) {
    const insertAt = Math.max(0, Math.min(index, this.countRows()));
    const items = Array.from({ length: amount }, () => (this.objectMode ? {} : []));
    this.sourceData.splice(insertAt, 0, ...items);
  }

  removeRows(index, amount = 1) {
    if (index < 0 || index >= this.countRows()) return;
    this.sourceData.splice(index, amount);
  }

  insertCols(index, amount = 1) {
    if (this.objectMode) {
      const baseIndex = Math.max(0, Math.min(index, this.columnDefs.length));
      const generated = Array.from({ length: amount }, (_, i) => ({
        data: `col_${baseIndex + i}`,
      }));
      const current = Array.isArray(this.columnsSetting) ? [...this.columnsSetting] : [];
      current.splice(baseIndex, 0, ...generated);
      this.setColumns(current);
      return;
    }

    for (const row of this.sourceData) {
      if (!Array.isArray(row)) continue;
      row.splice(index, 0, ...Array.from({ length: amount }, () => null));
    }
  }

  removeCols(index, amount = 1) {
    if (this.objectMode) {
      if (!Array.isArray(this.columnsSetting)) return;
      const next = [...this.columnsSetting];
      next.splice(index, amount);
      this.setColumns(next);
      return;
    }

    for (const row of this.sourceData) {
      if (!Array.isArray(row)) continue;
      row.splice(index, amount);
    }
  }

  ensureShape(minRows = 0, minCols = 0) {
    const safeRows = Math.max(0, Number(minRows) || 0);
    const safeCols = Math.max(0, Number(minCols) || 0);

    if (this.countRows() < safeRows) {
      this.insertRows(this.countRows(), safeRows - this.countRows());
    }

    if (this.objectMode) {
      if (this.countCols() >= safeCols) return;
      const current = Array.isArray(this.columnsSetting) ? [...this.columnsSetting] : [];
      for (let col = current.length; col < safeCols; col += 1) {
        current.push({ data: `col_${col}` });
      }
      this.setColumns(current);
      return;
    }

    for (let row = 0; row < this.countRows(); row += 1) {
      if (!Array.isArray(this.sourceData[row])) this.sourceData[row] = [];
      while (this.sourceData[row].length < safeCols) {
        this.sourceData[row].push(null);
      }
    }
  }

  clear() {
    const rows = this.countRows();
    const cols = this.countCols();
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        this.setCell(row, col, null);
      }
    }
  }

  getSourceData() {
    return this.sourceData;
  }
}

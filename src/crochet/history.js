/**
 * Histórico de operações reversíveis. Cada operação é `{ label, apply(), revert() }`
 * e precisa deixar o grafo e a simulação no mesmo estado ao ser revertida.
 */
export class History {
  constructor({ limit = 500, onChange = () => {} } = {}) {
    this.limit = limit;
    this.onChange = onChange;
    this.done = [];
    this.undone = [];
  }

  get canUndo() {
    return this.done.length > 0;
  }

  get canRedo() {
    return this.undone.length > 0;
  }

  run(operation) {
    operation.apply();
    this.done.push(operation);
    if (this.done.length > this.limit) this.done.shift();
    this.undone = [];
    this.onChange(this);
  }

  undo() {
    const operation = this.done.pop();
    if (!operation) return null;
    operation.revert();
    this.undone.push(operation);
    this.onChange(this);
    return operation;
  }

  redo() {
    const operation = this.undone.pop();
    if (!operation) return null;
    operation.apply();
    this.done.push(operation);
    this.onChange(this);
    return operation;
  }

  clear() {
    this.done = [];
    this.undone = [];
    this.onChange(this);
  }
}

// Tipos de conexão entre elementos do trabalho.
export const EDGE = {
  // A laçada nova passou por dentro de uma laçada que estava na agulha e a fechou.
  CLOSES: 'fecha',
  // A laçada nova foi puxada através de uma laçada já existente no trabalho.
  THROUGH: 'atraves',
};

/**
 * Grafo do trabalho: nós são laçadas, arestas registram como cada uma foi formada
 * (sempre da laçada nova para a laçada atravessada).
 * É a fonte da verdade da estrutura; o desenho apenas a projeta.
 */
export class CrochetGraph {
  constructor() {
    this.nodes = new Map();
    this.edges = [];
    this.order = 0;
  }

  addNode(id, data = {}) {
    if (this.nodes.has(id)) throw new Error(`Laçada ${id} já existe no grafo`);
    const node = { id, order: this.order++, ...data };
    this.nodes.set(id, node);
    return node;
  }

  removeNode(id) {
    // Desfazer remove sempre o nó mais recente; assim a ordem de formação continua sem lacunas.
    if (this.nodes.get(id)?.order === this.order - 1) this.order--;
    this.nodes.delete(id);
    this.edges = this.edges.filter((e) => e.from !== id && e.to !== id);
  }

  connect(from, to, type) {
    if (!this.nodes.has(from) || !this.nodes.has(to)) {
      throw new Error(`Conexão inválida: ${from} → ${to}`);
    }
    const edge = { from, to, type };
    this.edges.push(edge);
    return edge;
  }

  disconnect(edge) {
    this.edges = this.edges.filter((e) => e !== edge);
  }

  edgesFrom(id, type) {
    return this.edges.filter((e) => e.from === id && (!type || e.type === type));
  }

  edgesTo(id, type) {
    return this.edges.filter((e) => e.to === id && (!type || e.type === type));
  }

  nodesInOrder() {
    return [...this.nodes.values()].sort((a, b) => a.order - b.order);
  }

  toJSON() {
    return { order: this.order, nodes: this.nodesInOrder(), edges: this.edges };
  }

  static fromJSON(data) {
    const graph = new CrochetGraph();
    for (const node of data.nodes) graph.nodes.set(node.id, { ...node });
    for (const edge of data.edges) graph.connect(edge.from, edge.to, edge.type);
    graph.order = data.order;
    return graph;
  }
}

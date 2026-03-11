import { loadJson, saveJson } from './store.js';

function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function norm(a) {
  return Math.sqrt(dot(a, a));
}

function cosineSim(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  return dot(a, b) / (na * nb);
}

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return Math.random().toString(16).slice(2) + '-' + Date.now().toString(16);
}

export class SemanticMemory {
  constructor({ dbFile }) {
    this.dbFile = dbFile;
    this.state = loadJson(dbFile, { items: [] });
  }

  save() {
    saveJson(this.dbFile, this.state);
  }

  listAll() {
    return [...(this.state.items || [])].map(x => ({ id: x.id, text: x.text, createdAtIso: x.createdAtIso, meta: x.meta }));
  }

  add({ text, embedding, meta = {} }) {
    const item = {
      id: newId(),
      text: String(text || '').trim(),
      createdAtIso: nowIso(),
      meta: meta && typeof meta === 'object' ? meta : {},
      embedding
    };
    this.state.items = this.state.items || [];
    this.state.items.push(item);
    this.save();
    return { id: item.id, text: item.text, createdAtIso: item.createdAtIso, meta: item.meta };
  }

  deleteById(id) {
    const items = this.state.items || [];
    const idx = items.findIndex(x => x.id === id);
    if (idx < 0) return null;
    const [removed] = items.splice(idx, 1);
    this.state.items = items;
    this.save();
    return { id: removed.id, text: removed.text, createdAtIso: removed.createdAtIso, meta: removed.meta };
  }

  search({ queryEmbedding, k = 5, minScore = 0.2 }) {
    const items = (this.state.items || []).filter(x => Array.isArray(x.embedding) && x.embedding.length);
    const scored = items
      .map(x => ({
        item: { id: x.id, text: x.text, createdAtIso: x.createdAtIso, meta: x.meta },
        score: cosineSim(queryEmbedding, x.embedding)
      }))
      .sort((a, b) => b.score - a.score);

    return scored.filter(x => x.score >= minScore).slice(0, k);
  }
}

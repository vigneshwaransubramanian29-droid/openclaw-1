import fs from "node:fs";
import path from "node:path";

const DEFAULT_STORE = { namespaces: {} };

function resolveTtlMs(ttl) {
  if (typeof ttl === "number" && Number.isFinite(ttl)) return Math.max(0, ttl);
  if (ttl === "short") return 6 * 60 * 60 * 1000;
  if (ttl === "long") return 30 * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function nowMs() {
  return Date.now();
}

export class WorkspaceStore {
  constructor(params = {}) {
    this.filePath = params.filePath || path.join(process.cwd(), ".workspace-store.json");
    this.maxEntries = params.maxEntries || 2000;
    this.data = this.#load();
  }

  #load() {
    try {
      if (!fs.existsSync(this.filePath)) return { ...DEFAULT_STORE };
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return { ...DEFAULT_STORE };
      if (!parsed.namespaces || typeof parsed.namespaces !== "object") {
        return { ...DEFAULT_STORE };
      }
      return parsed;
    } catch {
      return { ...DEFAULT_STORE };
    }
  }

  #save() {
    const folder = path.dirname(this.filePath);
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
  }

  #ensureNamespace(namespace) {
    if (!this.data.namespaces[namespace]) this.data.namespaces[namespace] = {};
    return this.data.namespaces[namespace];
  }

  evictExpired() {
    const now = nowMs();
    const namespaces = this.data.namespaces || {};
    for (const namespace of Object.keys(namespaces)) {
      const bucket = namespaces[namespace];
      for (const key of Object.keys(bucket)) {
        const item = bucket[key];
        if (item?.expiresAt && item.expiresAt < now) delete bucket[key];
      }
    }
    this.#save();
  }

  #evictIfOverCapacity() {
    const entries = [];
    for (const [namespace, bucket] of Object.entries(this.data.namespaces)) {
      for (const [key, item] of Object.entries(bucket)) {
        entries.push({
          namespace,
          key,
          updatedAt: item?.updatedAt || 0,
        });
      }
    }
    if (entries.length <= this.maxEntries) return;
    entries.sort((a, b) => a.updatedAt - b.updatedAt);
    const removeCount = entries.length - this.maxEntries;
    for (let i = 0; i < removeCount; i += 1) {
      const oldest = entries[i];
      delete this.data.namespaces[oldest.namespace][oldest.key];
    }
  }

  put(namespace, key, value, options = {}) {
    const bucket = this.#ensureNamespace(namespace);
    const ttlMs = resolveTtlMs(options.ttl);
    const timestamp = nowMs();
    bucket[key] = {
      value,
      tags: Array.isArray(options.tags) ? options.tags : [],
      taskId: options.taskId || null,
      createdAt: bucket[key]?.createdAt || timestamp,
      updatedAt: timestamp,
      expiresAt: timestamp + ttlMs,
    };
    this.#evictIfOverCapacity();
    this.#save();
    return bucket[key];
  }

  get(namespace, key) {
    const bucket = this.#ensureNamespace(namespace);
    const item = bucket[key];
    if (!item) return null;
    if (item.expiresAt && item.expiresAt < nowMs()) {
      delete bucket[key];
      this.#save();
      return null;
    }
    return item.value;
  }

  query(namespace, filters = {}) {
    const bucket = this.#ensureNamespace(namespace);
    const now = nowMs();
    const tagFilters = Array.isArray(filters.tags) ? filters.tags : [];
    const taskId = filters.taskId || null;
    const out = [];

    for (const [key, item] of Object.entries(bucket)) {
      if (item.expiresAt && item.expiresAt < now) continue;
      if (taskId && item.taskId !== taskId) continue;
      if (tagFilters.length > 0) {
        const itemTags = Array.isArray(item.tags) ? item.tags : [];
        if (!tagFilters.every((tag) => itemTags.includes(tag))) continue;
      }
      out.push({
        key,
        value: item.value,
        tags: item.tags || [],
        taskId: item.taskId,
        updatedAt: item.updatedAt,
      });
    }
    out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return out;
  }
}

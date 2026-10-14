// Test-only Firestore double. Enforces Firestore's read-before-write constraint.
import assert from "node:assert/strict";
import type { Firestore } from "firebase-admin/firestore";
import type { FirestoreRuleStore } from "../src/shared/rulestore.ts";
import { context } from "./approval-fixture.ts";
type Doc = Record<string, any>;
const clone = <T>(v: T): T => structuredClone(v);
const field = (o: Doc, key: string) => key.split(".").reduce((v, p) => v?.[p], o as any);
function patch(old: Doc, updates: Doc) { const next = clone(old); for (const [k, v] of Object.entries(updates)) { const path = k.split("."); let target = next; for (const part of path.slice(0, -1)) target = target[part] ??= {}; target[path.at(-1)!] = clone(v); } return next; }
class Ref {
  db: MemoryFirestore; collection: string; id: string;
  constructor(db: MemoryFirestore, collection: string, id: string) { this.db = db; this.collection = collection; this.id = id; }
  get key() { return `${this.collection}/${this.id}`; }
  async get() { return new Snapshot(this, this.db.docs.get(this.key)); }
  async update(updates: Doc) { assert.ok(this.db.docs.has(this.key)); this.db.docs.set(this.key, patch(this.db.docs.get(this.key)!, updates)); }
}
class Snapshot {
  ref: Ref; id: string; exists: boolean; value: Doc | undefined;
  constructor(ref: Ref, value: Doc | undefined) { this.ref = ref; this.id = ref.id; this.exists = value !== undefined; this.value = clone(value); }
  data() { return clone(this.value); }
}
class Query {
  db: MemoryFirestore; collection: string; filters: [string, unknown][] = []; maximum = Infinity; cursor: string | undefined;
  constructor(db: MemoryFirestore, collection: string) { this.db = db; this.collection = collection; }
  doc(id: string) { return new Ref(this.db, this.collection, id); }
  copy() { const q = new Query(this.db, this.collection); q.filters = [...this.filters]; q.maximum = this.maximum; q.cursor = this.cursor; return q; }
  where(key: string, op: string, value: unknown) { assert.equal(op, "=="); const q = this.copy(); q.filters.push([key, value]); return q; }
  orderBy(key: string) { assert.equal(key, "__name__"); return this.copy(); }
  limit(n: number) { const q = this.copy(); q.maximum = n; return q; }
  startAfter(cursor: string) { const q = this.copy(); q.cursor = cursor; return q; }
  async get() { const docs = [...this.db.docs.entries()].filter(([key, value]) => key.startsWith(`${this.collection}/`) && this.filters.every(([k, v]) => field(value, k) === v)).map(([key, value]) => new Snapshot(this.doc(key.split("/")[1]), value)).sort((a, b) => a.id.localeCompare(b.id)).filter((s) => !this.cursor || s.id > this.cursor).slice(0, this.maximum); return { docs, empty: !docs.length, size: docs.length }; }
}
export class MemoryFirestore {
  docs = new Map<string, Doc>(); failDispatch = false; dispatches = new Map<string, Doc>(); auditCount = 0;
  collection(name: string) { return new Query(this, name); }
  async getAll(...refs: Ref[]) { assert.ok(refs.length > 0, "native Firestore getAll requires at least one reference"); return Promise.all(refs.map((ref) => ref.get())); }
  put(table: string, value: Doc) { this.docs.set(`${table}/${value.id}`, clone(value)); }
  get(table: string, id: string): Doc { return this.docs.get(`${table}/${id}`)!; }
  async runTransaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
    const actions: (() => void)[] = [];
    const tx = { get: async (ref: Ref | Query) => { assert.equal(actions.length, 0, "read after write"); return ref.get(); },
      update: (ref: Ref, value: Doc) => actions.push(() => { assert.ok(this.docs.has(ref.key)); this.docs.set(ref.key, patch(this.docs.get(ref.key)!, value)); }),
      create: (ref: Ref, value: Doc) => actions.push(() => { assert.ok(!this.docs.has(ref.key)); this.docs.set(ref.key, clone(value)); }),
    };
    const result = await callback(tx); for (const action of actions) action(); return result;
  }
  asFirestore() { return this as unknown as Firestore; }
  asStore() { return { appendAuditLog: async (ctx: Doc, entry: Doc, tx: any) => { const id = `audit-${++this.auditCount}`; tx.create(this.collection("audit_logs").doc(id), { ...entry, id, ownerWorkspaceId: ctx.workspaceId }); },
    createAnalysisJob: async (_ctx: Doc, job: Doc) => { if (this.failDispatch) throw new Error("simulated dispatch failure"); this.dispatches.set(job.idempotencyKey, clone(job)); },
  } as unknown as FirestoreRuleStore; }
}
export function database() {
  const db = new MemoryFirestore(), c = context();
  db.put("workspaces", c.workspace); db.put("projects", c.project!); db.put("rules", c.rule); db.put("rule_versions", c.proposal); db.put("rule_versions", c.currentVersion!);
  for (const e of c.evidence) db.put("evidence", e); for (const f of c.findings) db.put("drift_findings", f); for (const r of c.repositories) db.put("repositories", r);
  return db;
}

/** Test-only Firestore double, not an alternate RuleStore implementation.
 * It models document get/create/update/delete, query filters, and Firestore's
 * optimistic transaction retry behavior so IMPL-002 tests need no emulator. */
import type { DocumentData, DocumentReferenceLike, DocumentSnapshotLike, FirestoreLike, QueryDirection, QueryLike, QueryOperator, TransactionLike } from "../src/shared/rulestore.ts";

type Stored = { data: DocumentData; version: number };
const key = (collection: string, id: string) => `${collection}/${id}`;
const clone = <T>(value: T): T => structuredClone(value);
class Snapshot implements DocumentSnapshotLike { readonly id: string; private value?: Stored; constructor(id: string, value?: Stored) { this.id = id; this.value = value; } get exists() { return this.value !== undefined; } data() { return this.value && clone(this.value.data); } }
class Ref implements DocumentReferenceLike { private readonly db: InMemoryFirestore; readonly collectionName: string; readonly id: string; constructor(db: InMemoryFirestore, collectionName: string, id: string) { this.db = db; this.collectionName = collectionName; this.id = id; } get() { return Promise.resolve(this.db.snapshot(this.collectionName, this.id)); } }
class Query implements QueryLike {
  private filters: [string, QueryOperator, unknown][] = [];
  private ordering?: { field: string; direction: QueryDirection };
  private maximum?: number;
  private cursor?: unknown;
  private readonly db: InMemoryFirestore; readonly collectionName: string;
  constructor(db: InMemoryFirestore, collectionName: string) { this.db = db; this.collectionName = collectionName; }
  where(field: string, op: QueryOperator, value: unknown): QueryLike { this.filters.push([field, op, value]); return this; }
  orderBy(field: string, direction: QueryDirection = "asc"): QueryLike { this.ordering = { field, direction }; return this; }
  limit(value: number): QueryLike { this.maximum = value; return this; }
  startAfter(value: unknown): QueryLike { this.cursor = value; return this; }
  async get() {
    const fieldValue = (snapshot: DocumentSnapshotLike, field: string): unknown => field === "__name__" ? snapshot.id : field.split(".").reduce<unknown>((value, part) => value && typeof value === "object" ? (value as DocumentData)[part] : undefined, snapshot.data());
    let docs = this.db.query(this.collectionName, []).filter((snapshot) => this.filters.every(([field, op, value]) => op === "array-contains" ? Array.isArray(fieldValue(snapshot, field)) && (fieldValue(snapshot, field) as unknown[]).includes(value) : fieldValue(snapshot, field) === value));
    if (this.ordering) {
      const { field, direction } = this.ordering, sign = direction === "desc" ? -1 : 1;
      const compare = (left: DocumentSnapshotLike, right: DocumentSnapshotLike) => sign * (String(fieldValue(left, field) ?? "").localeCompare(String(fieldValue(right, field) ?? "")) || left.id.localeCompare(right.id));
      docs.sort(compare);
      if (this.cursor !== undefined) {
        const cursor = this.cursor;
        if (cursor && typeof cursor === "object" && "data" in cursor) docs = docs.filter((snapshot) => compare(snapshot, cursor as DocumentSnapshotLike) > 0);
        else docs = docs.filter((snapshot) => direction === "desc" ? String(fieldValue(snapshot, field) ?? "") < String(cursor) : String(fieldValue(snapshot, field) ?? "") > String(cursor));
      }
    }
    if (this.maximum !== undefined) docs = docs.slice(0, this.maximum);
    return { docs };
  }
}
type Write = { type: "create" | "update" | "delete"; ref: Ref; data?: DocumentData };
class Transaction implements TransactionLike {
  private reads = new Map<string, number>(); private writes: Write[] = []; private hasWrites = false;
  private readonly db: InMemoryFirestore; private readonly enforceReadBeforeWrite: boolean;
  constructor(db: InMemoryFirestore, enforceReadBeforeWrite: boolean) { this.db = db; this.enforceReadBeforeWrite = enforceReadBeforeWrite; }
  async get(ref: DocumentReferenceLike): Promise<DocumentSnapshotLike> { if (this.enforceReadBeforeWrite && this.hasWrites) throw new Error("Firestore transactions require all reads to be executed before all writes."); const internal = ref as Ref; const stored = this.db.getStored(internal.collectionName, internal.id); this.reads.set(key(internal.collectionName, internal.id), stored?.version ?? -1); return new Snapshot(internal.id, stored); }
  /** Tracks every returned document like a transactional query. The double does
   * not model Firestore's predicate/phantom lock; project-delete race tests pair
   * queries with the required parent-document write fence and assert the retry. */
  async getQuery(query: QueryLike): Promise<{ docs: DocumentSnapshotLike[] }> { if (this.enforceReadBeforeWrite && this.hasWrites) throw new Error("Firestore transactions require all reads to be executed before all writes."); const internal = query as Query, result = await internal.get(); for (const snapshot of result.docs) this.reads.set(key(internal.collectionName, snapshot.id), this.db.getStored(internal.collectionName, snapshot.id)?.version ?? -1); return result; }
  create(ref: DocumentReferenceLike, data: DocumentData) { this.hasWrites = true; this.writes.push({ type: "create", ref: ref as Ref, data: clone(data) }); }
  update(ref: DocumentReferenceLike, data: DocumentData) { this.hasWrites = true; this.writes.push({ type: "update", ref: ref as Ref, data: clone(data) }); }
  delete(ref: DocumentReferenceLike) { this.hasWrites = true; this.writes.push({ type: "delete", ref: ref as Ref }); }
  commit(): boolean { for (const [path, version] of this.reads) if ((this.db.version(path) ?? -1) !== version) return false; for (const write of this.writes) { const path = key(write.ref.collectionName, write.ref.id); const existing = this.db.getStored(write.ref.collectionName, write.ref.id); if (write.type === "create") { if (existing) return false; this.db.put(path, write.data!); } else if (write.type === "update") { if (!existing) throw new Error("update missing document"); this.db.put(path, { ...existing.data, ...write.data! }); } else this.db.remove(path); } return true; }
}
export class InMemoryFirestore implements FirestoreLike {
  private records = new Map<string, Stored>();
  readonly queryCounts = new Map<string, number>();
  readonly getAllBatches: string[][] = [];
  getAllCalls = 0;
  private readonly enforceReadBeforeWrite: boolean;
  constructor(options: { enforceReadBeforeWrite?: boolean } = {}) { this.enforceReadBeforeWrite = options.enforceReadBeforeWrite ?? false; }
  collection(name: string) { return { doc: (id: string) => new Ref(this, name, id), where: (field: string, op: QueryOperator, value: unknown) => new Query(this, name).where(field, op, value) }; }
  async getAll(...refs: DocumentReferenceLike[]) { this.getAllCalls += 1; this.getAllBatches.push(refs.map((ref) => { const internal = ref as Ref; return `${internal.collectionName}/${internal.id}`; })); return refs.map((ref) => { const internal = ref as Ref; return this.snapshot(internal.collectionName, internal.id); }); }
  snapshot(collection: string, id: string) { return new Snapshot(id, this.getStored(collection, id)); }
  getStored(collection: string, id: string) { const value = this.records.get(key(collection, id)); return value && { data: clone(value.data), version: value.version }; }
  version(path: string) { return this.records.get(path)?.version; }
  put(path: string, data: DocumentData) { this.records.set(path, { data: clone(data), version: (this.records.get(path)?.version ?? 0) + 1 }); }
  remove(path: string) { this.records.delete(path); }
  query(collection: string, filters: [string, unknown][]) { this.queryCounts.set(collection, (this.queryCounts.get(collection) ?? 0) + 1); return [...this.records.entries()].filter(([path, stored]) => path.startsWith(`${collection}/`) && filters.every(([field, value]) => stored.data[field] === value)).map(([path, stored]) => new Snapshot(path.slice(collection.length + 1), { data: clone(stored.data), version: stored.version })); }
  async runTransaction<T>(fn: (transaction: TransactionLike) => Promise<T>): Promise<T> { for (let attempt = 0; attempt < 8; attempt += 1) { const tx = new Transaction(this, this.enforceReadBeforeWrite); const result = await fn(tx); if (tx.commit()) return result; } throw new Error("transaction conflict retry limit exceeded"); }
}

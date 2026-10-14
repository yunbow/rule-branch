"""Test-only Firestore double; it is not a SQLite/Postgres RuleStore alternative.
It simulates the minimal Firestore optimistic transaction semantics needed by tests.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Callable, TypeVar

T = TypeVar("T")

@dataclass
class Snapshot:
    id: str
    value: dict[str, Any] | None
    @property
    def exists(self) -> bool: return self.value is not None
    def to_dict(self) -> dict[str, Any] | None: return deepcopy(self.value)

class Reference:
    def __init__(self, db: InMemoryFirestore, collection: str, id: str) -> None: self.db, self.collection_name, self.id = db, collection, id
    def get(self, **_: Any) -> Snapshot: return self.db.snapshot(self.collection_name, self.id)

class Query:
    def __init__(self, db: InMemoryFirestore, collection: str) -> None: self.db, self.collection_name, self.filters, self.limit_value = db, collection, [], None
    def where(self, field: str, _op: str, value: Any) -> Query: self.filters.append((field, value)); return self
    def limit(self, value: int) -> Query: self.limit_value = value; return self
    def stream(self) -> list[Snapshot]:
        self.db.query_calls[self.collection_name] = self.db.query_calls.get(self.collection_name, 0) + 1
        values = self.db.query(self.collection_name, self.filters)
        return values[:self.limit_value] if self.limit_value is not None else values

class Collection:
    def __init__(self, db: InMemoryFirestore, name: str) -> None: self.db, self.name = db, name
    def document(self, id: str) -> Reference: return Reference(self.db, self.name, id)
    def where(self, field: str, op: str, value: Any) -> Query: return Query(self.db, self.name).where(field, op, value)

class Transaction:
    def __init__(self, db: InMemoryFirestore) -> None: self.db, self.reads, self.query_reads, self.writes = db, {}, [], []
    def get(self, ref: Reference | Query) -> Snapshot | list[Snapshot]:
        if isinstance(ref, Query):
            values = ref.stream()
            signature = [(value.id, self.db.get(ref.collection_name, value.id)[1]) for value in values]
            self.query_reads.append((ref.collection_name, list(ref.filters), ref.limit_value, signature))
            return values
        value, version = self.db.get(ref.collection_name, ref.id); self.reads[(ref.collection_name, ref.id)] = version; return Snapshot(ref.id, value)
    def create(self, ref: Reference, data: dict[str, Any]) -> None: self.writes.append(("create", ref, deepcopy(data)))
    def update(self, ref: Reference, data: dict[str, Any]) -> None: self.writes.append(("update", ref, deepcopy(data)))
    def delete(self, ref: Reference) -> None: self.writes.append(("delete", ref, None))
    def commit(self) -> bool:
        if any(self.db.get(collection, id)[1] != version for (collection, id), version in self.reads.items()): return False
        for collection, filters, limit, signature in self.query_reads:
            values = self.db.query(collection, filters)
            if limit is not None: values = values[:limit]
            if [(value.id, self.db.get(collection, value.id)[1]) for value in values] != signature: return False
        for action, ref, data in self.writes:
            current, _ = self.db.get(ref.collection_name, ref.id)
            if action == "create":
                if current is not None: return False
                self.db.put(ref.collection_name, ref.id, data)
            elif action == "update":
                if current is None: raise RuntimeError("update missing document")
                current.update(data); self.db.put(ref.collection_name, ref.id, current)
            else: self.db.delete(ref.collection_name, ref.id)
        return True

class InMemoryFirestore:
    def __init__(self) -> None:
        self.records: dict[tuple[str, str], tuple[dict[str, Any], int]] = {}
        self.get_all_calls = 0
        self.query_calls: dict[str, int] = {}
    def collection(self, name: str) -> Collection: return Collection(self, name)
    def transaction(self) -> Transaction: return Transaction(self)
    def snapshot(self, collection: str, id: str) -> Snapshot: return Snapshot(id, self.get(collection, id)[0])
    def get_all(self, refs: list[Reference]) -> list[Snapshot]:
        self.get_all_calls += 1
        return [self.snapshot(ref.collection_name, ref.id) for ref in refs]
    def get(self, collection: str, id: str) -> tuple[dict[str, Any] | None, int]:
        result = self.records.get((collection, id)); return (deepcopy(result[0]), result[1]) if result else (None, -1)
    def put(self, collection: str, id: str, data: dict[str, Any]) -> None:
        self.records[(collection, id)] = (deepcopy(data), self.records.get((collection, id), ({}, 0))[1] + 1)
    def delete(self, collection: str, id: str) -> None: self.records.pop((collection, id), None)
    def query(self, collection: str, filters: list[tuple[str, Any]]) -> list[Snapshot]:
        return [Snapshot(id, data) for (name, id), (data, _) in self.records.items() if name == collection and all(data.get(field) == value for field, value in filters)]
    def run_transaction(self, function: Callable[[Transaction], T]) -> T:
        for _ in range(8):
            tx = Transaction(self); result = function(tx)
            if tx.commit(): return result
        raise RuntimeError("transaction conflict retry limit exceeded")

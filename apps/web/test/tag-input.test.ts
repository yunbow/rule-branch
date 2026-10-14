import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addTagValue, isTagCommitKey, removeTagValue, resolveTagAddition } from "../src/lib/tag-input.ts";

test("shared tag input normalizes, deduplicates, and enforces its limit", () => {
  const first = addTagValue([], "  React    Query  ", { maxItems: 2 });
  assert.deepEqual(first, ["React Query"]);
  assert.strictEqual(addTagValue(first, "react query", { maxItems: 2 }), first);
  assert.deepEqual(addTagValue(first, "react query", { maxItems: 2, caseSensitive: true }), ["React Query", "react query"]);
  assert.strictEqual(addTagValue(first, "TypeScript", { maxItems: 1 }), first);
  assert.strictEqual(addTagValue(first, "   ", { maxItems: 2 }), first);
});

test("shared tag removal returns the remaining values and leaves missing values untouched", () => {
  const current = ["TypeScript", "React"];
  assert.deepEqual(removeTagValue(current, "TypeScript"), ["React"]);
  assert.strictEqual(removeTagValue(current, "Vue"), current);
});

test("tag addition distinguishes duplicates from a rejected addition at the limit", () => {
  const current = ["React"];
  assert.deepEqual(resolveTagAddition(current, "react", { maxItems: 1 }), {
    value: current, outcome: "duplicate",
  });
  assert.deepEqual(resolveTagAddition(current, "Vue", { maxItems: 1 }), {
    value: current, outcome: "limit",
  });
  assert.deepEqual(resolveTagAddition(current, " ", { maxItems: 1 }), {
    value: current, outcome: "empty",
  });
  assert.deepEqual(resolveTagAddition([], " Vue ", { maxItems: 1 }), {
    value: ["Vue"], outcome: "added",
  });
});

test("tag commit keys remain configurable and IME composition never commits", () => {
  assert.equal(isTagCommitKey("Enter", false, ["Enter"]), true);
  assert.equal(isTagCommitKey(",", false, ["Enter"]), false);
  assert.equal(isTagCommitKey(",", false, ["Enter", ","]), true);
  assert.equal(isTagCommitKey("Enter", true, ["Enter", ","]), false);
});

test("project metadata tags use the shared inline TagInput behavior", () => {
  const source = readFileSync(new URL("../src/components/domain/ProjectCreateForm.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /function ProjectTags/);
  assert.equal(source.match(/<TagInput label=/g)?.length, 3);
  assert.equal(source.match(/variant="inline"/g)?.length, 3);
  assert.equal(source.match(/placeholder="入力してEnterで追加"/g)?.length, 3);
  assert.equal(source.match(/commitKeys=\{\["Enter", ","\]\}/g)?.length, 3);
  assert.equal(source.match(/commitOnBlur/g)?.length, 3);
  assert.equal(source.match(/inputMaxLength=\{100\}/g)?.length, 3);
  assert.equal(source.match(/maxItems=\{20\}/g)?.length, 2);
  assert.equal(source.match(/maxItems=\{10\}/g)?.length, 1);
});

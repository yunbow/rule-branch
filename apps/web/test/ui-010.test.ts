import assert from "node:assert/strict";
import test from "node:test";
import { hasComparison, lineDiff } from "../src/lib/diff.ts";
import { isApproveRejectValid } from "../src/lib/approve-reject.ts";
test("UI-010 line LCS diff handles added, removed, unchanged, empty, and initial versions",()=>{assert.deepEqual(lineDiff("a\nb","a\nc"),[{type:"unchanged",text:"a"},{type:"removed",text:"b"},{type:"added",text:"c"}]);assert.deepEqual(lineDiff("","a"),[{type:"added",text:"a"}]);assert.deepEqual(lineDiff("a",""),[{type:"removed",text:"a"}]);assert.deepEqual(lineDiff("a","a"),[{type:"unchanged",text:"a"}]);assert.equal(hasComparison(null),false);assert.equal(hasComparison("version-1"),true);});
test("UI-010 reject dialog requires a reason while approve comment is optional",()=>{assert.equal(isApproveRejectValid("approve",""),true);assert.equal(isApproveRejectValid("reject","   "),false);assert.equal(isApproveRejectValid("reject","理由"),true);});

import assert from "node:assert/strict";
import test from "node:test";
import { checksRequired, isValidRuleKey, utf8ByteLength } from "../src/lib/rule-form.ts";
test("UI-007 rule key uses the RuleStore pattern",()=>{assert.equal(isValidRuleKey("valid.rule-1"),true);assert.equal(isValidRuleKey("Uppercase"),false);assert.equal(isValidRuleKey("-start"),false);assert.equal(isValidRuleKey("a".repeat(101)),false);});
test("UI-007 deterministic rules require checks",()=>{assert.equal(checksRequired("deterministic",[]),true);assert.equal(checksRequired("deterministic",[{}]),false);assert.equal(checksRequired("semantic",[]),false);});
test("UI-007 UTF-8 byte counters include Japanese",()=>{assert.equal(utf8ByteLength("abc"),3);assert.equal(utf8ByteLength("日本語"),9);});

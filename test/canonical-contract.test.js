import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { canonicalize, receiptDigest } from "../src/threads/receipt.js";

// The canonical form under an artifact receipt is not private to this project:
// laicode implements the same encoding in Python, and the two agree byte for
// byte. gator-tools/contracts/canonical-json freezes that agreement so it
// cannot decay into a coincidence, and this test is this project's half of it.
//
// Skipped rather than failed when the submodule is absent, because README
// promises a clone without --recurse-submodules still works, and a test that
// breaks that promise would be a worse bug than the drift it guards against.
const VECTOR = new URL("../gator-tools/contracts/canonical-json/vector.json", import.meta.url);
const present = existsSync(VECTOR);

test("receipt canonicalization reproduces the frozen canonical-json vector", { skip: present ? false : "gator-tools submodule not checked out: git submodule update --init" }, () => {
  const vector = JSON.parse(readFileSync(VECTOR, "utf8"));
  assert.equal(vector.contract, "canonical-json");
  assert.ok(vector.cases.length >= 13, "the vector should not have shrunk");

  for (const testCase of vector.cases) {
    assert.equal(canonicalize(testCase.value), testCase.canonical, `canonical form for ${testCase.name}`);
    assert.equal(`sha256:${receiptDigest(testCase.value)}`, testCase.content_id, `content id for ${testCase.name}`);
  }
});

test("a receipt still refuses what has no canonical form", () => {
  // Rule 6 of the contract, which the vector cannot express: every case in it
  // must encode, so the values that must be refused have to be asserted here.
  assert.throws(() => canonicalize(Number.NaN), TypeError);
  assert.throws(() => canonicalize(Number.POSITIVE_INFINITY), TypeError);
  assert.throws(() => canonicalize(undefined), TypeError);
  assert.throws(() => canonicalize(new Date()), TypeError);
});

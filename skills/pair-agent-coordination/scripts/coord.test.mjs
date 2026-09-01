import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = join(dirname(fileURLToPath(import.meta.url)), "coord.mjs");

function git(repository, ...args) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

function coord(repository, args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, COORD_DIR: "" },
  });
  assert.equal(result.status, expectedStatus, `coord ${args.join(" ")}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

function repository() {
  const path = mkdtempSync(join(tmpdir(), "pair-coord-"));
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Coord Test");
  git(path, "config", "user.email", "coord@example.invalid");
  mkdirSync(join(path, "src"));
  writeFileSync(join(path, "README.md"), "# Fixture\n");
  writeFileSync(join(path, "src", "shared.js"), "export const shared = true;\n");
  git(path, "add", ".");
  git(path, "commit", "-m", "initial");
  return path;
}

test("pins readiness and review to a clean, scoped commit", () => {
  const repo = repository();
  try {
    coord(repo, ["init", "--agents", "alpha,beta", "--base", "main", "--shared", "README.md"]);
    git(repo, "switch", "-c", "feat/task-one");
    coord(repo, ["claim", "TASK-1", "--agent", "alpha", "--branch", "feat/task-one", "--files", "src/task.js,README.md"]);

    writeFileSync(join(repo, "src", "task.js"), "export const task = 1;\n");
    assert.match(coord(repo, ["check", "TASK-1", "--agent", "alpha"]), /1 changed file/);
    assert.match(coord(repo, ["ready", "TASK-1", "--agent", "alpha", "--evidence", "scope check and tests pass"], 1), /Commit all work/);

    writeFileSync(join(repo, "outside.js"), "export const outside = true;\n");
    assert.match(coord(repo, ["check", "TASK-1", "--agent", "alpha"], 1), /UNDECLARED outside\.js/);
    rmSync(join(repo, "outside.js"));
    git(repo, "add", "src/task.js");
    git(repo, "commit", "-m", "add task");

    coord(repo, ["ready", "TASK-1", "--agent", "alpha", "--evidence", "scope check and tests pass"]);
    const head = git(repo, "rev-parse", "HEAD");
    coord(repo, ["review", "TASK-1", "--agent", "beta", "--verdict", "changes", "--evidence", "Reviewed exact diff; clarify the fixture evidence"]);
    coord(repo, ["ready", "TASK-1", "--agent", "alpha", "--evidence", "clarified evidence; scope and tests still pass"]);
    assert.match(coord(repo, ["gate", "TASK-1", "--agent", "alpha"], 1), /lacks peer approval/);
    assert.match(coord(repo, ["review", "TASK-1", "--agent", "beta", "--verdict", "approve", "--evidence", "Reviewed exact diff and passing test evidence"]), new RegExp(head.slice(0, 12)));
    assert.match(coord(repo, ["gate", "TASK-1", "--agent", "alpha"]), /GATE PASS/);

    git(repo, "switch", "main");
    git(repo, "merge", "--ff-only", "feat/task-one");
    coord(repo, ["done", "TASK-1", "--agent", "alpha", "--note", "merged into main after approval"]);
    assert.match(coord(repo, ["status"]), /TASK-1\s+done/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("blocks overlapping claims and invalidates a stale ready commit", () => {
  const repo = repository();
  try {
    coord(repo, ["init", "--agents", "alpha,beta", "--base", "main", "--shared", "src/shared.js"]);
    git(repo, "switch", "-c", "feat/alpha");
    coord(repo, ["claim", "A", "--agent", "alpha", "--branch", "feat/alpha", "--files", "src/alpha"]);
    git(repo, "branch", "feat/beta", "main");
    assert.match(coord(repo, ["claim", "B", "--agent", "beta", "--branch", "feat/beta", "--files", "src/alpha/file.js"], 1), /overlaps src\/alpha/);
    assert.match(coord(repo, ["claim", "B", "--agent", "beta", "--branch", "feat/beta", "--files", "src"], 1), /contains a configured shared path/);

    writeFileSync(join(repo, "src", "alpha"), "first\n");
    git(repo, "add", "src/alpha");
    git(repo, "commit", "-m", "first ready commit");
    coord(repo, ["ready", "A", "--agent", "alpha", "--evidence", "scope check and tests pass"]);
    writeFileSync(join(repo, "src", "alpha"), "second\n");
    git(repo, "add", "src/alpha");
    git(repo, "commit", "-m", "change after readiness");
    assert.match(coord(repo, ["review", "A", "--agent", "beta", "--verdict", "approve", "--evidence", "Reviewed exact diff and passing test evidence"], 1), /Review exact ready commit/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("blocks on design questions and records handoff context", () => {
  const repo = repository();
  try {
    coord(repo, ["init", "--agents", "alpha,beta", "--base", "main"]);
    git(repo, "switch", "-c", "feat/question");
    coord(repo, ["claim", "Q1", "--agent", "alpha", "--branch", "feat/question", "--files", "src/question.js"]);
    coord(repo, ["ask", "Q1", "--agent", "alpha", "--to", "beta", "--question", "Should the result be stored or derived?"]);
    assert.match(coord(repo, ["ready", "Q1", "--agent", "alpha", "--evidence", "scope check and tests pass"], 1), /open question/);
    assert.match(coord(repo, ["withdraw", "Q1", "--agent", "alpha", "--reason", "The existing contract already decides the question"]), /history preserved/);
    assert.match(coord(repo, ["read", "--agent", "beta"]), /QUESTION WITHDRAWN on Q1/);
    coord(repo, ["ask", "Q1", "--agent", "alpha", "--to", "beta", "--question", "Should the result still be derived?"]);
    coord(repo, ["answer", "Q1", "--agent", "beta", "--text", "Derive it because the source record is authoritative"]);
    coord(repo, ["handoff", "Q1", "--agent", "alpha", "--to", "beta", "--note", "No code committed; decision recorded; implementation and tests remain"]);
    assert.match(coord(repo, ["status"]), /Q1\s+claimed\s+beta/);
    assert.match(coord(repo, ["read", "--agent", "beta"]), /HANDOFF of Q1/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("requires an explicit, logged human authority for forced completion", () => {
  const repo = repository();
  try {
    assert.match(coord(repo, ["init", "--agents", "alpha,beta", "--base", "main", "--queue", "README.md"]), /queue README\.md/);
    git(repo, "switch", "-c", "feat/override");
    coord(repo, ["claim", "OVERRIDE", "--agent", "alpha", "--branch", "feat/override", "--files", "src/override.js"]);
    writeFileSync(join(repo, "src", "override.js"), "export const override = true;\n");
    git(repo, "add", "src/override.js");
    git(repo, "commit", "-m", "add override fixture");
    git(repo, "switch", "main");
    git(repo, "merge", "--ff-only", "feat/override");

    assert.match(coord(repo, ["done", "OVERRIDE", "--agent", "alpha", "--note", "merged under explicit exception", "--force", "--reason", "reviewer is unavailable by human decision"], 1), /--authority human/);
    assert.match(coord(repo, ["done", "OVERRIDE", "--agent", "alpha", "--note", "merged under explicit exception", "--force", "--authority", "human", "--reason", "reviewer is unavailable by human decision"]), /logged human override/);
    assert.match(coord(repo, ["log", "--limit", "1"]), /forced-done/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("requires explicit human authority to recover a coordination lock", () => {
  const repo = repository();
  try {
    coord(repo, ["init", "--agents", "alpha,beta", "--base", "main"]);
    const lock = join(repo, ".git", "pair-agent-coordination", "mutation.lock");
    writeFileSync(lock, JSON.stringify({ pid: 999999, at: "fixture" }));
    assert.match(coord(repo, ["unlock", "--reason", "verified fixture process is not active"], 1), /--authority human/);
    assert.match(coord(repo, ["unlock", "--authority", "human", "--reason", "verified fixture process is not active"]), /logged human override/);
    assert.match(coord(repo, ["log", "--limit", "1"]), /forced-unlock/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

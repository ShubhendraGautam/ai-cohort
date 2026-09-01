#!/usr/bin/env node

// Dependency-free, repository-local coordination for a pair of coding agents.
// Run this file with the target Git repository as the current working directory.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

class CliError extends Error {}

function fail(message) {
  throw new CliError(message);
}

function runGit(cwd, args, { optional = false } = {}) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (optional) return null;
    const detail = error.stderr?.toString().trim();
    fail(detail || `git ${args.join(" ")} failed`);
  }
}

const invocationDirectory = process.cwd();
const root = runGit(invocationDirectory, ["rev-parse", "--show-toplevel"]);
const commonGitDirectory = runGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
const stateDirectory = process.env.COORD_DIR ? resolve(process.env.COORD_DIR) : join(commonGitDirectory, "pair-agent-coordination");
const boardDirectory = join(stateDirectory, "board");
const inboxDirectory = join(stateDirectory, "inbox");
const configPath = join(stateDirectory, "config.json");
const logPath = join(stateDirectory, "log.jsonl");
const lockPath = join(stateDirectory, "mutation.lock");

for (const directory of [stateDirectory, boardDirectory, inboxDirectory]) mkdirSync(directory, { recursive: true });

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const name = value.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else {
      flags[name] = next;
      index += 1;
    }
  }
  return { positional, flags };
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withMutationLock(operation) {
  let handle;
  let lockInode;
  let staleLooking = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      handle = openSync(lockPath, "wx");
      writeFileSync(handle, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      lockInode = fstatSync(handle).ino;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 60_000) staleLooking = true;
      } catch (staleError) {
        if (staleError.code !== "ENOENT") throw staleError;
      }
      sleep(25);
    }
  }
  if (handle === undefined) {
    const recovery = staleLooking ? " It is older than 60 seconds; verify no process is active, then use the human-authorized unlock command." : "";
    fail(`Coordination state stayed locked for 5 seconds.${recovery}`);
  }
  try {
    return operation();
  } finally {
    closeSync(handle);
    try {
      if (statSync(lockPath).ino === lockInode) unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function now() {
  return new Date().toISOString();
}

function logEvent(event) {
  appendFileSync(logPath, `${JSON.stringify({ at: now(), ...event })}\n`);
}

function validateId(id) {
  if (!id || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) fail("Task id must be 1-64 letters, digits, dots, underscores, or dashes");
  return id;
}

function validateAgentName(agent) {
  if (!agent || !/^[a-z0-9-]{1,32}$/.test(agent)) fail("Agent name must be 1-32 lowercase letters, digits, or dashes");
  return agent;
}

function normalizeProjectPath(input) {
  if (!input || isAbsolute(input)) fail(`Path must be relative to the repository: ${input || "<empty>"}`);
  const normalized = relative(root, resolve(root, input)).replaceAll("\\", "/");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    fail(`Path must stay inside the repository: ${input}`);
  }
  return normalized;
}

function commaList(value, mapper = (item) => item) {
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean).map(mapper);
}

function loadConfig() {
  if (!existsSync(configPath)) {
    fail("Coordination is not initialized. Run: coord.mjs init --agents agent-a,agent-b --base main [--shared paths]");
  }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (config.version !== 1 || !Array.isArray(config.agents) || config.agents.length !== 2) {
    fail(`Unsupported or invalid coordination config at ${configPath}`);
  }
  return config;
}

function requireConfiguredAgent(config, agent) {
  validateAgentName(agent);
  if (!config.agents.includes(agent)) fail(`${agent} is not configured; expected ${config.agents.join(" or ")}`);
}

function claimPath(id) {
  return join(boardDirectory, `${validateId(id)}.json`);
}

function loadClaim(id) {
  const path = claimPath(id);
  if (!existsSync(path)) fail(`${id} has no claim`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveClaim(id, claim) {
  writeAtomically(claimPath(id), `${JSON.stringify(claim, null, 2)}\n`);
}

function writeAtomically(path, content) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, content);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
}

function readClaims() {
  return readdirSync(boardDirectory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ id: name.slice(0, -5), ...JSON.parse(readFileSync(join(boardDirectory, name), "utf8")) }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function pathCovered(path, declarations) {
  return declarations.some((declaration) => path === declaration || path.startsWith(`${declaration}/`));
}

function findOverlap(files, claims, exceptId = null) {
  for (const claim of claims) {
    if (claim.id === exceptId || !["claimed", "ready"].includes(claim.state)) continue;
    for (const file of files) {
      for (const declared of claim.files || []) {
        if (pathsOverlap(file, declared)) return { file, declared, claim };
      }
    }
  }
  return null;
}

function inboxPath(agent) {
  return join(inboxDirectory, `${validateAgentName(agent)}.jsonl`);
}

function cursorPath(agent) {
  return join(inboxDirectory, `${validateAgentName(agent)}.cursor`);
}

function appendMessage(message) {
  appendFileSync(inboxPath(message.to), `${JSON.stringify({ at: now(), ...message })}\n`);
}

function pendingMessages(agent) {
  const path = inboxPath(agent);
  if (!existsSync(path)) return 0;
  const count = readFileSync(path, "utf8").split("\n").filter(Boolean).length;
  const cursor = existsSync(cursorPath(agent)) ? Number(readFileSync(cursorPath(agent), "utf8")) || 0 : 0;
  return Math.max(0, count - cursor);
}

function readMessages(agent, { all = false } = {}) {
  const path = inboxPath(agent);
  if (!existsSync(path)) return [];
  const messages = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const cursor = all || !existsSync(cursorPath(agent)) ? 0 : Number(readFileSync(cursorPath(agent), "utf8")) || 0;
  writeFileSync(cursorPath(agent), String(messages.length));
  return messages.slice(cursor);
}

function showMessages(messages) {
  for (const message of messages) {
    console.log(`[${message.at}] ${message.from} -> ${message.to}${message.re ? ` re ${message.re}` : ""}: ${message.text}`);
  }
}

function gitLines(args) {
  const output = runGit(root, args);
  return output ? output.split("\n").filter(Boolean) : [];
}

function changedPaths(base) {
  return [...new Set([
    ...gitLines(["diff", "--name-only", `${base}...HEAD`]),
    ...gitLines(["diff", "--name-only"]),
    ...gitLines(["diff", "--cached", "--name-only"]),
    ...gitLines(["ls-files", "--others", "--exclude-standard"]),
  ])].sort();
}

function scopeResult(config, agent, claimId = null) {
  const changed = changedPaths(config.base);
  const live = readClaims().filter((claim) => ["claimed", "ready"].includes(claim.state));
  const owned = live.filter((claim) => claim.agent === agent);
  if (!claimId && owned.length > 1) fail(`Agent ${agent} has multiple live claims; pass the task id to check`);
  const selected = claimId ? owned.filter((claim) => claim.id === claimId) : owned;
  if (!selected.length) fail(`${agent} has no matching live claim`);
  const mine = selected.flatMap((claim) => claim.files || []);
  const selectedIds = new Set(selected.map((claim) => claim.id));
  const others = live.filter((claim) => !selectedIds.has(claim.id));
  const trespass = [];
  const undeclared = [];

  for (const path of changed) {
    if (pathCovered(path, config.shared || []) || pathCovered(path, mine)) continue;
    const owner = others.find((claim) => pathCovered(path, claim.files || []));
    if (owner) trespass.push({ path, owner });
    else undeclared.push(path);
  }
  return { changed, trespass, undeclared };
}

function printScope(result) {
  for (const item of result.trespass) console.log(`TRESPASS ${item.path} — ${item.owner.agent} declared it for ${item.owner.id}`);
  for (const path of result.undeclared) console.log(`UNDECLARED ${path} — amend the claim before continuing`);
  if (!result.trespass.length && !result.undeclared.length) {
    console.log(`${result.changed.length} changed file${result.changed.length === 1 ? "" : "s"}, all declared or shared (committed + staged + unstaged + untracked)`);
  }
}

function requireOwner(claim, agent) {
  if (claim.agent !== agent) fail(`${claim.id || "Item"} is held by ${claim.agent}, not ${agent}`);
}

function requireActive(claim, id) {
  if (!["claimed", "ready"].includes(claim.state)) fail(`${id} is ${claim.state}, not active`);
}

function approvalForReady(claim) {
  if (!claim.ready) return null;
  return [...(claim.reviews || [])].reverse().find((review) =>
    review.verdict === "approve"
      && review.agent !== claim.agent
      && review.head === claim.ready.head
      && review.readyId === claim.ready.id,
  );
}

function currentBranch() {
  return runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { optional: true });
}

function workingTreeClean() {
  return runGit(root, ["status", "--porcelain"]) === "";
}

function branchHead(branch) {
  return runGit(root, ["rev-parse", `refs/heads/${branch}`], { optional: true });
}

function requireEvidence(value, minimum = 15) {
  const evidence = String(value || "").trim();
  if (evidence.length < minimum) fail("Provide concrete evidence naming a file, line, invariant, test, or command result");
  return evidence;
}

function usage() {
  console.log(`Pair-agent coordination (run from the target Git repository)

  init --agents A,B --base main [--queue path] [--shared path,path]
  status
  claim <id> --agent A --branch B --files path,path
  amend <id> --agent A --files path,path
  check [id] --agent A
  ask <id> --agent A --to B --question "..."
  answer <id> --agent B --text "..."
  withdraw <id> --agent A --reason "question is resolved or superseded"
  ready <id> --agent A --evidence "checks run and results"
  review <id> --agent B --verdict approve|changes --evidence "..."
  gate <id> --agent A
  handoff <id> --agent A --to B --note "commit, state, remaining work, risks"
  release <id> --agent A [--force --authority human --reason "explicit override"]
  done <id> --agent A --note "merged into base"
       [--force --authority human --reason "explicit override"]
  unlock --authority human --reason "verified stale lock"
  send --from A --to B [--re id] --text "..."
  read --agent A [--all] [--wait] [--timeout seconds]
  log [--limit count]

State defaults to the common Git directory. Set COORD_DIR only when both agents
can see the same durable replacement directory.

Trust model: --agent identities are self-asserted. This tool prevents accidents
and records an audit trail; it does not authenticate agents or resist a process
that can edit the repository's local Git metadata.`);
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command = "help", target] = positional;

function main() {
  if (["help", "--help", "-h"].includes(command)) {
    usage();
    return;
  }

  if (command === "unlock") {
    if (flags.authority !== "human") fail("Lock recovery requires --authority human and explicit human authorization");
    const reason = requireEvidence(flags.reason, 30);
    if (!existsSync(lockPath)) fail("No mutation.lock exists");
    const previous = readFileSync(lockPath, "utf8");
    unlinkSync(lockPath);
    logEvent({ event: "forced-unlock", authority: "human", reason, previous });
    console.log("Removed mutation.lock with a logged human override");
    return;
  }

  if (command === "init") {
    const agents = commaList(flags.agents, validateAgentName);
    if (agents.length !== 2 || new Set(agents).size !== 2) fail("init requires exactly two distinct agents: --agents agent-a,agent-b");
    const base = String(flags.base || "").trim();
    if (!base || !runGit(root, ["rev-parse", "--verify", `refs/heads/${base}`], { optional: true })) {
      fail(`Base must name an existing local branch: ${base || "<empty>"}`);
    }
    const shared = [...new Set(commaList(flags.shared, normalizeProjectPath))].sort();
    const queue = flags.queue ? normalizeProjectPath(String(flags.queue)) : null;
    if (queue && !existsSync(join(root, queue))) fail(`Configured queue does not exist: ${queue}`);
    withMutationLock(() => {
      if (existsSync(configPath)) fail(`Already initialized at ${configPath}`);
      const config = { version: 1, agents, base, ...(queue ? { queue } : {}), shared, initializedAt: now() };
      writeAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`);
      logEvent({ event: "init", agents, base, queue, shared });
    });
    console.log(`Initialized ${agents.join(" + ")} on ${base}${queue ? `; queue ${queue}` : ""}; ${shared.length} shared path${shared.length === 1 ? "" : "s"}`);
    console.log("Agent identities are self-asserted; inspect the audit log when authorship matters.");
    return;
  }

  const config = loadConfig();

  if (command === "status") {
    console.log(`agents: ${config.agents.join(", ")}  base: ${config.base}${config.queue ? `  queue: ${config.queue}` : ""}`);
    console.log("item                 state      agent        branch                          note");
    for (const claim of readClaims()) {
      const note = claim.openQuestion ? `waiting on ${claim.waitingOn}` : approvalForReady(claim) ? "approved" : claim.ready ? "needs review" : "";
      console.log(`${claim.id.padEnd(20)} ${claim.state.padEnd(10)} ${claim.agent.padEnd(12)} ${(claim.branch || "-").padEnd(31)} ${note}`);
    }
    console.log(`unread: ${config.agents.map((agent) => `${agent}=${pendingMessages(agent)}`).join("  ")}`);
    return;
  }

  if (command === "claim") {
    const id = validateId(target);
    const agent = String(flags.agent || "");
    requireConfiguredAgent(config, agent);
    const branch = String(flags.branch || "").trim();
    if (!branch || !branchHead(branch)) fail(`Claim branch must already exist locally: ${branch || "<empty>"}`);
    const declared = [...new Set(commaList(flags.files, normalizeProjectPath))].sort();
    if (!declared.length) fail("Declare at least one file or directory with --files");
    const tooBroad = declared.find((path) => (config.shared || []).some((sharedPath) => sharedPath.startsWith(`${path}/`)));
    if (tooBroad) fail(`${tooBroad} contains a configured shared path; claim narrower paths so the shared chokepoint stays unlocked`);
    const shared = declared.filter((path) => pathCovered(path, config.shared || []));
    const files = declared.filter((path) => !shared.includes(path));
    withMutationLock(() => {
      const existingPath = claimPath(id);
      if (existsSync(existingPath)) {
        const existing = loadClaim(id);
        fail(`${id} is already ${existing.state} by ${existing.agent}`);
      }
      const overlap = findOverlap(files, readClaims());
      if (overlap) fail(`${overlap.file} overlaps ${overlap.declared}, held by ${overlap.claim.agent} for ${overlap.claim.id}`);
      const record = { agent, branch, files, state: "claimed", claimedAt: now(), reviews: [], readiness: [] };
      saveClaim(id, record);
      logEvent({ event: "claim", id, agent, branch, files });
    });
    if (shared.length) console.log(`Not locking configured shared path${shared.length === 1 ? "" : "s"}: ${shared.join(", ")}`);
    console.log(`${agent} holds ${id}${files.length ? ` over ${files.join(", ")}` : ""}`);
    return;
  }

  if (command === "amend") {
    const id = validateId(target);
    const agent = String(flags.agent || "");
    requireConfiguredAgent(config, agent);
    const requested = [...new Set(commaList(flags.files, normalizeProjectPath))].sort();
    if (!requested.length) fail("amend requires --files");
    withMutationLock(() => {
      const claim = loadClaim(id);
      claim.id = id;
      requireActive(claim, id);
      requireOwner(claim, agent);
      const tooBroad = requested.find((path) => (config.shared || []).some((sharedPath) => sharedPath.startsWith(`${path}/`)));
      if (tooBroad) fail(`${tooBroad} contains a configured shared path; amend with narrower paths`);
      const additions = requested.filter((path) => !pathCovered(path, config.shared || []));
      const files = [...new Set([...(claim.files || []), ...additions])].sort();
      const overlap = findOverlap(files, readClaims(), id);
      if (overlap) fail(`${overlap.file} overlaps ${overlap.declared}, held by ${overlap.claim.agent} for ${overlap.claim.id}`);
      claim.files = files;
      claim.amendments = [...(claim.amendments || []), { agent, requested, at: now() }];
      claim.ready = null;
      claim.state = "claimed";
      saveClaim(id, claim);
      logEvent({ event: "amend", id, agent, requested });
    });
    console.log(`${id} scope amended; readiness invalidated`);
    return;
  }

  if (command === "check") {
    const agent = String(flags.agent || "");
    requireConfiguredAgent(config, agent);
    const id = target ? validateId(target) : null;
    const result = scopeResult(config, agent, id);
    printScope(result);
    if (result.trespass.length) process.exitCode = 2;
    else if (result.undeclared.length) process.exitCode = 1;
    return;
  }

  if (command === "ask") {
    const id = validateId(target);
    const agent = String(flags.agent || "");
    const to = String(flags.to || "");
    requireConfiguredAgent(config, agent);
    requireConfiguredAgent(config, to);
    if (agent === to) fail("Ask the peer, not yourself");
    const question = String(flags.question || "").trim();
    if (question.length < 10) fail("A blocking design question needs concrete text");
    withMutationLock(() => {
      const claim = loadClaim(id);
      claim.id = id;
      requireActive(claim, id);
      requireOwner(claim, agent);
      if (claim.openQuestion) fail(`${id} already has an open question for ${claim.waitingOn}`);
      claim.openQuestion = { from: agent, to, question, at: now() };
      claim.waitingOn = to;
      claim.ready = null;
      claim.state = "claimed";
      saveClaim(id, claim);
      appendMessage({ from: agent, to, re: id, text: `QUESTION on ${id}: ${question}` });
      logEvent({ event: "ask", id, agent, to, question });
    });
    console.log(`${id} is waiting on ${to}`);
    return;
  }

  if (command === "answer") {
    const id = validateId(target);
    const agent = String(flags.agent || "");
    requireConfiguredAgent(config, agent);
    const text = String(flags.text || "").trim();
    if (text.length < 10) fail("An answer needs a concrete decision and rationale");
    withMutationLock(() => {
      const claim = loadClaim(id);
      if (!claim.openQuestion) fail(`${id} has no open question`);
      if (claim.waitingOn !== agent) fail(`${id} is waiting on ${claim.waitingOn}, not ${agent}`);
      claim.answers = [...(claim.answers || []), { from: agent, text, question: claim.openQuestion.question, at: now() }];
      delete claim.openQuestion;
      delete claim.waitingOn;
      saveClaim(id, claim);
      appendMessage({ from: agent, to: claim.agent, re: id, text: `ANSWER on ${id}: ${text}` });
      logEvent({ event: "answer", id, agent });
    });
    console.log(`${id} unblocked; ${loadClaim(id).agent} notified`);
    return;
  }

  if (command === "withdraw") {
    const id = validateId(target);
    const agent = String(flags.agent || "");
    requireConfiguredAgent(config, agent);
    const reason = requireEvidence(flags.reason, 20);
    withMutationLock(() => {
      const claim = loadClaim(id);
      claim.id = id;
      requireActive(claim, id);
      requireOwner(claim, agent);
      if (!claim.openQuestion) fail(`${id} has no open question`);
      if (claim.openQuestion.from !== agent) fail(`Only ${claim.openQuestion.from} may withdraw this question`);
      const withdrawal = { ...claim.openQuestion, reason, withdrawnAt: now() };
      claim.withdrawnQuestions = [...(claim.withdrawnQuestions || []), withdrawal];
      const to = claim.openQuestion.to;
      delete claim.openQuestion;
      delete claim.waitingOn;
      saveClaim(id, claim);
      appendMessage({ from: agent, to, re: id, text: `QUESTION WITHDRAWN on ${id}: ${reason}` });
      logEvent({ event: "withdraw", id, agent, to, reason });
    });
    console.log(`${id} question withdrawn with history preserved`);
    return;
  }

  if (command === "ready") {
    const id = validateId(target);
    const agent = String(flags.agent || "");
    requireConfiguredAgent(config, agent);
    const evidence = requireEvidence(flags.evidence);
    const claim = loadClaim(id);
    claim.id = id;
    requireActive(claim, id);
    requireOwner(claim, agent);
    if (claim.openQuestion) fail(`${id} still has an open question for ${claim.waitingOn}`);
    if (currentBranch() !== claim.branch) fail(`Run ready from ${claim.branch}; current branch is ${currentBranch() || "detached HEAD"}`);
    if (!workingTreeClean()) fail("Commit all work and leave the worktree clean before ready");
    const scope = scopeResult(config, agent, id);
    if (scope.trespass.length || scope.undeclared.length) {
      printScope(scope);
      fail("Scope check failed; resolve it before ready");
    }
    if (!scope.changed.length) fail("Refusing readiness with zero changed files; verify the branch and commit before retrying");
    const ready = { id: randomUUID(), head: runGit(root, ["rev-parse", "HEAD"]), baseHead: runGit(root, ["rev-parse", config.base]), evidence, at: now() };
    withMutationLock(() => {
      const fresh = loadClaim(id);
      fresh.id = id;
      requireActive(fresh, id);
      requireOwner(fresh, agent);
      fresh.ready = ready;
      fresh.readiness = [...(fresh.readiness || []), ready];
      fresh.state = "ready";
      saveClaim(id, fresh);
      logEvent({ event: "ready", id, agent, head: ready.head, baseHead: ready.baseHead });
    });
    console.log(`${id} ready at ${ready.head.slice(0, 12)} against ${config.base} ${ready.baseHead.slice(0, 12)}`);
    return;
  }

  if (command === "review") {
    const id = validateId(target);
    const agent = String(flags.agent || "");
    requireConfiguredAgent(config, agent);
    const verdict = String(flags.verdict || "");
    if (!["approve", "changes"].includes(verdict)) fail("Review verdict must be approve or changes");
    const evidence = requireEvidence(flags.evidence, 20);
    const claim = loadClaim(id);
    if (claim.agent === agent) fail("Review the peer's work, not your own");
    if (!claim.ready || claim.state !== "ready") fail(`${id} has no current ready commit`);
    const head = runGit(root, ["rev-parse", "HEAD"]);
    if (head !== claim.ready.head) fail(`Review exact ready commit ${claim.ready.head}; current HEAD is ${head}`);
    if (!workingTreeClean()) fail("Review from a clean worktree");
    const currentBase = runGit(root, ["rev-parse", config.base]);
    if (currentBase !== claim.ready.baseHead) fail(`${config.base} moved since ready; the owner must synchronize and record ready again`);
    withMutationLock(() => {
      const fresh = loadClaim(id);
      if (!fresh.ready || fresh.ready.head !== head) fail(`${id} readiness changed while review was running`);
      fresh.reviews = [...(fresh.reviews || []), { agent, verdict, evidence, head, readyId: fresh.ready.id, at: now() }];
      if (verdict === "changes") {
        fresh.ready = null;
        fresh.state = "claimed";
      }
      saveClaim(id, fresh);
      appendMessage({ from: agent, to: fresh.agent, re: id, text: `REVIEW ${verdict.toUpperCase()} on ${id} at ${head.slice(0, 12)}: ${evidence}` });
      logEvent({ event: "review", id, agent, verdict, head });
    });
    console.log(`${verdict} recorded for ${id} at ${head.slice(0, 12)}`);
    return;
  }

  if (command === "gate") {
    const id = validateId(target);
    const agent = String(flags.agent || "");
    requireConfiguredAgent(config, agent);
    const claim = loadClaim(id);
    if (!claim.ready) fail(`${id} has no current ready commit`);
    if (!approvalForReady(claim)) fail(`${id} lacks peer approval for ${claim.ready.head}`);
    if (branchHead(claim.branch) !== claim.ready.head) fail(`${claim.branch} changed after review; record ready and review again`);
    if (runGit(root, ["rev-parse", config.base]) !== claim.ready.baseHead) fail(`${config.base} moved after readiness; synchronize and repeat review`);
    console.log(`GATE PASS ${id}: merge ${claim.ready.head} into ${config.base}; approval and base are current`);
    return;
  }

  if (command === "handoff") {
    const id = validateId(target);
    const agent = String(flags.agent || "");
    const to = String(flags.to || "");
    requireConfiguredAgent(config, agent);
    requireConfiguredAgent(config, to);
    if (agent === to) fail("Handoff target must be the peer");
    const note = requireEvidence(flags.note, 30);
    withMutationLock(() => {
      const claim = loadClaim(id);
      claim.id = id;
      requireActive(claim, id);
      requireOwner(claim, agent);
      claim.agent = to;
      claim.ready = null;
      claim.state = "claimed";
      claim.handoffs = [...(claim.handoffs || []), { from: agent, to, note, at: now() }];
      saveClaim(id, claim);
      appendMessage({ from: agent, to, re: id, text: `HANDOFF of ${id}: ${note}` });
      logEvent({ event: "handoff", id, from: agent, to });
    });
    console.log(`${id} handed from ${agent} to ${to}; readiness invalidated`);
    return;
  }

  if (command === "release") {
    const id = validateId(target);
    const agent = String(flags.agent || "");
    requireConfiguredAgent(config, agent);
    withMutationLock(() => {
      const claim = loadClaim(id);
      if (claim.agent !== agent) {
        if (!flags.force) fail(`${id} is held by ${claim.agent}`);
        if (flags.authority !== "human") fail("Forced release requires --authority human and explicit human authorization");
        const reason = requireEvidence(flags.reason, 25);
        logEvent({ event: "forced-release", id, agent, previousAgent: claim.agent, authority: "human", reason });
      } else logEvent({ event: "release", id, agent });
      rmSync(claimPath(id));
    });
    console.log(`${id} released${flags.force ? " with recorded override reason" : ""}`);
    return;
  }

  if (command === "done") {
    const id = validateId(target);
    const agent = String(flags.agent || "");
    requireConfiguredAgent(config, agent);
    const note = requireEvidence(flags.note);
    const forced = Boolean(flags.force);
    let overrideReason = null;
    if (forced) {
      if (flags.authority !== "human") fail("Forced completion requires --authority human and explicit human authorization");
      overrideReason = requireEvidence(flags.reason, 30);
    }
    withMutationLock(() => {
      const claim = loadClaim(id);
      claim.id = id;
      requireActive(claim, id);
      requireOwner(claim, agent);
      if (!forced && claim.openQuestion) fail(`${id} still has an open question for ${claim.waitingOn}`);
      if (!forced && (!claim.ready || !approvalForReady(claim))) fail(`${id} lacks peer approval for its current ready commit`);
      const integratedHead = forced ? branchHead(claim.branch) : claim.ready.head;
      if (!integratedHead) fail(`Cannot resolve branch head for ${claim.branch}`);
      if (!forced && branchHead(claim.branch) !== claim.ready.head) fail(`${claim.branch} changed after review`);
      const contained = runGit(root, ["merge-base", "--is-ancestor", integratedHead, config.base], { optional: true });
      if (contained === null) fail(`${integratedHead} is not contained in ${config.base}; merge before done`);
      claim.state = "done";
      claim.doneAt = now();
      claim.note = note;
      if (forced) claim.override = { authority: "human", agent, reason: overrideReason, at: now() };
      saveClaim(id, claim);
      logEvent({ event: forced ? "forced-done" : "done", id, agent, head: integratedHead, note, ...(forced ? { authority: "human", reason: overrideReason } : {}) });
    });
    console.log(`${id} marked done by ${agent}${forced ? " with logged human override" : ""}`);
    return;
  }

  if (command === "send") {
    const from = String(flags.from || flags.agent || "");
    const to = String(flags.to || "");
    requireConfiguredAgent(config, from);
    requireConfiguredAgent(config, to);
    if (from === to) fail("Send coordination messages to the peer, not yourself");
    const text = String(flags.text || positional.slice(1).join(" ")).trim();
    if (!text) fail("send requires --text");
    const re = flags.re ? validateId(String(flags.re)) : null;
    withMutationLock(() => {
      appendMessage({ from, to, ...(re ? { re } : {}), text });
      logEvent({ event: "message", from, to, re });
    });
    console.log(`sent to ${to} (${pendingMessages(to)} unread)`);
    return;
  }

  if (command === "read") {
    const agent = String(flags.agent || "");
    requireConfiguredAgent(config, agent);
    const first = withMutationLock(() => readMessages(agent, { all: Boolean(flags.all) }));
    showMessages(first);
    if (!flags.wait || first.length) return;
    const path = inboxPath(agent);
    if (!existsSync(path)) writeFileSync(path, "");
    const timeoutSeconds = Math.max(1, Number(flags.timeout || 3600));
    const watcher = watch(path, () => {
      const messages = withMutationLock(() => readMessages(agent));
      if (!messages.length) return;
      showMessages(messages);
      watcher.close();
    });
    const timer = setTimeout(() => {
      watcher.close();
      console.log(`no message within ${timeoutSeconds}s`);
    }, timeoutSeconds * 1000);
    timer.unref?.();
    return;
  }

  if (command === "log") {
    if (!existsSync(logPath)) fail("No coordination events yet");
    const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    for (const line of lines.slice(-Math.max(1, Number(flags.limit || 25)))) console.log(line);
    return;
  }

  fail(`Unknown command: ${command}. Run coord.mjs help`);
}

try {
  main();
} catch (error) {
  if (error instanceof CliError) {
    console.error(error.message);
    process.exitCode = 1;
  } else throw error;
}

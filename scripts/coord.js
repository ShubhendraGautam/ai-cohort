#!/usr/bin/env node
// Coordination channel between agents working this repository in parallel.
//
// Two things only: exclusive claims on roadmap items, and messages between
// agents. State lives under .agents/ and is deliberately not committed, so two
// agents on two branches never conflict over the coordination itself.
//
//   node scripts/coord.js status          # state lives in .git/agent-coordination
//   node scripts/coord.js claim R4 --agent codex --branch feat/r4 --files src/db.js,src/routes/admin-routes.js
//   node scripts/coord.js send --to codex --from claude "R4 is yours; I am on R3."
//   node scripts/coord.js read --agent codex --wait
//   node scripts/coord.js done R4 --agent codex --note "merged into main"
//
// Exclusivity is enforced twice: a claim file is created with O_EXCL so two
// agents cannot hold the same item, and a claim declaring a file another live
// claim already declares is refused.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync, writeFileSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// State lives inside the common .git directory, so every worktree of this
// repository shares one board and one set of inboxes — an agent working in its
// own worktree is still on the same channel — and nothing is ever committed.
function stateDirectory() {
  if (process.env.COORD_DIR) return resolve(process.env.COORD_DIR);
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
    if (common) return join(common, "agent-coordination");
  } catch {
    // not a git checkout; fall through
  }
  return join(root, ".agents");
}

const agentsDir = stateDirectory();
const boardDir = join(agentsDir, "board");
const inboxDir = join(agentsDir, "inbox");
const logPath = join(agentsDir, "log.jsonl");

for (const directory of [agentsDir, boardDir, inboxDir]) mkdirSync(directory, { recursive: true });

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("--")) {
      const name = value.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) flags[name] = true;
      else { flags[name] = next; index += 1; }
    } else positional.push(value);
  }
  return { positional, flags };
}

function logEvent(event) {
  appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function claimPath(id) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) fail("Task id must be short and alphanumeric, e.g. R4");
  return join(boardDir, `${id}.json`);
}

function readClaims() {
  return readdirSync(boardDir).filter((name) => name.endsWith(".json")).map((name) => ({
    id: name.replace(/\.json$/, ""),
    ...JSON.parse(readFileSync(join(boardDir, name), "utf8")),
  }));
}

function queueFromRoadmap() {
  const path = join(root, "docs", "ROADMAP.md");
  if (!existsSync(path)) return [];
  return [...readFileSync(path, "utf8").matchAll(/^### (R\d+)\.\s*(.+)$/gm)].map((match) => ({ id: match[1], title: match[2].trim() }));
}

function overlapping(files, claims) {
  const declared = new Map();
  for (const claim of claims) {
    if (claim.state !== "claimed") continue;
    for (const file of claim.files || []) declared.set(file, claim);
  }
  for (const file of files) {
    for (const [other, claim] of declared) {
      if (file === other || file.startsWith(`${other}/`) || other.startsWith(`${file}/`)) return { file, other, claim };
    }
  }
  return null;
}

function inboxPath(agent) {
  if (!/^[a-z0-9-]{1,32}$/.test(agent)) fail("Agent name must be lowercase letters, digits, or dashes");
  return join(inboxDir, `${agent}.jsonl`);
}

function cursorPath(agent) {
  return join(inboxDir, `${agent}.cursor`);
}

function readMessages(agent, { all = false } = {}) {
  const path = inboxPath(agent);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const cursor = all || !existsSync(cursorPath(agent)) ? 0 : Number(readFileSync(cursorPath(agent), "utf8")) || 0;
  writeFileSync(cursorPath(agent), String(lines.length));
  return lines.slice(all ? 0 : cursor).map((line) => JSON.parse(line));
}

function pending(agent) {
  const path = inboxPath(agent);
  if (!existsSync(path)) return 0;
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).length;
  const cursor = existsSync(cursorPath(agent)) ? Number(readFileSync(cursorPath(agent), "utf8")) || 0 : 0;
  return Math.max(0, lines - cursor);
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, target] = positional;
const agent = flags.agent ? String(flags.agent) : null;

if (command === "status") {
  const claims = readClaims();
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const queue = queueFromRoadmap();
  console.log("item  state     agent    branch                     title");
  for (const item of queue) {
    const claim = byId.get(item.id);
    const state = claim ? claim.state : "open";
    console.log(`${item.id.padEnd(5)} ${state.padEnd(9)} ${(claim?.agent || "-").padEnd(8)} ${(claim?.branch || "-").padEnd(26)} ${item.title}`);
  }
  for (const claim of claims.filter((item) => !queue.some((queued) => queued.id === item.id))) {
    console.log(`${claim.id.padEnd(5)} ${claim.state.padEnd(9)} ${claim.agent.padEnd(8)} ${(claim.branch || "-").padEnd(26)} (not in roadmap queue)`);
  }
  const inboxes = readdirSync(inboxDir).filter((name) => name.endsWith(".jsonl")).map((name) => name.replace(/\.jsonl$/, ""));
  if (inboxes.length) console.log(`\nunread: ${inboxes.map((name) => `${name}=${pending(name)}`).join("  ")}`);
} else if (command === "claim") {
  if (!target || !agent) fail("usage: claim <id> --agent <name> [--branch <branch>] [--files a,b]");
  const files = flags.files ? String(flags.files).split(",").map((file) => file.trim()).filter(Boolean) : [];
  const conflict = overlapping(files, readClaims());
  if (conflict) fail(`Refused: ${conflict.file} overlaps ${conflict.other}, already claimed by ${conflict.claim.agent} for ${conflict.claim.id}`);
  const record = { agent, branch: flags.branch ? String(flags.branch) : null, files, state: "claimed", claimedAt: new Date().toISOString() };
  let handle;
  try {
    handle = openSync(claimPath(target), "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = JSON.parse(readFileSync(claimPath(target), "utf8"));
    fail(`Refused: ${target} is ${existing.state} by ${existing.agent}${existing.branch ? ` on ${existing.branch}` : ""}`);
  }
  writeFileSync(handle, JSON.stringify(record, null, 2));
  closeSync(handle);
  logEvent({ event: "claim", id: target, ...record });
  console.log(`${agent} holds ${target}${files.length ? ` over ${files.join(", ")}` : ""}`);
} else if (command === "release" || command === "done") {
  if (!target || !agent) fail(`usage: ${command} <id> --agent <name> [--note <text>]`);
  if (!existsSync(claimPath(target))) fail(`${target} is not claimed`);
  const existing = JSON.parse(readFileSync(claimPath(target), "utf8"));
  if (existing.agent !== agent && !flags.force) fail(`${target} is held by ${existing.agent}; pass --force to take it`);
  const note = flags.note ? String(flags.note) : null;
  if (command === "release") rmSync(claimPath(target));
  else writeFileSync(claimPath(target), JSON.stringify({ ...existing, state: "done", doneAt: new Date().toISOString(), note }, null, 2));
  logEvent({ event: command, id: target, agent, note });
  console.log(`${target} ${command === "done" ? "marked done" : "released"} by ${agent}`);
} else if (command === "send") {
  const to = flags.to ? String(flags.to) : null;
  const from = flags.from ? String(flags.from) : agent;
  const text = positional.slice(1).join(" ") || (flags.text ? String(flags.text) : "");
  if (!to || !from || !text) fail('usage: send --to <name> --from <name> "message"');
  const message = { at: new Date().toISOString(), from, to, text, ...(flags.re ? { re: String(flags.re) } : {}) };
  appendFileSync(inboxPath(to), `${JSON.stringify(message)}\n`);
  logEvent({ event: "message", from, to, re: message.re || null });
  console.log(`sent to ${to} (${pending(to)} unread there)`);
} else if (command === "read") {
  if (!agent) fail("usage: read --agent <name> [--wait] [--all]");
  const show = (messages) => {
    for (const message of messages) console.log(`[${message.at}] ${message.from} -> ${message.to}${message.re ? ` re ${message.re}` : ""}: ${message.text}`);
  };
  const first = readMessages(agent, { all: Boolean(flags.all) });
  show(first);
  if (!flags.wait || first.length) process.exit(0);
  // Block until something arrives, then exit: the caller's shell wakes up.
  const path = inboxPath(agent);
  if (!existsSync(path)) writeFileSync(path, "");
  const timeout = Number(flags.timeout || 3600) * 1000;
  const watcher = watch(path, () => {
    const messages = readMessages(agent);
    if (!messages.length) return;
    show(messages);
    watcher.close();
    process.exit(0);
  });
  setTimeout(() => { watcher.close(); console.log(`no message within ${timeout / 1000}s`); process.exit(0); }, timeout).unref?.();
} else if (command === "log") {
  if (!existsSync(logPath)) fail("no events yet");
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  for (const line of lines.slice(-Number(flags.limit || 25))) console.log(line);
} else {
  console.log(`usage: coord.js <status|claim|release|done|send|read|log>

  status                                        the board and unread counts
  claim <id> --agent A [--branch B --files F]   take an item, exclusively
  release <id> --agent A                        give it back
  done <id> --agent A [--note N]                mark it finished
  send --to B --from A "text" [--re <id>]       message another agent
  read --agent A [--wait] [--all] [--timeout s] read your inbox; --wait blocks
  log [--limit N]                               recent coordination events`);
}

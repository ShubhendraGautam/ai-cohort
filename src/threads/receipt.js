import { createHash } from "node:crypto";

// A receipt is a canonical statement of what an artifact claims and which
// contributions it cites, hashed so a third party can check later that neither
// has changed. It is deliberately not N7's evidence standard: it proves the
// record is unaltered, not that the conclusion is correct.
//
// The platform verifies every agent signature but does not retain it, so a
// receipt attests to the content hash a post was published with and the key
// fingerprint that published it — not to a signature a reader could re-verify.
// Retaining signatures is a separate decision, parked in the roadmap.

// Keys are emitted in sorted order at every level, so an independent
// implementation can reproduce these exact bytes and therefore the same digest.
//
// Anything JSON cannot carry faithfully is refused rather than coerced. A Date
// would otherwise serialize as {} and a NaN as null, and a receipt that quietly
// loses part of what it attests to is worse than no receipt: the digest would
// still verify.
export function canonicalize(value) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string" || type === "boolean") return JSON.stringify(value);
  if (type === "number") {
    if (!Number.isFinite(value)) throw new TypeError("A receipt cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (type === "undefined") throw new TypeError("A receipt cannot contain undefined");
  if (type !== "object") throw new TypeError(`A receipt cannot contain a ${type}`);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`A receipt cannot contain a ${value.constructor?.name || "non-plain object"}`);
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

export function receiptDigest(body) {
  return createHash("sha256").update(canonicalize(body)).digest("hex");
}

export async function buildArtifactReceipt(db, threadId, artifactId, client) {
  const thread = await db.one("SELECT id, title, objective FROM threads WHERE id = $1", [threadId], client);
  const artifact = await db.one("SELECT id, title, body, created_at FROM artifacts WHERE id = $1", [artifactId], client);
  const cited = await db.all(`
    SELECT p.id, p.content_hash, p.source_url, p.created_at, a.name AS agent_name, a.key_fingerprint, o.name AS operator_name
    FROM artifact_citations c JOIN posts p ON p.id = c.post_id
    JOIN agents a ON a.id = p.agent_id JOIN operators o ON o.id = a.operator_id
    WHERE c.artifact_id = $1 ORDER BY p.id
  `, [artifactId], client);
  const standing = await db.all(`
    SELECT c.post_id FROM post_contests c JOIN posts p ON p.id = c.post_id
    WHERE p.thread_id = $1 AND c.addressed_at IS NULL ORDER BY c.post_id
  `, [threadId], client);

  return {
    version: 1,
    thread: { id: Number(thread.id), title: thread.title, objective: thread.objective },
    artifact: { id: Number(artifact.id), title: artifact.title, body: artifact.body, published_at: new Date(artifact.created_at).toISOString() },
    supporting_posts: cited.map((post) => ({
      id: Number(post.id),
      content_hash: post.content_hash,
      source_url: post.source_url,
      published_at: new Date(post.created_at).toISOString(),
      agent: post.agent_name,
      operator: post.operator_name,
      key_fingerprint: post.key_fingerprint,
    })),
    standing_objections: standing.map((row) => Number(row.post_id)),
  };
}

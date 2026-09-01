// C8 assumes prompt injection rather than hoping against it: threads carry text
// written by other operators' agents, and the expected attack is one agent
// writing instructions that capture another. The platform cannot prevent that —
// it is the reading agent's context, not ours — so it makes it visible.
//
// Detection is deterministic pattern matching. No model reads a post to judge
// it (C3), and nothing here blocks a contribution: a flag is an invitation for a
// human to look, and quoting an attack in order to discuss it is flagged too,
// which is correct. The label says the text resembles an instruction; it does
// not say the author is hostile.
const PATTERNS = [
  [/\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|earlier|above)\s+(?:instructions?|prompts?|rules?)/i, "overrides earlier instructions"],
  [/\bdisregard\s+(?:your|the|all)\s+(?:instructions?|system\s+prompt|rules?|guidelines?)/i, "overrides earlier instructions"],
  [/\b(?:reveal|print|show|output|repeat|disclose)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+prompt|instructions?|prompt|rules?)/i, "asks for another agent's prompt"],
  [/\bwhat\s+(?:are|were)\s+your\s+(?:original\s+)?(?:instructions?|system\s+prompt)/i, "asks for another agent's prompt"],
  [/\b(?:send|share|post|reveal|disclose|forward)\s+(?:me\s+)?(?:your|the)\s+(?:api\s+key|secret|credentials?|private\s+key|token|password)/i, "asks for credentials"],
  [/\byou\s+are\s+now\s+(?:a|an|the)\b/i, "reassigns another agent's role"],
  [/\bfrom\s+now\s+on,?\s+you\s+(?:must|will|should)\b/i, "reassigns another agent's role"],
  [/^\s*(?:system|assistant)\s*:/im, "impersonates a conversation role"],
  [/<\|[a-z_]+\|>/i, "embeds chat-template delimiters"],
];

export function detectInjection(body) {
  const text = String(body || "");
  const found = [];
  for (const [pattern, label] of PATTERNS) {
    const match = text.match(pattern);
    if (match && !found.some((item) => item.label === label)) found.push({ label, quote: match[0].trim().slice(0, 80) });
  }
  return found;
}

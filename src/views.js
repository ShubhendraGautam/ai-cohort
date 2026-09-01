export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function formatDate(value) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function nav(operator) {
  if (!operator) return `<a href="/login">Operator sign in</a>`;
  return `<a href="/dashboard">Dashboard</a><a href="/cohorts">Cohorts</a>${operator.role === "admin" ? '<a href="/admin">Moderate</a>' : ""}<form method="post" action="/logout" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(operator.csrf_token)}"><button class="link">Sign out</button></form>`;
}

export function layout({ title, content, operator = null, status = 200, meta = "" }) {
  return {
    status,
    body: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="A moderated space where independently operated AI agents produce attributable artifacts.">
  <title>${escapeHtml(title)} · AI Cohort</title>${meta}
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header><a class="brand" href="/">AI Cohort</a><nav><a href="/topics">Topics</a><a href="/artifacts">Artifacts</a>${nav(operator)}</nav></header>
  <main>${content}</main>
  <footer><span>Bounded collaboration. Accountable operators. Durable artifacts.</span><a href="/privacy">Privacy & retention</a></footer>
</body>
</html>`,
  };
}

// Shared with the Atom feed, so a summary reads the same wherever it is quoted.
export function summarize(value, length = 200) {
  const flat = String(value || "").replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

// XML 1.0 forbids most control characters outright, so a moderator typing one
// into an artifact title would otherwise produce a feed no reader can parse.
// They are dropped rather than escaped: there is no legal escape for them.
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

export function escapeXml(value = "") {
  return String(value)
    .replace(XML_ILLEGAL, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// An artifact is the unit people share, so it carries its own preview rather
// than inheriting the site's. og:url is absolute because crawlers require it.
export function previewMeta({ title, description, url, type = "article" }) {
  const tags = [
    ["og:site_name", "AI Cohort"],
    ["og:type", type],
    ["og:title", title],
    ["og:description", description],
    ["og:url", url],
    ["twitter:card", "summary"],
    ["twitter:title", title],
    ["twitter:description", description],
  ];
  return tags.filter(([, content]) => content).map(([property, content]) => `\n  <meta property="${escapeHtml(property)}" content="${escapeHtml(content)}">`).join("");
}

export function stateBadge(state) {
  return `<span class="badge ${escapeHtml(state)}">${escapeHtml(state.replaceAll("-", " "))}</span>`;
}

export function csrfField(operator) {
  return `<input type="hidden" name="csrf" value="${escapeHtml(operator.csrf_token)}">`;
}

export function errorPage(message, operator = null, status = 400) {
  return layout({
    title: status === 404 ? "Not found" : "Something went wrong",
    operator,
    status,
    content: `<section class="narrow"><p class="eyebrow">${status}</p><h1>${status === 404 ? "That page does not exist" : "Request not completed"}</h1><p>${escapeHtml(message)}</p><a class="button secondary" href="/">Return home</a></section>`,
  });
}

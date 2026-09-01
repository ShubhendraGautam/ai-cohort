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

export function layout({ title, content, operator = null, status = 200 }) {
  return {
    status,
    body: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="A moderated space where independently operated AI agents produce attributable artifacts.">
  <title>${escapeHtml(title)} · AI Cohort</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header><a class="brand" href="/">AI Cohort</a><nav><a href="/topics">Topics</a>${nav(operator)}</nav></header>
  <main>${content}</main>
  <footer><span>Bounded collaboration. Accountable operators. Durable artifacts.</span><a href="/privacy">Privacy & retention</a></footer>
</body>
</html>`,
  };
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

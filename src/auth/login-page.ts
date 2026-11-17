import type { Response } from "express";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const STYLE = `
  :root { color-scheme: light dark; --bg:#f4f6f8; --card:#fff; --text:#1d2433; --muted:#5b6475; --line:#d7dce3;
          --brand:#0f766e; --brand-text:#fff; --error-bg:#fdecec; --error:#9f1d1d; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12151b; --card:#1b2029; --text:#e8ebf0; --muted:#a3abb8;
          --line:#323a47; --brand:#2dd4bf; --brand-text:#06201d; --error-bg:#3a1d1d; --error:#fca5a5; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--bg);
         color:var(--text); font:16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width:100%; max-width:400px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px; }
  h1 { font-size:1.35rem; margin:0 0 4px; }
  p { margin:0 0 20px; color:var(--muted); font-size:.95rem; }
  label { display:block; font-weight:600; font-size:.9rem; margin:14px 0 6px; }
  input { width:100%; padding:10px 12px; font:inherit; color:inherit; background:transparent;
          border:1px solid var(--line); border-radius:8px; }
  input:focus { outline:2px solid var(--brand); outline-offset:1px; }
  button { width:100%; margin-top:22px; padding:11px; font:inherit; font-weight:600; border:0; border-radius:8px;
           background:var(--brand); color:var(--brand-text); cursor:pointer; }
  .error { background:var(--error-bg); color:var(--error); padding:10px 12px; border-radius:8px; font-size:.9rem; margin:0 0 6px; }
  .fine { margin:18px 0 0; font-size:.8rem; }`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

export function loginPage(o: { clientName?: string; requestToken: string; error?: string; username?: string }): string {
  const app = escapeHtml(o.clientName?.trim() || "An app");
  return page(
    "Sign in to Saada Hisaab",
    `<h1>Sign in to Saada Hisaab</h1>
<p><strong>${app}</strong> is asking for read-only access to your business data: sales, purchases, stock and accounts.
It cannot change anything.</p>
${o.error ? `<div class="error" role="alert">${escapeHtml(o.error)}</div>` : ""}
<form method="post" action="/login" autocomplete="on">
  <input type="hidden" name="request" value="${escapeHtml(o.requestToken)}">
  <label for="username">Username</label>
  <input id="username" name="username" autocomplete="username" required value="${escapeHtml(o.username ?? "")}"${o.username ? "" : " autofocus"}>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required${o.username ? " autofocus" : ""}>
  <button type="submit">Sign in and allow</button>
</form>
<p class="fine">Your password goes only to Saada Hisaab, never to ${app}.</p>`,
  );
}

export function messagePage(title: string, text: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`);
}

/**
 * Sends an HTML page with strict headers: no scripts, no framing (clickjacking), and the form may only
 * post to us. `redirectOrigin` is allowed too because browsers apply form-action to the redirect that
 * follows a successful sign-in.
 */
export function sendPage(res: Response, status: number, html: string, redirectOrigin?: string): void {
  const formAction = ["'self'", ...(redirectOrigin ? [redirectOrigin] : [])].join(" ");
  res
    .status(status)
    .set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    })
    .send(html);
}

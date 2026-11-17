import { publicAccount, type Account, type Identity } from "./store.js";
const escape = (x: unknown) =>
  String(x ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function page(title: string, content: string) {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' +
    escape(title) +
    ' · Buffer Bridge</title><link rel="stylesheet" href="/style.css"></head><body><main><header><span class="mark">B / B</span><p>PERSONAL ACCOUNT CONTROL</p><h1>' +
    escape(title) +
    "</h1></header>" +
    content +
    "<footer>Buffer accounts stay separate. Keys are encrypted on the server.</footer></main></body></html>"
  );
}
const csrf = (token: string) =>
  '<input type="hidden" name="csrf" value="' + escape(token) + '">';
export function dashboard(accounts: Account[], token: string) {
  return page(
    "Your Buffer accounts",
    '<section class="intro"><p>One connector. Explicit routing for every account.</p><a class="button" href="/admin/add">Add Buffer account</a></section>' +
      accounts
        .map(
          (a) =>
            '<article><div class="account-head"><h2>' +
            escape(a.alias) +
            '</h2><span class="badge">' +
            escape(a.status) +
            "</span></div><p>" +
            escape(a.display_name) +
            " · " +
            escape(a.verified_email) +
            '</p><p class="muted">Immutable routing ID</p><code>' +
            escape(a.id) +
            '</code><form method="post" action="/admin/accounts/' +
            a.id +
            '">' +
            csrf(token) +
            '<label>Alias<input name="alias" value="' +
            escape(a.alias) +
            '" maxlength="48" required></label><div class="actions"><button name="action" value="rename">Rename</button><button name="action" value="' +
            (a.status === "enabled" ? "disable" : "enable") +
            '">' +
            (a.status === "enabled" ? "Disable" : "Enable") +
            '</button><a href="/admin/add?replace=' +
            a.id +
            '">Rotate key</a></div></form><details><summary>Remove bridge registration</summary><p>Removes the stored credential and closes bridge connections. Nothing is deleted in Buffer. Revoke the API key separately in Buffer Settings → API.</p><form method="post" action="/admin/accounts/' +
            a.id +
            '">' +
            csrf(token) +
            '<label>Type REMOVE to confirm<input name="confirmation" required pattern="REMOVE"></label><button class="danger" name="action" value="remove">Remove account</button></form></details></article>',
        )
        .join("") +
      '<form method="post" action="/auth/logout">' +
      csrf(token) +
      "<button>Sign out</button></form>",
  );
}
export function addForm(token: string, replace?: Account) {
  return page(
    replace ? "Rotate Buffer credential" : "Add Buffer account",
    '<p>Enter a key from Buffer Settings → API. It is sent only to this bridge over HTTPS, then used to verify the actual Buffer identity.</p><form class="panel" method="post" action="/admin/verify">' +
      csrf(token) +
      (replace
        ? '<input type="hidden" name="replace" value="' + replace.id + '">'
        : "") +
      '<label>Account alias<input name="alias" value="' +
      escape(replace?.alias) +
      '" placeholder="account label" maxlength="48" required></label><label>Buffer API key<input type="password" name="api_key" autocomplete="off" spellcheck="false" required maxlength="4096"></label><button>Verify account</button></form><p><a href="/admin">Back to accounts</a></p>',
  );
}
export function preview(
  id: Identity,
  alias: string,
  ticket: string,
  token: string,
  duplicate?: Account,
  replace?: string,
) {
  return page(
    "Verify this account",
    "<article><h2>" +
      escape(id.name) +
      "</h2><p>" +
      escape(id.email) +
      "</p><code>" +
      escape(id.id) +
      "</code><p>Alias: " +
      escape(alias) +
      "</p><h3>Organizations</h3><ul>" +
      id.organizations
        .map(
          (o) =>
            "<li>" + escape(o.name) + " <code>" + escape(o.id) + "</code></li>",
        )
        .join("") +
      "</ul><h3>Channels</h3><ul>" +
      id.channels
        .map(
          (c) =>
            "<li>" + escape(c.name) + " <code>" + escape(c.id) + "</code></li>",
        )
        .join("") +
      "</ul>" +
      (duplicate
        ? '<p class="notice">This Buffer identity is already registered as ' +
          escape(duplicate.alias) +
          ". Saving replaces that registration’s credential and preserves its immutable ID.</p>"
        : "") +
      '<form method="post" action="/admin/save">' +
      csrf(token) +
      '<input type="hidden" name="ticket" value="' +
      escape(ticket) +
      '"><input type="hidden" name="replace" value="' +
      escape(duplicate?.id || replace || "") +
      '"><button>' +
      (duplicate || replace ? "Replace credential" : "Save account") +
      "</button></form></article>",
  );
}
export const stylesheet = `:root{color-scheme:light;font-family:system-ui,sans-serif;color:#172825;background:#f5f5ee}*{box-sizing:border-box}body{margin:0}main{max-width:900px;margin:60px auto;padding:0 24px}header{border-bottom:1px solid #cad5cd;padding-bottom:25px}header p{font-size:11px;letter-spacing:.18em;color:#557268}.mark{display:inline-block;background:#173f35;color:#fff;padding:12px;border-radius:8px;font-weight:700}h1{font-size:42px;letter-spacing:-.04em;margin:12px 0}h2{margin:0;font-size:25px}.intro,.account-head,.actions{display:flex;align-items:center;justify-content:space-between;gap:18px}.intro{padding:25px 0}.actions{justify-content:flex-start;flex-wrap:wrap}article,.panel{background:white;border:1px solid #d8ded6;border-radius:14px;padding:26px;margin-bottom:20px}label{display:block;margin:20px 0 12px;font-size:14px}input{display:block;margin-top:7px;padding:12px;border:1px solid #b7c8bf;border-radius:7px;width:100%;font:inherit}button,.button{background:#174f3c;color:white;border:0;border-radius:7px;padding:12px 18px;cursor:pointer;font:inherit;text-decoration:none;display:inline-block}a{color:#176245}code{font-size:12px;overflow-wrap:anywhere}.muted,footer{color:#69776c;font-size:12px}.badge{font-size:12px;border-radius:20px;padding:6px 10px;background:#e6efe8}details{margin-top:24px;border-top:1px solid #d8ded6;padding-top:18px}summary{cursor:pointer}.danger{background:#962e28}.notice{padding:16px;background:#fff2cc}footer{margin:35px 0}li{padding:5px} @media(max-width:600px){main{margin-top:25px}.intro{align-items:flex-start;flex-direction:column}h1{font-size:34px}article{padding:20px}}`;

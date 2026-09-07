// /api/digest.js  —  Customer Pulse weekly digest email (via Brevo)
//
// Two ways this runs:
//   1. Vercel Cron (weekly) → GET /api/digest with Authorization: Bearer <CRON_SECRET>
//   2. An admin taps "Send test now" in the app → GET /api/digest?test=1 with their own Bearer token
//
// Required Vercel environment variables:
//   SUPABASE_URL                e.g. https://xfcjxmoqsfcvlskievgx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   (server-only — never in the browser)
//   BREVO_API_KEY               your Brevo transactional API key
//   CRON_SECRET                 any long random string (protects the scheduled run)
//   DIGEST_SENDER_EMAIL         a from-address verified in Brevo (optional; has a default)

export default async function handler(req, res) {
  const URL = process.env.SUPABASE_URL;
  const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const BREVO = process.env.BREVO_API_KEY;
  const CRON_SECRET = process.env.CRON_SECRET;
  const SENDER_EMAIL = process.env.DIGEST_SENDER_EMAIL || "pulse@myjohnstonesupplygroup.com";
  if (!URL || !SRK || !BREVO) {
    return res.status(500).json({ error: "Server not configured (need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BREVO_API_KEY)." });
  }
  const isTest = req.query && (req.query.test === "1" || req.query.test === "true");

  // ---- authorize ----
  if (isTest) {
    // An admin clicked "Send test" — verify their token maps to an active admin.
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "Not signed in" });
    try {
      const u = await fetch(`${URL}/auth/v1/user`, { headers: { apikey: SRK, Authorization: `Bearer ${token}` } });
      if (!u.ok) return res.status(401).json({ error: "Invalid session" });
      const email = ((await u.json()).email || "").toLowerCase();
      const pr = await fetch(`${URL}/rest/v1/cp_people?select=role,active&email=ilike.${encodeURIComponent(email)}`,
        { headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } });
      const me = (await pr.json()).find(p => p.active);
      if (!me || me.role !== "admin") return res.status(403).json({ error: "Admins only" });
    } catch (e) { return res.status(401).json({ error: "Could not verify session" }); }
  } else {
    // Scheduled run — require the cron secret (Vercel Cron sends it as a Bearer token).
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const qsecret = req.query && req.query.secret;
    if (!CRON_SECRET || (auth !== CRON_SECRET && qsecret !== CRON_SECRET)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  // ---- read data (service role) ----
  const q = async (path) => {
    const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } });
    return r.ok ? r.json() : [];
  };
  const [reqs, comments, settings] = await Promise.all([
    q("cp_requests?select=id,customer_name,status,assigned_to,source,submitted_at,first_touched_at,last_action_date,next_follow_up"),
    q("cp_comments?select=request_id,author_role,created_at"),
    q("cp_settings?select=key,value"),
  ]);
  const SET = {}; (settings || []).forEach(s => SET[s.key] = s.value);
  const th = Object.assign({ nudge: 7, cooling: 14, cold: 30 }, SET.aging || {});
  const slaN = (SET.sla && SET.sla.firstTouchDays) || 1;
  const recipients = (SET.digest && SET.digest.recipients) || [];
  const enabled = !SET.digest || SET.digest.enabled !== false;

  // ---- compute (mirrors the app) ----
  const today = new Date().toISOString().slice(0, 10);
  const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
  const OPEN = ["New", "Assigned", "In progress", "Quoting", "Waiting on info"];
  const open = reqs.filter(r => OPEN.includes(r.status) && r.source !== "Recurring visit");
  const lastWorked = r => r.last_action_date || r.first_touched_at || r.submitted_at;
  const idle = r => days(lastWorked(r), today);
  const parked = r => r.next_follow_up && r.next_follow_up > today;
  const agingOpen = open.filter(r => !parked(r));
  const cold = agingOpen.filter(r => idle(r) >= th.cold).sort((a, b) => idle(b) - idle(a));
  const cooling = agingOpen.filter(r => idle(r) >= th.cooling && idle(r) < th.cold);
  const nudge = agingOpen.filter(r => idle(r) >= th.nudge && idle(r) < th.cooling);
  const firstTouch = open.filter(r => !r.first_touched_at);
  const overdue = open.filter(r => r.next_follow_up && r.next_follow_up < today);
  const noFollow = open.filter(r => !r.next_follow_up);
  const byReq = {}; comments.forEach(c => { (byReq[c.request_id] = byReq[c.request_id] || []).push(c); });
  const isMgr = c => c.author_role === "manager" || c.author_role === "admin";
  const unanswered = reqs.filter(r => {
    const cs = (byReq[r.id] || []).slice().sort((a, b) => (a.created_at > b.created_at ? 1 : -1));
    const m = cs.filter(isMgr); if (!m.length) return false;
    const last = m[m.length - 1];
    return !cs.some(c => !isMgr(c) && c.created_at > last.created_at);
  });
  const w7 = r => r.last_action_date && days(r.last_action_date, today) <= 7;
  const wonWk = reqs.filter(r => r.status === "Won" && w7(r)).length;
  const lostWk = reqs.filter(r => r.status === "Lost" && w7(r)).length;
  const openedWk = reqs.filter(r => days(r.submitted_at, today) <= 7).length;

  // ---- build email ----
  const row = (label, val, color) =>
    `<tr><td style="padding:6px 10px;border-bottom:1px solid #eef2f6">${label}</td><td style="padding:6px 10px;border-bottom:1px solid #eef2f6;font-weight:700;text-align:right;color:${color || "#0f172a"}">${val}</td></tr>`;
  const list = (title, arr) => arr.length
    ? `<h3 style="font-size:14px;margin:16px 0 6px;color:#334155">${title}</h3><ul style="margin:0;padding-left:18px;color:#475569;font-size:13px">${arr.slice(0, 8).map(r => `<li>${esc(r.customer_name || "(no name)")} &mdash; ${esc(r.assigned_to || "Unassigned")}${idle(r) ? ` &middot; ${idle(r)}d idle` : ""}</li>`).join("")}${arr.length > 8 ? `<li>+ ${arr.length - 8} more</li>` : ""}</ul>`
    : "";
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  const html = `<div style="font-family:Calibri,Arial,sans-serif;max-width:600px;margin:auto">
    <div style="background:#1e3a8a;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0"><div style="font-size:18px;font-weight:800">Customer Pulse &mdash; weekly digest</div><div style="font-size:12px;opacity:.85">${today}</div></div>
    <div style="border:1px solid #e2e8f0;border-top:none;padding:18px 20px;border-radius:0 0 10px 10px">
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        ${row("Open cards", open.length)}
        ${row(`Cold (untouched ${th.cold}+ days)`, cold.length, cold.length ? "#b91c1c" : "#16a34a")}
        ${row("Awaiting first touch", firstTouch.length, firstTouch.length ? "#b91c1c" : "#16a34a")}
        ${row("Overdue follow-ups", overdue.length, overdue.length ? "#e11d48" : "#16a34a")}
        ${row("Unanswered manager notes", unanswered.length, unanswered.length ? "#b45309" : "#16a34a")}
        ${row("No follow-up set", noFollow.length, noFollow.length ? "#b45309" : "#16a34a")}
        ${row("Opened this week", openedWk)}
        ${row("Won / Lost this week", `${wonWk} / ${lostWk}`)}
      </table>
      <div style="font-size:12px;color:#64748b;margin-top:8px">Aging spread &mdash; nudge ${nudge.length} &middot; going cold ${cooling.length} &middot; cold ${cold.length}. First-touch SLA target: ${slaN}d.</div>
      ${list("Cold &mdash; review or close", cold)}
      ${list("Manager notes waiting on a reply", unanswered)}
      <div style="font-size:12px;color:#94a3b8;margin-top:16px">Open the board &rarr; <a href="https://pulse.myjohnstonesupplygroup.com" style="color:#2563eb">pulse.myjohnstonesupplygroup.com</a></div>
    </div>
  </div>`;

  if (!recipients.length) return res.status(200).json({ ok: false, reason: "No recipients configured (Admin → Weekly digest)." });
  if (!isTest && !enabled) return res.status(200).json({ ok: false, reason: "Digest is turned off." });

  // ---- send via Brevo ----
  const send = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": BREVO, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { name: "Customer Pulse", email: SENDER_EMAIL },
      to: recipients.map(e => ({ email: e })),
      subject: `Customer Pulse digest${isTest ? " (test)" : ""} — ${cold.length} cold, ${unanswered.length} notes waiting`,
      htmlContent: html,
    }),
  });
  const out = await send.json().catch(() => ({}));
  if (!send.ok) return res.status(502).json({ error: "Brevo send failed", detail: out });
  return res.status(200).json({ ok: true, sent_to: recipients.length, test: !!isTest });
}

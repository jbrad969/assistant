import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TIME_ZONE = "America/Phoenix";

const STOPWORDS = new Set([
  "the","a","an","and","or","but","for","to","of","in","on","at","is","are","was","were",
  "be","been","being","have","has","had","do","does","did","will","would","could","should",
  "my","me","you","your","with","from","by","i","brad","please","that","this","about",
]);

function topicWords(message) {
  return new Set(
    String(message || "")
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  );
}

function topicsOverlap(a, b) {
  const wa = topicWords(a);
  const wb = topicWords(b);
  for (const w of wa) if (wb.has(w)) return true;
  return false;
}

function topicKey(message) {
  return [...topicWords(message)].sort().join(",");
}

function phoenixDateOf(iso) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: TIME_ZONE,
  }).format(new Date(iso));
}

function phoenixTodayStartUtc() {
  const phoenixDateStr = phoenixDateOf(new Date().toISOString());
  return new Date(`${phoenixDateStr}T00:00:00-07:00`).toISOString();
}

// One-shot housekeeping: mark anything before today's Phoenix midnight as triggered, then
// dedup any (Phoenix-day, topic) groups that still have multiple active rows.
async function cleanupExpiredAndDuplicates() {
  const cutoff = phoenixTodayStartUtc();
  const expired = await supabase
    .from("reminders")
    .update({ triggered: true })
    .eq("triggered", false)
    .lt("remind_at", cutoff);
  if (expired.error) {
    console.log("[reminders cleanup] expire failed:", expired.error.message);
  }

  const { data: active, error } = await supabase
    .from("reminders")
    .select("id, message, remind_at, created_at")
    .eq("triggered", false)
    .order("created_at", { ascending: false });
  if (error || !active) return;

  const groups = new Map();
  for (const r of active) {
    const key = `${phoenixDateOf(r.remind_at)}|${topicKey(r.message)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const toMark = [];
  for (const group of groups.values()) {
    if (group.length > 1) {
      // group is sorted desc by created_at — keep [0], mark the rest
      for (const r of group.slice(1)) toMark.push(r.id);
    }
  }

  if (toMark.length > 0) {
    const dedup = await supabase
      .from("reminders")
      .update({ triggered: true })
      .in("id", toMark);
    if (dedup.error) {
      console.log("[reminders cleanup] dedup failed:", dedup.error.message);
    } else {
      console.log("[reminders cleanup] marked", toMark.length, "duplicate(s) as triggered");
    }
  }
}

export async function GET() {
  await cleanupExpiredAndDuplicates();

  const { data, error } = await supabase
    .from("reminders")
    .select("*")
    .eq("triggered", false)
    .order("remind_at", { ascending: true });

  if (error) {
    console.log("[/api/reminders GET] supabase error:", error.message, error.details, error.hint);
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ reminders: data || [] });
}

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch (e) {
    console.log("[/api/reminders POST] invalid JSON body:", e.message);
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { message } = body || {};
  let remind_at = body?.remind_at;
  console.log("[/api/reminders POST] body:", JSON.stringify(body));

  if (!message || !remind_at) {
    console.log("[/api/reminders POST] missing fields; message=", message, "remind_at=", remind_at);
    return Response.json(
      { error: "message and remind_at are required" },
      { status: 400 }
    );
  }

  // Normalize to UTC ISO so the row in Supabase always shows the canonical UTC instant.
  // Accepts inputs like "2026-05-06T08:15:00-07:00" (Phoenix offset) or "...Z" — both
  // resolve to the same instant.
  try {
    const parsed = new Date(remind_at);
    if (Number.isNaN(parsed.getTime())) throw new Error("unparseable date");
    remind_at = parsed.toISOString();
  } catch (e) {
    return Response.json({ error: `invalid remind_at: ${e.message}` }, { status: 400 });
  }

  // DUPLICATE PREVENTION — same Phoenix day, within 2 hours, with at least one shared topic word.
  const newDay = phoenixDateOf(remind_at);
  const newMs = new Date(remind_at).getTime();

  const { data: candidates, error: candErr } = await supabase
    .from("reminders")
    .select("id, message, remind_at, triggered")
    .eq("triggered", false);

  if (candErr) {
    console.log("[/api/reminders POST] dup-check fetch failed:", candErr.message);
  }

  const dup = (candidates || []).find((r) => {
    if (phoenixDateOf(r.remind_at) !== newDay) return false;
    if (Math.abs(new Date(r.remind_at).getTime() - newMs) > 2 * 60 * 60 * 1000) return false;
    return topicsOverlap(r.message, message);
  });

  if (dup) {
    console.log(`[/api/reminders POST] duplicate detected (id=${dup.id}); updating instead of inserting`);
    const { data: updated, error: updErr } = await supabase
      .from("reminders")
      .update({ message, remind_at })
      .eq("id", dup.id)
      .select();
    if (updErr) {
      console.log("Reminder update FAILED:", updErr.message, "| code:", updErr.code, "| details:", updErr.details);
      return Response.json(
        { error: updErr.message, code: updErr.code, details: updErr.details },
        { status: 500 }
      );
    }
    console.log("Reminder updated successfully:", updated?.[0]?.id);
    return Response.json({ reminder: updated?.[0], success: true, updated: true });
  }

  console.log(`Saving reminder: "${message}" at ${remind_at}`);
  const { data, error } = await supabase
    .from("reminders")
    .insert([{ message, remind_at, triggered: false }])
    .select();

  if (error) {
    console.log(
      "Reminder save FAILED:",
      error.message,
      "| code:", error.code,
      "| details:", error.details,
      "| hint:", error.hint
    );
    return Response.json(
      { error: error.message, code: error.code, details: error.details, hint: error.hint },
      { status: 500 }
    );
  }

  console.log("Reminder saved successfully:", data?.[0]?.id);
  return Response.json({ reminder: data?.[0], success: true });
}

export async function PATCH(req) {
  const { id } = await req.json();
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  const { error } = await supabase
    .from("reminders")
    .update({ triggered: true })
    .eq("id", id);

  if (error) {
    console.log("[/api/reminders PATCH] supabase error:", error.message, error.details);
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ success: true });
}

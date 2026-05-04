import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

/* ============================================================================
 * 1. CLIENTS & CONSTANTS
 * ========================================================================== */

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CLAUDE_MODEL = "claude-sonnet-4-5";
const TIME_ZONE = "America/Phoenix";
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL;

const HOME_ADDRESS = "4139 East Desert Sands Place Chandler AZ";
const SHOP_ADDRESS = "4211 East Elwood Street Phoenix AZ";

const DAYS_PATTERN = /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

const NO_GUESS_EMAIL_RULE = `NEVER guess or make up email addresses. NEVER. If you don't have the exact email address from the API data, say exactly this: 'I can see Nicole's emails but I need you to confirm her email address - I don't want to guess.' Do not attempt to construct or guess any email address under any circumstances.`;

const ANTI_HALLUCINATION_RULE = `RULE #1 - NEVER HALLUCINATE: If the API returns no data or an error, say you cannot access the information right now. NEVER invent appointments, email addresses, names, times, or any facts. If you don't have real data from an API call, say 'I don't have that information right now' and stop.`;

const CALENDAR_FAILURE_REPLY = "I'm having trouble loading your calendar right now. Please try again in a moment.";

/* ============================================================================
 * 2. SHARED HELPERS
 * ========================================================================== */

function reply(text) {
  return { reply: text };
}

function cleanResponse(text) {
  if (!text) return text;
  return text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim();
}

function parseJsonFromClaude(text, fallback = null) {
  if (!text) return fallback;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return fallback;
  try { return JSON.parse(text.slice(start, end + 1)); }
  catch { return fallback; }
}

async function claudeJson({ system, user, maxTokens = 384 }) {
  const result = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  return result.content?.[0]?.text || "";
}

async function claudeNarrate({ system, user, history = [], maxTokens = 1024 }) {
  const completion = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [...toAnthropicHistory(history), { role: "user", content: user }],
  });
  return cleanResponse(completion.content?.[0]?.text || "");
}

function toAnthropicHistory(history) {
  const startIdx = history.findIndex((m) => m.role === "user");
  if (startIdx === -1) return [];
  return history.slice(startIdx).map((m) => ({ role: m.role, content: m.content }));
}

function todayPhoenixLabel() {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: TIME_ZONE,
  });
}

/* ---------------- DATE / TIME UTILITIES ---------------- */

function getNextDay(dayIndex) {
  const today = new Date();
  const result = new Date(today);
  const diff = (dayIndex + 7 - today.getDay()) % 7 || 7;
  result.setDate(today.getDate() + diff);
  return result;
}

function getDetectedDates(message) {
  const msg = message.toLowerCase();
  const today = new Date();
  const dates = [];
  if (msg.includes("today")) dates.push(new Date(today));
  if (msg.includes("tomorrow")) {
    const d = new Date(today); d.setDate(d.getDate() + 1); dates.push(d);
  }
  const days = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  for (const day in days) {
    if (msg.includes(day)) dates.push(getNextDay(days[day]));
  }
  if (dates.length === 0) dates.push(today);
  return dates;
}

function formatDateLabel(date) {
  return date.toLocaleDateString("en-US", {
    weekday: "long", month: "short", day: "numeric", timeZone: TIME_ZONE,
  });
}

function format12Hour(time24) {
  if (!time24) return "";
  const [hh, mm] = time24.split(":").map(Number);
  const period = hh >= 12 ? "PM" : "AM";
  const h12 = ((hh + 11) % 12) + 1;
  return `${h12}:${String(mm).padStart(2, "0")} ${period}`;
}

function getPhoenixHHMM(iso) {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: TIME_ZONE,
  }).formatToParts(new Date(iso));
  const hh = parts.find((p) => p.type === "hour")?.value || "00";
  const mm = parts.find((p) => p.type === "minute")?.value || "00";
  return `${hh}:${mm}`;
}

function getPhoenixDate(iso) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: TIME_ZONE,
  }).format(new Date(iso));
}

function addMinutesToDateTime({ date, time }, minutes) {
  const [hh, mm] = time.split(":").map(Number);
  let total = hh * 60 + mm + minutes;
  let dayOffset = 0;
  while (total >= 24 * 60) { total -= 24 * 60; dayOffset += 1; }
  while (total < 0) { total += 24 * 60; dayOffset -= 1; }
  let newDate = date;
  if (dayOffset !== 0) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + dayOffset);
    newDate = d.toISOString().slice(0, 10);
  }
  const newH = Math.floor(total / 60);
  const newM = total % 60;
  return { date: newDate, time: `${String(newH).padStart(2, "0")}:${String(newM).padStart(2, "0")}` };
}

function buildPhoenixIsoFromTimeToday(hhmm) {
  const phoenixDate = getPhoenixDate(new Date().toISOString());
  let target = new Date(`${phoenixDate}T${hhmm}:00-07:00`);
  if (target.getTime() <= Date.now()) target = new Date(target.getTime() + 24 * 60 * 60 * 1000);
  return target.toISOString();
}

function formatFriendlyDeparture(departureMs, nowMs) {
  const minutesUntil = Math.round((departureMs - nowMs) / 60000);
  if (minutesUntil <= 0) return "right now";
  if (minutesUntil <= 60) return `in ${minutesUntil} minute${minutesUntil === 1 ? "" : "s"}`;
  const dep = new Date(departureMs);
  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: TIME_ZONE,
  });
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: TIME_ZONE,
  });
  const depDate = dateFmt.format(dep);
  if (depDate === dateFmt.format(new Date(nowMs))) return `at ${timeFmt.format(dep)} today`;
  if (depDate === dateFmt.format(new Date(nowMs + 24 * 60 * 60 * 1000))) return `tomorrow at ${timeFmt.format(dep)}`;
  const dayName = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: TIME_ZONE }).format(dep);
  return `${dayName} at ${timeFmt.format(dep)}`;
}

/* ---------------- HISTORY-AWARENESS ---------------- */

function historyHasCalendarData(history) {
  const recent = history.slice(-10);
  for (const m of recent) {
    if (m.role !== "assistant") continue;
    const times = (m.content || "").match(/\b\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm)\b/g) || [];
    if (times.length >= 2) return true;
  }
  return false;
}

function isExplicitCalendarRefresh(message) {
  const m = message.toLowerCase();
  return m.includes("check my calendar again") || m.includes("re-check") ||
    m.includes("refresh") || m.includes("look again") || m.includes("any new events");
}

function mentionsDifferentDay(message, history) {
  const msgDays = (message.toLowerCase().match(DAYS_PATTERN) || []).map((d) => d.toLowerCase());
  if (msgDays.length === 0) return false;
  const recent = history.slice(-10).map((m) => (m.content || "").toLowerCase()).join(" ");
  return msgDays.some((day) => !recent.includes(day));
}

function lastAssistantMessage(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") return history[i].content || "";
  }
  return "";
}

function hasPendingEmailDraft(history) {
  const last = lastAssistantMessage(history);
  return /^\s*Draft email:/im.test(last) && /Send it\?/i.test(last);
}

function parseEmailDraft(text) {
  if (!text) return null;
  const toMatch = text.match(/^To:\s*(.+)$/im);
  const subjectMatch = text.match(/^Subject:\s*(.+)$/im);
  const bodyMatch = text.match(/Body:\s*([\s\S]+?)(?=\n\s*Send it\?|$)/i);
  if (!toMatch || !subjectMatch || !bodyMatch) return null;
  return {
    to: toMatch[1].trim(),
    subject: subjectMatch[1].trim(),
    body: bodyMatch[1].trim(),
  };
}

function isEmailApproval(message) {
  const m = message.toLowerCase().trim().replace(/[.!]+$/, "");
  const phrases = ["send it", "yes send it", "yes send", "yes", "yep", "yeah", "go", "go ahead", "send", "send the email", "send that", "do it", "ok send it", "okay send it"];
  return phrases.some((p) => m === p || m.startsWith(p + " "));
}

/* ============================================================================
 * 3. MEMORY MODULE
 * ========================================================================== */

const MEMORY_CAP = 500;
const INJECTION_CAP = 40;
const RECENT_NONCORE_CAP = 20;

const STOPWORDS = new Set([
  "the","a","an","and","or","but","for","to","of","in","on","at","is","are","was","were",
  "be","been","being","have","has","had","do","does","did","will","would","could","should",
  "may","might","must","can","i","you","he","she","it","we","they","what","who","where",
  "when","why","how","this","that","these","those","my","your","his","her","its","our",
  "their","me","him","us","them","with","from","by","up","out","over","into","then","than",
  "so","as","also","just","only","too","very","much","many","some","all","any","no","not",
  "yes","ok","okay","please","thanks","thank","let","get","got","ask","asked","tell","told",
]);

function extractKeywords(message) {
  if (!message) return [];
  return message.toLowerCase().split(/\W+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function isCoreMemory(m) { return m?.content?.startsWith("[CORE]"); }
function stripTag(content) { return content.replace(/^\[(?:CORE|LOG)\]\s*/, ""); }

async function insertMemoryWithCap(content) {
  const { count } = await supabase.from("memory").select("*", { count: "exact", head: true });
  if ((count ?? 0) >= MEMORY_CAP) {
    const { data: oldest } = await supabase.from("memory")
      .select("id").not("content", "ilike", "[CORE]%")
      .order("created_at", { ascending: true }).limit(1);
    if (oldest && oldest[0]) {
      await supabase.from("memory").delete().eq("id", oldest[0].id);
    } else {
      console.log("[memory] cap reached but no non-CORE memories to evict");
    }
  }
  await supabase.from("memory").insert([{ content }]);
}

async function getCoreMemory() {
  const { data } = await supabase.from("memory")
    .select("id, content").ilike("content", "[CORE]%")
    .order("created_at", { ascending: true });
  return data || [];
}

async function getInjectionMemory(message) {
  const { data } = await supabase.from("memory")
    .select("id, content, created_at").order("created_at", { ascending: false });
  const all = data || [];
  const core = all.filter(isCoreMemory);
  const nonCore = all.filter((m) => !isCoreMemory(m));
  const keywords = extractKeywords(message);
  const matches = (m) => keywords.length > 0 && keywords.some((k) => m.content.toLowerCase().includes(k));

  const result = new Map();
  for (const m of core) { if (result.size >= INJECTION_CAP) break; result.set(m.id, m); }
  for (const m of nonCore) {
    if (result.size >= INJECTION_CAP) break;
    if (!result.has(m.id) && matches(m)) result.set(m.id, m);
  }
  let recentCount = 0;
  for (const m of nonCore) {
    if (result.size >= INJECTION_CAP || recentCount >= RECENT_NONCORE_CAP) break;
    if (!result.has(m.id)) { result.set(m.id, m); recentCount += 1; }
  }
  return Array.from(result.values());
}

async function saveOrUpdateMemory(message, currentMemory) {
  const memoryText = currentMemory.length > 0
    ? currentMemory.map((m) => `ID: ${m.id} | ${stripTag(m.content)}`).join("\n")
    : "No memory yet.";

  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You manage Jess's long-term memory for Brad. The memories below are personal facts (CORE).

Existing memory:
${memoryText}

Return JSON only:
{"action": "none" | "insert" | "update", "id": "existing id or null", "content": "memory fact or null"}

Rules:
- Save personal facts, preferences, names, addresses, key people, company info.
- Do not save questions, action logs, or transient details.
- Do not duplicate — use update if an existing fact has changed.
- Content must be the bare fact, no tag prefix (the system tags it automatically).`,
      },
      { role: "user", content: message },
    ],
  });

  const action = JSON.parse(result.choices[0].message.content);

  if (action.action === "insert" && action.content) {
    const tagged = action.content.startsWith("[CORE]") ? action.content : `[CORE] ${action.content}`;
    await insertMemoryWithCap(tagged);
  }

  if (action.action === "update" && action.id && action.content) {
    const existing = currentMemory.find((m) => String(m.id) === String(action.id));
    const existingTag = existing?.content.match(/^\[(?:CORE|LOG)\]/)?.[0] || "[CORE]";
    const tagged = action.content.startsWith("[") ? action.content : `${existingTag} ${action.content}`;
    await supabase.from("memory").update({ content: tagged }).eq("id", action.id);
  }
}

/* ============================================================================
 * 4. INTENT DETECTION
 *
 * Each function takes a message and returns boolean.
 * Designed to be narrow enough that overlap is rare; the dispatcher's order
 * resolves any remaining ties.
 * ========================================================================== */

function isMemoryQuestion(message) {
  const m = message.toLowerCase();
  return /\b(remember that|please remember|save this|store this|note that)\b/.test(m);
}

function isEmailRead(message) {
  const m = message.toLowerCase();
  return (
    /\bread\s+(?:my\s+)?emails?\b/.test(m) ||
    /\bcheck\s+(?:my\s+)?(?:emails?|inbox)\b/.test(m) ||
    /\bany\s+(?:unread\s+|new\s+)?emails?\b/.test(m) ||
    /\bany\s+emails?\s+from\b/.test(m) ||
    /\bemails?\s+from\b/.test(m) ||
    /\bshow\s+(?:me\s+)?(?:my\s+)?emails?\b/.test(m) ||
    /\bwhat\s+emails?\b/.test(m)
  );
}

function isEmailSend(message) {
  const m = message.toLowerCase();
  return (
    m.includes("send an email") ||
    m.includes("send email to") ||
    m.includes("write an email") ||
    m.includes("draft an email") ||
    m.includes("draft email") ||
    /\bemail\s+(her|him|nicole|mike|john|sarah|yvonne|brad|me)\b/.test(m) ||
    /\bsend\s+(her|him)\s+an?\s+email\b/.test(m)
  );
}

function isQuote(message) {
  const m = message.toLowerCase();
  return (
    m.includes("roof quote") ||
    m.includes("quote for") ||
    m.includes("need a quote") ||
    m.includes("request a quote") ||
    m.includes("send a quote")
  );
}

function isCalendarWrite(message) {
  const m = message.toLowerCase();
  if (m.includes("remind me") || m.includes("set reminder") || m.includes("don't forget") || m.includes("dont forget")) return false;
  const writeVerb = /\b(add|create|delete|remove|move|reschedule|cancel|book)\b/.test(m) || m.includes("set up");
  const calendarContext =
    /\b(meeting|appointment|event|call|lunch|dinner|breakfast|coffee|standup|interview)\b/.test(m) ||
    DAYS_PATTERN.test(m) || /\d\s*(am|pm)/.test(m) || /\bat\s+\d/.test(m);
  return writeVerb && calendarContext;
}

function isDeparture(message) {
  const m = message.toLowerCase();
  if (m.includes("remind me") || m.includes("set reminder") || m.includes("don't forget") || m.includes("dont forget")) return false;
  return (
    /\bwhen\b.{0,30}\bleave\b/.test(m) ||
    /\bwhat time\b.{0,30}\b(leave|be|get)\b/.test(m) ||
    m.includes("how long to get") ||
    m.includes("how long will it take") ||
    m.includes("how long until") ||
    m.includes("drive time") ||
    m.includes("driving time") ||
    m.includes("travel time") ||
    /\btraffic\b/.test(m) ||
    m.includes("should i leave") ||
    m.includes("leave for") ||
    m.includes("how far is")
  );
}

function isReminder(message) {
  const m = message.toLowerCase();
  return (
    m.includes("remind me") ||
    m.includes("set a reminder") ||
    m.includes("set reminder") ||
    m.includes("don't forget") ||
    m.includes("dont forget") ||
    m.includes("don't let me forget") ||
    m.includes("dont let me forget")
  );
}

function isCalendarRead(message) {
  const m = message.toLowerCase();
  // Defer to more specific intents so they win the dispatcher race even if check order changes later.
  if (isReminder(message)) return false;
  if (isCalendarWrite(message)) return false;
  if (isDeparture(message)) return false;
  return (
    m.includes("what's on") ||
    m.includes("whats on") ||
    m.includes("what do i have") ||
    /\bschedule\b/.test(m) ||
    /\bcalendar\b/.test(m) ||
    DAYS_PATTERN.test(m) ||
    m.includes("today") ||
    m.includes("tomorrow")
  );
}

/* ============================================================================
 * 5. INTENT HANDLERS
 *
 * Each handler is async (ctx) => { reply } | null.
 * Return null to fall through to the next handler.
 * ========================================================================== */

/* ---------------- EMAIL READ (general inbox + sender search) ---------------- */

async function getEmails(all = false) {
  const limit = all ? "50" : "5";
  const res = await fetch(`${BASE_URL}/api/email?limit=${limit}&all=${all}`);
  return (await res.json()).emails || [];
}

async function getEmailsBySearch(search, limit = 5, fullBody = false) {
  const params = new URLSearchParams({ search, limit: String(limit) });
  if (fullBody) params.set("full", "true");
  const res = await fetch(`${BASE_URL}/api/email?${params.toString()}`);
  return (await res.json()).emails || [];
}

async function extractSenderFromMessage(message) {
  // Cheap regex first
  const m = message.match(/\bfrom\s+([A-Z][\w']+(?:\s+[A-Z][\w']+)?)/i);
  if (m) return m[1].trim();
  return null;
}

async function handleEmailRead(ctx) {
  if (!isEmailRead(ctx.message)) return null;

  const sender = await extractSenderFromMessage(ctx.message);
  let emails;
  let scopeLabel;

  if (sender) {
    emails = await getEmailsBySearch(`from:${sender}`, 5);
    scopeLabel = `from ${sender}`;
  } else {
    emails = await getEmails(false);
    scopeLabel = "unread";
  }

  if (emails.length === 0) {
    return reply(sender ? `No emails from ${sender}.` : "No unread emails right now.");
  }

  const ctxText = emails
    .map((e, i) => `${i + 1}. From: ${e.from}\nFrom email: ${e.fromEmail || "(unknown)"}\nSubject: ${e.subject}\nDate: ${e.date}\nPreview: ${(e.body || "").slice(0, 250)}`)
    .join("\n\n");

  const text = await claudeNarrate({
    system: `You are Jess, Brad's executive assistant.
Summarize these emails naturally and conversationally — who they're from and what they're about.
Flag anything urgent or from tnkroofing.com as a quote response.
No markdown. Be concise. One or two sentences per email.

${NO_GUESS_EMAIL_RULE}
If Brad asks for an email address, ONLY use the "From email" value shown for that sender.`,
    user: `Brad asked: "${ctx.message}"\n\n${scopeLabel} emails:\n\n${ctxText}`,
  });
  return reply(text);
}

/* ---------------- EMAIL SEND (draft + approval) ---------------- */

async function extractEmailDraft(message, history = []) {
  const recentHistory = history.slice(-6);
  const conversationContext = recentHistory.length
    ? recentHistory.map((m) => `${m.role}: ${m.content}`).join("\n")
    : "(no prior turns)";

  const raw = await claudeJson({
    maxTokens: 768,
    system: `Brad wants to send an email. Draft it.
Return ONLY a JSON object, no preamble:
{
  "to": "recipient email address (name@domain.com) if known, else null",
  "recipientName": "person's name if no email address is known" | null,
  "subject": "concise subject line",
  "body": "the email body (sign as Brad)"
}
If Brad gave a name like "Nicole" without an email, leave "to" null and put the name in "recipientName".
If Brad didn't dictate the body, draft a short professional one based on the request and conversation context.

${NO_GUESS_EMAIL_RULE}
The "to" field must be either an email address that appeared verbatim in the conversation (or that Brad explicitly typed in this turn) or null. Never invent a domain, never guess a username pattern, never construct an address from a name.`,
    user: `Recent conversation:\n${conversationContext}\n\nCurrent request: "${message}"`,
  });
  return parseJsonFromClaude(raw);
}

async function handleEmailSendApproval(ctx) {
  if (!hasPendingEmailDraft(ctx.history)) return null;
  if (!isEmailApproval(ctx.message)) return null;

  const draft = parseEmailDraft(lastAssistantMessage(ctx.history));
  if (!draft) {
    return reply("I lost track of the draft. Tell me again what to send and to whom.");
  }

  const res = await fetch(`${BASE_URL}/api/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: draft.to, subject: draft.subject, body: draft.body }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    console.log("[chat] email send failed:", data?.error || res.status);
    return reply("I had trouble sending that email, please try again.");
  }

  try {
    await insertMemoryWithCap(`[LOG] Sent email to ${draft.to} on ${ctx.today}: ${draft.subject}`);
  } catch (e) { console.log("[chat] couldn't log sent-email memory:", e.message); }

  return reply(`Done — sent to ${draft.to}.`);
}

async function handleEmailSend(ctx) {
  if (!isEmailSend(ctx.message)) return null;

  const draft = await extractEmailDraft(ctx.message, ctx.history);
  if (!draft || !draft.subject || !draft.body) {
    return reply("Tell me who to send to, the subject, and what to say.");
  }
  if (!draft.to) {
    const who = draft.recipientName ? `${draft.recipientName}'s` : "the recipient's";
    return reply(`I need ${who} email address — what is it?`);
  }

  return reply(`Draft email:
To: ${draft.to}
Subject: ${draft.subject}
Body:
${draft.body}

Send it?`);
}

/* ---------------- QUOTE ---------------- */

async function extractQuoteDetails(message) {
  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Extract roof quote details from the message. Return JSON:
{"customerName": "full name or null", "customerEmail": "email or null", "customerAddress": "full address or null", "roofMaterial": "Tile" | "Shingle" | "Flat" | null, "notes": "any notes or null"}
Only return Tile, Shingle, or Flat for roofMaterial. If unclear, return null.`,
      },
      { role: "user", content: message },
    ],
  });
  return JSON.parse(result.choices[0].message.content);
}

async function handleQuote(ctx) {
  if (!isQuote(ctx.message)) return null;

  const extracted = await extractQuoteDetails(ctx.message);
  if (!extracted.customerName || !extracted.customerAddress || !extracted.roofMaterial) {
    return reply("I need a few more details for that quote. Customer's full name, address, and roof material (Tile, Shingle, or Flat)?");
  }

  const res = await fetch(`${BASE_URL}/api/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(extracted),
  });
  const data = await res.json();
  if (data.success) {
    return reply(`Done — quote sent to T&K Roofing for ${extracted.customerName} at ${extracted.customerAddress}. They usually respond in 15-30 minutes.`);
  }
  return reply(`Something went wrong submitting the quote: ${data.error}`);
}

/* ---------------- CALENDAR READ ---------------- */

async function getCalendarForDate(date) {
  const iso = date.toISOString();
  try {
    const res = await fetch(`${BASE_URL}/api/calendar/today?date=${encodeURIComponent(iso)}`);
    const data = await res.json();
    if (!res.ok || data.error) {
      console.log("[chat] calendar fetch error for", iso, "->", data.error || `status ${res.status}`);
      return { label: formatDateLabel(date), error: true, details: data.error || `status ${res.status}` };
    }
    if (!data.events || data.events.length === 0) {
      return { label: formatDateLabel(date), text: "No events scheduled." };
    }
    const text = data.events
      .map((e) => {
        const loc = e.location ? ` — ${e.location}` : "";
        const invited = e.attendees && e.attendees.length
          ? ` — invited: ${e.attendees.join(", ")}`
          : "";
        return `${e.time} — ${e.title}${loc}${invited}`;
      })
      .join("\n");
    return { label: formatDateLabel(date), text };
  } catch (e) {
    console.log("[chat] calendar fetch threw for", iso, "->", e.message);
    return { label: formatDateLabel(date), error: true, details: e.message };
  }
}

async function handleCalendarRead(ctx) {
  if (!isCalendarRead(ctx.message)) return null;

  if (
    historyHasCalendarData(ctx.history) &&
    !isExplicitCalendarRefresh(ctx.message) &&
    !mentionsDifferentDay(ctx.message, ctx.history)
  ) {
    return null; // fall through; normal chat answers from history
  }

  const dates = getDetectedDates(ctx.message);
  const schedules = await Promise.all(dates.map(getCalendarForDate));

  // If any day failed, refuse to narrate — never let Claude fill the gap with invented events.
  if (schedules.some((s) => s.error)) {
    console.log("[chat] calendar narration skipped due to API error(s)");
    return reply(CALENDAR_FAILURE_REPLY);
  }

  const calendarContext = schedules.map((s) => `${s.label}:\n${s.text}`).join("\n\n");

  const text = await claudeNarrate({
    system: `You are Jess, Brad's executive assistant.

${ANTI_HALLUCINATION_RULE}

Today is ${ctx.today}. Use it as the reference for the current date — never reference events from wrong years.
Summarize the schedule naturally — time, title, and location. No markdown. Brief.
Calendar event locations are DESTINATIONS Brad is going to, never his home.
Only mention events that appear in the Calendar data block below. If a day shows "No events scheduled.", say exactly that — never invent events.

${NO_GUESS_EMAIL_RULE}
If Brad asks for an email address from a calendar invite, ONLY return what appears in the "invited:" list below — copy it verbatim. If a person isn't in that list, say you don't have their address.`,
    user: `Calendar data:\n\n${calendarContext}\n\nBrad asked: "${ctx.message}"`,
  });
  return reply(text);
}

/* ---------------- CALENDAR WRITE (add / delete / move) ---------------- */

async function findEventByCriteria({ date, time, title }) {
  if (!date && !title) return [];
  const dateObj = date ? new Date(`${date}T12:00:00`) : new Date();
  const res = await fetch(`${BASE_URL}/api/calendar/today?date=${encodeURIComponent(dateObj.toISOString())}`);
  const data = await res.json();
  return (data.events || []).filter((event) => {
    if (time && getPhoenixHHMM(event.start) !== time) return false;
    if (title && !(event.title || "").toLowerCase().includes(title.toLowerCase())) return false;
    return true;
  });
}

async function extractEventDetails(message, today) {
  const raw = await claudeJson({
    maxTokens: 1024,
    system: `You convert natural-language calendar commands into JSON.
Today is ${today} (America/Phoenix timezone).

Return ONLY a JSON object, no preamble:
{
  "action": "add" | "delete" | "move" | "none",
  "title": "event title or null",
  "date": "YYYY-MM-DD or null",
  "time": "HH:MM 24-hour or null",
  "newDate": "YYYY-MM-DD or null (only for move)",
  "newTime": "HH:MM 24-hour or null (only for move)",
  "durationMinutes": "integer or null",
  "location": "string or null"
}

Rules:
- Resolve relative dates (today, tomorrow, weekday names) to absolute YYYY-MM-DD
- Convert times to 24-hour HH:MM
- For "add": title, date, and time are required
- For "delete": at least one of date, time, or title must identify the event
- For "move": (date+time OR title) identifies the event; provide newDate and/or newTime
- If unclear or read-intent, return action "none"`,
    user: message,
  });
  return parseJsonFromClaude(raw, { action: "none" });
}

async function handleCalendarWrite(ctx) {
  if (!isCalendarWrite(ctx.message)) return null;

  const details = await extractEventDetails(ctx.message, ctx.today);

  if (details.action === "add") {
    if (!details.title || !details.date || !details.time) {
      return reply("I need a title, date, and time to add that.");
    }
    const start = { date: details.date, time: details.time };
    const res = await fetch(`${BASE_URL}/api/calendar/today`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: details.title, start,
        durationMinutes: details.durationMinutes || 60,
        location: details.location,
      }),
    });
    const data = await res.json();
    if (!data.success) return reply(`Couldn't add that event: ${data.error}`);
    const dayLabel = formatDateLabel(new Date(`${details.date}T12:00:00`));
    return reply(`Done — added "${details.title}" on ${dayLabel} at ${format12Hour(details.time)}.`);
  }

  if (details.action === "delete") {
    const matches = await findEventByCriteria({ date: details.date, time: details.time, title: details.title });
    if (matches.length === 0) return reply("Couldn't find an event matching that.");
    if (matches.length > 1) {
      const summary = matches.map((e) => `${e.time} ${e.title}`).join(", ");
      return reply(`Found multiple matches: ${summary}. Which one?`);
    }
    const event = matches[0];
    const res = await fetch(`${BASE_URL}/api/calendar/today`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: event.id }),
    });
    const data = await res.json();
    if (!data.success) return reply(`Couldn't delete that event: ${data.error}`);
    return reply(`Done — deleted "${event.title}" on ${formatDateLabel(new Date(event.start))} at ${event.time}.`);
  }

  if (details.action === "move") {
    const matches = await findEventByCriteria({ date: details.date, time: details.time, title: details.title });
    if (matches.length === 0) return reply("Couldn't find an event matching that.");
    if (matches.length > 1) {
      const summary = matches.map((e) => `${e.time} ${e.title}`).join(", ");
      return reply(`Found multiple matches: ${summary}. Which one?`);
    }
    const event = matches[0];
    const durationMinutes = Math.max(15, Math.round((new Date(event.end).getTime() - new Date(event.start).getTime()) / 60000));
    const newDate = details.newDate || details.date || getPhoenixDate(event.start);
    const newTime = details.newTime || getPhoenixHHMM(event.start);
    if (!newDate || !newTime) return reply("I need a new date or time to move it to.");

    const newStart = { date: newDate, time: newTime };
    const newEnd = addMinutesToDateTime(newStart, durationMinutes);
    const res = await fetch(`${BASE_URL}/api/calendar/today`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: event.id, start: newStart, end: newEnd }),
    });
    const data = await res.json();
    if (!data.success) return reply(`Couldn't move that event: ${data.error}`);
    return reply(`Done — moved "${event.title}" to ${format12Hour(newTime)} on ${formatDateLabel(new Date(`${newDate}T12:00:00`))} (was ${event.time}).`);
  }

  return null; // action === "none" — fall through
}

/* ---------------- DEPARTURE (calendar + maps) ---------------- */

function detectOrigin(message) {
  const m = message.toLowerCase();
  if (m.includes("from the shop") || m.includes("from shop")) return SHOP_ADDRESS;
  if (m.includes("from home") || m.includes("from my house")) return HOME_ADDRESS;
  return HOME_ADDRESS;
}

async function extractDepartureContext(message, history = []) {
  const recentHistory = history.slice(-10);
  const conversationContext = recentHistory.length
    ? recentHistory.map((m) => `${m.role}: ${m.content}`).join("\n")
    : "(no prior turns)";

  const raw = await claudeJson({
    maxTokens: 384,
    system: `Brad is asking about departure / travel timing.

Look at the recent conversation. If it already shows the event's location AND start time, return them so we skip the calendar lookup.

Return ONLY JSON, no preamble:
{
  "eventReference": "1-3 word title fragment to search calendar by" | null,
  "knownLocation": "exact location from history (full address if visible)" | null,
  "knownArrivalTime": "HH:MM 24-hour Phoenix" | null
}`,
    user: `Recent conversation:\n${conversationContext}\n\nCurrent question: "${message}"`,
  });
  return parseJsonFromClaude(raw, { eventReference: null, knownLocation: null, knownArrivalTime: null });
}

async function callMapsForDeparture({ origin, destination, arrivalIso }) {
  const params = new URLSearchParams({ origin, destination, arrivalTime: arrivalIso });
  const res = await fetch(`${BASE_URL}/api/maps?${params.toString()}`);
  const data = await res.json();
  if (!res.ok || data.error) return { error: data.error || `maps API returned ${res.status}` };
  return data;
}

async function handleDeparture(ctx) {
  if (!isDeparture(ctx.message)) return null;

  const origin = detectOrigin(ctx.message);
  const dctx = await extractDepartureContext(ctx.message, ctx.history);

  // Fast path: history already has destination + time. Skip calendar lookup.
  if (dctx.knownLocation && dctx.knownArrivalTime) {
    const arrivalIso = buildPhoenixIsoFromTimeToday(dctx.knownArrivalTime);
    const maps = await callMapsForDeparture({ origin, destination: dctx.knownLocation, arrivalIso });
    if (maps.error) {
      console.log("[chat] departure (history) maps error:", maps.error);
      return reply("I'm having trouble reaching Google Maps right now - try again in a moment.");
    }
    const arrivalMs = new Date(arrivalIso).getTime();
    const driveMin = maps.driveTimeMinutes;
    const trafficMin = maps.trafficDelayMinutes;
    const departureMs = arrivalMs - (driveMin + 10) * 60 * 1000;
    const friendly = formatFriendlyDeparture(departureMs, Date.now());
    const trafficNote = trafficMin >= 5 ? ` Traffic is adding about ${trafficMin} minutes.` : "";
    const eventLabel = dctx.eventReference ? `the ${dctx.eventReference}` : dctx.knownLocation;
    return reply(`Leave ${friendly} to make ${eventLabel} — ${driveMin} minutes drive.${trafficNote}`);
  }

  // Slow path: hit /api/departure (calendar + maps).
  let data;
  try {
    const params = new URLSearchParams({ origin });
    if (dctx.eventReference) params.set("eventQuery", dctx.eventReference);
    const res = await fetch(`${BASE_URL}/api/departure?${params.toString()}`);
    data = await res.json();
    if (!res.ok && !data?.error) data = { error: `departure API returned ${res.status}` };
  } catch (fetchErr) {
    console.log("[chat] departure fetch threw:", fetchErr.message);
    return reply("I'm having trouble reaching Google Maps right now - try again in a moment.");
  }

  if (data.noEventMatch) return reply(`I don't see an event matching "${data.query}" on your calendar in the next 7 days.`);
  if (data.noEvent) return reply("You don't have an upcoming event with a location in the next 24 hours.");
  if (data.error) {
    console.log("[chat] departure surfaced error:", data.error);
    return reply("I'm having trouble reaching Google Maps right now - try again in a moment.");
  }

  const eventTimeLabel = new Date(data.event.start).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: TIME_ZONE,
  });

  const text = await claudeNarrate({
    system: `You are Jess, Brad's executive assistant.
Narrate departure timing naturally. Use the EXACT numbers given — do not estimate or recompute.
Lead with WHEN to leave, using "Friendly departure time" verbatim.
Mention drive time. Mention traffic delay only if 5+ minutes. One or two sentences. No markdown.`,
    user: `Departure data:
- Next event: "${data.event.title}" at ${eventTimeLabel} at ${data.event.location}
- Friendly departure time: ${data.friendlyDepartureTime}
- Drive time with current traffic: ${data.driveTimeMinutes} minutes
- Traffic delay vs normal: ${data.trafficDelayMinutes} minutes
- Distance: ${data.distance || "unknown"}
- Origin: ${data.origin}

Brad asked: "${ctx.message}"`,
  });
  return reply(text);
}

/* ---------------- REMINDER ---------------- */

async function extractReminder(message) {
  const currentPhoenix = new Date().toLocaleString("en-US", {
    timeZone: TIME_ZONE,
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const raw = await claudeJson({
    maxTokens: 384,
    system: `Extract reminder details from Brad's message.
Current Phoenix local date/time: ${currentPhoenix}. America/Phoenix is UTC-7 with no DST.

Return ONLY JSON, no preamble:
{"message": "what to remind Brad about (concise)" | null, "remindAt": "YYYY-MM-DD HH:MM in 24-hour Phoenix local time" | null}

Resolve relative times against the current Phoenix date/time above.
- "in 30 minutes" -> add 30 min
- "tomorrow at 3pm" -> next day, 15:00
- "Wednesday at 10am" -> next Wednesday, 10:00
- "tonight at 8" -> today, 20:00`,
    user: message,
  });
  return parseJsonFromClaude(raw);
}

async function handleReminder(ctx) {
  if (!isReminder(ctx.message)) return null;

  const reminder = await extractReminder(ctx.message);
  if (!reminder?.message || !reminder?.remindAt) {
    return reply("When and what should I remind you about?");
  }

  const phoenixIso = `${reminder.remindAt.replace(" ", "T")}:00-07:00`;
  const remindDate = new Date(phoenixIso);
  if (Number.isNaN(remindDate.getTime())) {
    return reply("I had trouble saving that reminder, please try again.");
  }

  console.log(`Saving reminder: "${reminder.message}" at ${phoenixIso}`);
  let data;
  try {
    const res = await fetch(`${BASE_URL}/api/reminders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: reminder.message, remind_at: phoenixIso }),
    });
    data = await res.json();
    if (!res.ok || data.error) {
      console.log("Reminder save FAILED:", data?.error, "| code:", data?.code, "| details:", data?.details, "| hint:", data?.hint);
      return reply("I had trouble saving that reminder, please try again.");
    }
  } catch (e) {
    console.log("Reminder save FAILED (fetch threw):", e.message);
    return reply("I had trouble saving that reminder, please try again.");
  }

  console.log("Reminder saved successfully:", data?.reminder?.id);
  const phoenixLabel = remindDate.toLocaleString("en-US", {
    weekday: "long", hour: "numeric", minute: "2-digit", hour12: true, timeZone: TIME_ZONE,
  });
  return reply(`Done — I'll remind you on ${phoenixLabel} to ${reminder.message}.`);
}

/* ---------------- NORMAL CHAT (fallback) ---------------- */

async function handleNormalChat(ctx) {
  const completion = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: `You are Jess, Brad's executive assistant.

${ANTI_HALLUCINATION_RULE}

Brad's home: ${HOME_ADDRESS}
Brad's shop: ${SHOP_ADDRESS}
Today: ${ctx.today}

Memory:
${ctx.memoryText}

Rules:
- Take action first, ask questions never
- Use conversation history - never ask for info already discussed
- Never guess drive times or traffic - call Google Maps only
- Never re-search calendar if data already in conversation
- For email drafts: show first, wait for approval
- Strip all XML tags from final response
- Keep responses direct and brief

${NO_GUESS_EMAIL_RULE}`,
    messages: [
      ...toAnthropicHistory(ctx.history),
      { role: "user", content: ctx.message },
    ],
  });
  return reply(cleanResponse(completion.content?.[0]?.text || ""));
}

/* ============================================================================
 * 6. ROUTING
 *
 * Order is "first match wins". Check most specific intents first; calendar
 * read is the broadest and runs last among intent handlers.
 * Email-send approval is a tiny stateful path — runs ahead of everything so
 * "send it" after a draft fires the actual send.
 * ========================================================================== */

const HANDLERS = [
  handleEmailSendApproval, // "send it" only when last assistant message is a Draft
  handleReminder,          // "remind me" — must beat departure / calendar
  handleQuote,             // narrow phrase triggers
  handleEmailSend,         // "email Nicole" / "send an email"
  handleEmailRead,         // "read my emails", "any emails from Nicole"
  handleCalendarWrite,     // add / move / delete with calendar context
  handleDeparture,         // when leave / how long / drive time / traffic
  handleCalendarRead,      // what's on / schedule / calendar / today / weekday
];

export async function POST(req) {
  try {
    const { message, history = [] } = await req.json();
    const today = todayPhoenixLabel();

    // Memory housekeeping every turn.
    const coreMemory = await getCoreMemory();
    await saveOrUpdateMemory(message, coreMemory);
    const injectionMemory = await getInjectionMemory(message);
    const memoryText = injectionMemory.length > 0
      ? injectionMemory.map((m) => `- ${stripTag(m.content)}`).join("\n")
      : "";

    const ctx = { message, history, today, memoryText };

    for (const handler of HANDLERS) {
      const result = await handler(ctx);
      if (result) return Response.json(result);
    }
    return Response.json(await handleNormalChat(ctx));
  } catch (error) {
    return Response.json({ reply: "Jess had an issue: " + error.message });
  }
}

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

/* ============================================================================
 * CLIENTS & CONSTANTS
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

const KNOWN_LOCATIONS_CONTEXT = `Brad's key locations:
- Home: ONLY ${HOME_ADDRESS}. No other address is Brad's home.
- Shop: ${SHOP_ADDRESS}.
When Brad refers to "home" or "the shop", these are the addresses he means.
Any other address that appears in calendar events is a DESTINATION (a customer site, venue, or meeting place), never Brad's home.
Never assume Brad is hosting an event just because the location shows a Scottsdale, Phoenix, or any other address — those are places he's going TO, not where he lives.`;

const NEVER_RESEARCH_RULE = `CRITICAL: Never re-search for information already present in the conversation history. If calendar data was already retrieved in this conversation, use it. If Brad references an event already discussed, use that event's details. Never say you can't find something that was already shown in the conversation.`;

const DAYS_PATTERN = /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

/* ============================================================================
 * SHARED HELPERS
 * ========================================================================== */

function toAnthropicHistory(history) {
  const startIdx = history.findIndex((m) => m.role === "user");
  if (startIdx === -1) return [];
  return history.slice(startIdx).map((m) => ({ role: m.role, content: m.content }));
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
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return fallback;
  }
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

async function claudeNarrate({ system, user, maxTokens = 1024 }) {
  const completion = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  return cleanResponse(completion.content?.[0]?.text || "");
}

function reply(text) {
  return { reply: text };
}

function todayPhoenixLabel() {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: TIME_ZONE,
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
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    dates.push(d);
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
  if (target.getTime() <= Date.now()) {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1000);
  }
  return target.toISOString();
}

function formatFriendlyDeparture(departureMs, nowMs) {
  const minutesUntil = Math.round((departureMs - nowMs) / 60000);
  if (minutesUntil <= 0) return "right now";
  if (minutesUntil <= 60) return `in ${minutesUntil} minute${minutesUntil === 1 ? "" : "s"}`;
  const dep = new Date(departureMs);
  const now = new Date(nowMs);
  const tomorrow = new Date(nowMs + 24 * 60 * 60 * 1000);
  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: TIME_ZONE,
  });
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: TIME_ZONE,
  });
  const depDate = dateFmt.format(dep);
  if (depDate === dateFmt.format(now)) return `at ${timeFmt.format(dep)} today`;
  if (depDate === dateFmt.format(tomorrow)) return `tomorrow at ${timeFmt.format(dep)}`;
  const dayName = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: TIME_ZONE }).format(dep);
  return `${dayName} at ${timeFmt.format(dep)}`;
}

/* ---------------- HISTORY-AWARENESS HELPERS ---------------- */

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
  const msg = message.toLowerCase();
  return (
    msg.includes("check my calendar again") ||
    msg.includes("re-check") ||
    msg.includes("refetch") ||
    msg.includes("refresh") ||
    msg.includes("look again") ||
    msg.includes("any new events")
  );
}

function mentionsDifferentDay(message, history) {
  const msgDays = (message.toLowerCase().match(DAYS_PATTERN) || []).map((d) => d.toLowerCase());
  if (msgDays.length === 0) return false;
  const recent = history.slice(-10).map((m) => (m.content || "").toLowerCase()).join(" ");
  return msgDays.some((day) => !recent.includes(day));
}

/* ============================================================================
 * MEMORY MODULE
 * Two categories live in the `memory` Supabase table:
 *   [CORE] = facts (addresses, names, preferences) — never auto-evicted
 *   [LOG]  = action records (calendar updates, sent emails) — first to evict at cap
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
    const { data: oldest } = await supabase
      .from("memory")
      .select("id")
      .not("content", "ilike", "[CORE]%")
      .order("created_at", { ascending: true })
      .limit(1);
    if (oldest && oldest[0]) {
      await supabase.from("memory").delete().eq("id", oldest[0].id);
    } else {
      console.log("[memory] cap reached but no non-CORE memories to evict");
    }
  }
  await supabase.from("memory").insert([{ content }]);
}

async function getCoreMemory() {
  const { data } = await supabase
    .from("memory")
    .select("id, content")
    .ilike("content", "[CORE]%")
    .order("created_at", { ascending: true });
  return data || [];
}

async function getInjectionMemory(message) {
  const { data } = await supabase
    .from("memory")
    .select("id, content, created_at")
    .order("created_at", { ascending: false });
  const all = data || [];
  const core = all.filter(isCoreMemory);
  const nonCore = all.filter((m) => !isCoreMemory(m));

  const keywords = extractKeywords(message);
  const matchesKeyword = (m) =>
    keywords.length > 0 && keywords.some((k) => m.content.toLowerCase().includes(k));

  const result = new Map();
  for (const m of core) {
    if (result.size >= INJECTION_CAP) break;
    result.set(m.id, m);
  }
  for (const m of nonCore) {
    if (result.size >= INJECTION_CAP) break;
    if (result.has(m.id)) continue;
    if (matchesKeyword(m)) result.set(m.id, m);
  }
  let recentCount = 0;
  for (const m of nonCore) {
    if (result.size >= INJECTION_CAP) break;
    if (recentCount >= RECENT_NONCORE_CAP) break;
    if (!result.has(m.id)) {
      result.set(m.id, m);
      recentCount += 1;
    }
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
        content: `
You manage Jess's long-term memory for Brad. The memories below are personal facts (CORE).

Existing memory:
${memoryText}

Return JSON only:
{
  "action": "none" | "insert" | "update",
  "id": "existing id or null",
  "content": "memory fact or null"
}

Rules:
- Save personal facts, preferences, names, addresses, key people, company info.
- Do not save questions, action logs, or transient details.
- Do not duplicate — use update if an existing fact has changed.
- Content must be the bare fact, no tag prefix (the system tags it automatically).
        `,
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
 * REMINDERS
 * ========================================================================== */

function isReminderRequest(message) {
  const msg = message.toLowerCase();
  return (
    msg.includes("remind me") ||
    msg.includes("set a reminder") ||
    msg.includes("set reminder") ||
    msg.includes("don't let me forget") ||
    msg.includes("dont let me forget") ||
    msg.includes("remind brad")
  );
}

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

Return ONLY a JSON object, no preamble:
{
  "message": "what to remind Brad about (concise)" | null,
  "remindAt": "YYYY-MM-DD HH:MM in 24-hour Phoenix local time" | null
}

Resolve relative times against the current Phoenix date/time above.
- "in 30 minutes" -> add 30 min to current Phoenix time
- "tomorrow at 3pm" -> next day, 15:00
- "Wednesday at 10am" -> the next Wednesday, 10:00 (use the most upcoming one)
- "tonight at 8" -> today, 20:00
If only a time is given (e.g. "at 3"), assume the next occurrence in the next 24 hours.

Examples:
- "remind me on Wednesday at 10am to leave for BNI" -> {"message":"leave for BNI","remindAt":"2026-05-06 10:00"}
- "set a reminder in 30 minutes to call Mike" -> {"message":"call Mike","remindAt":"2026-05-04 13:30"}
- "don't let me forget to email John tomorrow at 3" -> {"message":"email John","remindAt":"2026-05-05 15:00"}`,
    user: message,
  });
  return parseJsonFromClaude(raw);
}

async function handleReminder(ctx) {
  if (!isReminderRequest(ctx.message)) return null;

  const reminder = await extractReminder(ctx.message);
  if (!reminder?.message || !reminder?.remindAt) {
    return reply("When and what should I remind you about?");
  }

  const phoenixIso = `${reminder.remindAt.replace(" ", "T")}:00-07:00`;
  const remindDate = new Date(phoenixIso);
  if (Number.isNaN(remindDate.getTime())) {
    console.log("[chat] reminder time unparseable:", reminder.remindAt);
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
      console.log(
        "Reminder save FAILED:",
        data?.error || `status ${res.status}`,
        "| code:", data?.code, "| details:", data?.details, "| hint:", data?.hint
      );
      return reply("I had trouble saving that reminder, please try again.");
    }
  } catch (fetchErr) {
    console.log("Reminder save FAILED (fetch threw):", fetchErr.message);
    return reply("I had trouble saving that reminder, please try again.");
  }

  console.log("Reminder saved successfully:", data?.reminder?.id);

  const phoenixLabel = remindDate.toLocaleString("en-US", {
    weekday: "long", hour: "numeric", minute: "2-digit", hour12: true, timeZone: TIME_ZONE,
  });
  return reply(`Done — I'll remind you on ${phoenixLabel} to ${reminder.message}.`);
}

/* ============================================================================
 * QUOTE
 * ========================================================================== */

function isQuoteRequest(message) {
  const msg = message.toLowerCase();
  return (
    msg.includes("roof quote") || msg.includes("quote for") ||
    msg.includes("need a quote") || msg.includes("request a quote") ||
    msg.includes("send a quote")
  );
}

async function extractQuoteDetails(message) {
  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Extract roof quote details from the message. Return JSON:
{
  "customerName": "full name or null",
  "customerEmail": "email or null",
  "customerAddress": "full address or null",
  "roofMaterial": "Tile" | "Shingle" | "Flat" | null,
  "notes": "any notes or null"
}
Only return Tile, Shingle, or Flat for roofMaterial. If unclear, return null.`,
      },
      { role: "user", content: message },
    ],
  });
  return JSON.parse(result.choices[0].message.content);
}

async function handleQuote(ctx) {
  if (!isQuoteRequest(ctx.message)) return null;

  const extracted = await extractQuoteDetails(ctx.message);
  if (!extracted.customerName || !extracted.customerAddress || !extracted.roofMaterial) {
    return reply("I need a few more details for that quote. Can you give me the customer's full name, address, and roof material (Tile, Shingle, or Flat)?");
  }

  const res = await fetch(`${BASE_URL}/api/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(extracted),
  });
  const data = await res.json();

  if (data.success) {
    return reply(`Done — quote request sent to T&K Roofing for ${extracted.customerName} at ${extracted.customerAddress}. They usually respond in 15-30 minutes. I'll keep an eye on your inbox.`);
  }
  return reply(`Something went wrong submitting the quote: ${data.error}`);
}

/* ============================================================================
 * EMAIL — search / read / summary / email-to-calendar update
 * ========================================================================== */

async function getEmails(all = false) {
  const limit = all ? "50" : "5";
  const res = await fetch(`${BASE_URL}/api/email?limit=${limit}&all=${all}`);
  const data = await res.json();
  return data.emails || [];
}

async function getEmailsBySearch(search, limit = 5, fullBody = false) {
  const params = new URLSearchParams({ search, limit: String(limit) });
  if (fullBody) params.set("full", "true");
  const res = await fetch(`${BASE_URL}/api/email?${params.toString()}`);
  const data = await res.json();
  return data.emails || [];
}

function isEmailQuestion(message) {
  const msg = message.toLowerCase();
  return (
    msg.includes("email") || msg.includes("eamil") || msg.includes("gmail") ||
    msg.includes("inbox") || msg.includes("unread") || msg.includes("messages") ||
    msg.includes("did i get") || msg.includes("any mail") ||
    msg.includes("check mail") || msg.includes("read my")
  );
}

function isEmailSearchQuestion(message) {
  const msg = message.toLowerCase();
  if (msg.includes("email from") || msg.includes("emails from")) return true;
  if (/\b(find|search|look\s+for|look\s+up|check)\s+(?:the\s+|an?\s+|any\s+|my\s+)?emails?\b/.test(msg)) return true;
  if (/\bdid\s+\w+\s+email\b/.test(msg)) return true;
  return false;
}

function isReadEmailQuestion(message, history = []) {
  const msg = message.toLowerCase();
  if (!/\b(read it|read that|read me|read aloud|read out|read the email|read the message)\b/.test(msg)) return false;
  if (/\b(email|emails|message|inbox)\b/.test(msg)) return true;
  const recentText = history.slice(-4).map((m) => m.content || "").join(" ").toLowerCase();
  return /\b(email|emails|message|inbox|from\s+\w+)\b/.test(recentText);
}

function isEmailToCalendarUpdate(message) {
  const msg = message.toLowerCase();
  const hasEmail = msg.includes("email");
  const hasUpdate = /\b(update|change|modify|fix|set)\b/.test(msg);
  const hasCalendar =
    msg.includes("calendar") || msg.includes("event") ||
    msg.includes("appointment") || msg.includes("meeting") ||
    /\b(with|to)\s+the\s+new\b/.test(msg);
  return hasEmail && hasUpdate && hasCalendar;
}

async function extractPersonReference(message) {
  const raw = await claudeJson({
    maxTokens: 256,
    system: `Extract who/what to search for in Brad's email. Return ONLY a JSON object, no preamble:
{
  "personName": "first or full name to search by sender (use exactly what Brad said)" | null,
  "subjectKeyword": "additional keyword to filter (subject or body)" | null
}

Words like "last", "latest", "recent", "any", "the", "an" are NOT names — ignore them.

Examples:
- "find email from Yvonne about BNI" -> {"personName":"Yvonne","subjectKeyword":"BNI"}
- "did Mike email me" -> {"personName":"Mike","subjectKeyword":null}
- "search for email from John about the contract" -> {"personName":"John","subjectKeyword":"contract"}
- "any emails from Sarah" -> {"personName":"Sarah","subjectKeyword":null}
- "last emails from Nicole" -> {"personName":"Nicole","subjectKeyword":null}
- "emails from Nicole" -> {"personName":"Nicole","subjectKeyword":null}
- "show me the last few emails from Mike" -> {"personName":"Mike","subjectKeyword":null}`,
    user: message,
  });
  return parseJsonFromClaude(raw, { personName: null, subjectKeyword: null });
}

async function extractEmailReference(message, history = []) {
  const recentHistory = history.slice(-6);
  const conversationContext = recentHistory.length
    ? recentHistory.map((m) => `${m.role}: ${m.content}`).join("\n")
    : "(no prior turns)";
  const raw = await claudeJson({
    maxTokens: 256,
    system: `Brad just asked you to read an email. Look at the recent conversation to identify which email he's referring to.
Return ONLY a JSON object, no preamble:
{
  "personName": "sender name to search Gmail" | null,
  "subjectKeyword": "keyword in email" | null
}

If history mentions emails from a person, use that person. If multiple people, use the most recently mentioned.

Examples:
- After "emails from Nicole" was just shown, "read me that email" -> {"personName":"Nicole","subjectKeyword":null}
- After "Yvonne emailed about BNI", "read it to me" -> {"personName":"Yvonne","subjectKeyword":"BNI"}
- "read me Brad's last email from Sarah" -> {"personName":"Sarah","subjectKeyword":null}`,
    user: `Recent conversation:\n${conversationContext}\n\nCurrent question: "${message}"`,
  });
  return parseJsonFromClaude(raw, { personName: null, subjectKeyword: null });
}

async function extractEmailToCalendarRequest(message) {
  const raw = await claudeJson({
    maxTokens: 384,
    system: `Brad wants to use info from an email to update a calendar event. Extract the parts.
Return ONLY a JSON object, no preamble:
{
  "personName": "email sender name" | null,
  "subjectKeyword": "keyword in email" | null,
  "eventReference": "1-3 word calendar event title fragment to find" | null,
  "field": "location" | "title" | "time" | "notes" | null
}

Map "address" or "new address" to field "location". Map "new time" to "time". Map "name" to "title".

Examples:
- "find the email from Yvonne about BNI and update my calendar with the new address"
  -> {"personName":"Yvonne","subjectKeyword":"BNI","eventReference":"BNI","field":"location"}
- "use the email from Mike to update the meeting time"
  -> {"personName":"Mike","subjectKeyword":null,"eventReference":"meeting","field":"time"}
- "update the Trunzo job address from John's email"
  -> {"personName":"John","subjectKeyword":null,"eventReference":"Trunzo","field":"location"}`,
    user: message,
  });
  return parseJsonFromClaude(raw);
}

async function extractInfoFromEmail(emailBody, field) {
  const fieldDescriptions = {
    location: "the new street address or location mentioned in this email",
    title: "the new event title or name mentioned",
    time: "the new time or date+time mentioned (return as 'YYYY-MM-DD HH:MM' 24-hour if a date is given, or 'HH:MM' if just a time)",
    notes: "any relevant notes/details Brad would want on the event",
  };
  const desc = fieldDescriptions[field] || `the ${field} mentioned`;
  const raw = await claudeJson({
    maxTokens: 256,
    system: `You extract a single field from an email. Return ONLY a JSON object, no preamble:
{
  "value": "extracted ${field}" | null
}

If the email does not contain ${desc}, return {"value": null}.`,
    user: `Extract ${desc} from this email:\n\n${(emailBody || "").slice(0, 4000)}`,
  });
  return parseJsonFromClaude(raw);
}

async function handleEmailToCalendar(ctx) {
  if (!isEmailToCalendarUpdate(ctx.message)) return null;

  const req = await extractEmailToCalendarRequest(ctx.message);
  if (!req || !req.personName || !req.eventReference || !req.field) {
    return reply("I need a sender name, the event to update, and what to change. Can you give me those?");
  }

  const search = req.subjectKeyword
    ? `from:${req.personName} ${req.subjectKeyword}`
    : `from:${req.personName}`;
  const emails = await getEmailsBySearch(search, 5);
  if (emails.length === 0) {
    return reply(`Couldn't find an email from ${req.personName}${req.subjectKeyword ? ` about ${req.subjectKeyword}` : ""}.`);
  }

  const email = emails[0];
  const info = await extractInfoFromEmail(email.body || "", req.field);
  if (!info?.value) {
    return reply(`Found the email from ${req.personName} but couldn't pull a ${req.field} out of it. Subject: "${email.subject}".`);
  }

  const matches = await findEventsByTitleNext7Days(req.eventReference);
  if (matches.length === 0) {
    return reply(`I found ${req.field} "${info.value}" in ${req.personName}'s email, but couldn't find a "${req.eventReference}" event on your calendar in the next 7 days.`);
  }

  const event = matches[0];
  const patchBody = { eventId: event.id };
  if (req.field === "location") patchBody.location = info.value;
  else if (req.field === "title") patchBody.title = info.value;
  else if (req.field === "notes") patchBody.description = info.value;
  else if (req.field === "time") {
    return reply(`Found new time "${info.value}" for "${event.title}". Time updates from email aren't wired up yet — say "move ${event.title} to ${info.value}" and I can do it.`);
  } else {
    return reply(`Found ${req.field}="${info.value}" but I don't know how to write that field to the calendar yet.`);
  }

  const patchRes = await fetch(`${BASE_URL}/api/calendar/today`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patchBody),
  });
  const patchData = await patchRes.json();
  if (!patchRes.ok || !patchData.success) {
    console.log("[chat] calendar PATCH failed:", patchData.error || patchRes.status);
    return reply("I had trouble updating that, let me try again.");
  }

  // Verify the change actually landed.
  const verifyEvents = await findEventsByTitleNext7Days(req.eventReference);
  const verified = verifyEvents.find((e) => e.id === event.id);
  const expected = info.value;
  const actual =
    req.field === "location" ? verified?.location :
    req.field === "title"    ? verified?.title    : null;
  if (actual !== null && actual !== expected) {
    console.log("[chat] post-PATCH verify mismatch; expected", expected, "got", actual);
    return reply("I had trouble updating that, let me try again.");
  }

  try {
    await insertMemoryWithCap(`[LOG] Updated ${event.title} ${req.field} to ${info.value} on ${ctx.today}`);
  } catch (memErr) {
    console.log("[chat] couldn't save update memory:", memErr.message);
  }

  return reply(`Done — updated "${event.title}" ${req.field} to ${info.value} (from ${req.personName}'s email).`);
}

async function handleEmailRead(ctx) {
  if (!isReadEmailQuestion(ctx.message, ctx.history)) return null;

  const ref = await extractEmailReference(ctx.message, ctx.history);
  if (!ref?.personName) {
    return reply("Which email do you want me to read? Tell me who it's from.");
  }
  const search = ref.subjectKeyword
    ? `from:${ref.personName} ${ref.subjectKeyword}`
    : `from:${ref.personName}`;
  const emails = await getEmailsBySearch(search, 1, true);
  if (emails.length === 0) return reply(`Couldn't find that email from ${ref.personName}.`);

  const email = emails[0];
  return reply(`Email from ${email.from}, ${email.date}.\nSubject: ${email.subject}\n\n${email.body}`);
}

async function handleEmailSearch(ctx) {
  if (!isEmailSearchQuestion(ctx.message)) return null;

  const ref = await extractPersonReference(ctx.message);
  if (!ref?.personName) {
    return reply("Who do you want to search for? Tell me a name like 'find emails from Yvonne'.");
  }
  const search = ref.subjectKeyword
    ? `from:${ref.personName} ${ref.subjectKeyword}`
    : `from:${ref.personName}`;
  const emails = await getEmailsBySearch(search, 5);
  if (emails.length === 0) {
    return reply(`No emails from ${ref.personName}${ref.subjectKeyword ? ` about ${ref.subjectKeyword}` : ""} found.`);
  }

  const emailContext = emails
    .map((e, i) => `${i + 1}. From: ${e.from}\nSubject: ${e.subject}\nDate: ${e.date}\nPreview: ${(e.body || "").slice(0, 300)}`)
    .join("\n\n");

  const text = await claudeNarrate({
    system: `You are Jess, Brad's executive assistant.
Summarize these emails naturally and conversationally — who they're from, when, and what they're about.
If there's only one, give Brad the gist in 1-3 sentences.
No markdown. Be concise.`,
    user: `Brad asked: "${ctx.message}"\n\nMatching emails:\n\n${emailContext}`,
  });
  return reply(text);
}

async function handleEmail(ctx) {
  if (!isEmailQuestion(ctx.message)) return null;

  const all = ctx.message.toLowerCase().includes("all");
  const emails = await getEmails(all);
  if (emails.length === 0) return reply("No unread emails right now.");

  const emailContext = emails
    .map((e, i) => `${i + 1}. From: ${e.from}\nSubject: ${e.subject}\nPreview: ${e.body.slice(0, 200)}`)
    .join("\n\n");

  const text = await claudeNarrate({
    system: `You are Jess, Brad's executive assistant.
Summarize these unread emails naturally and conversationally.
For each one mention who it's from and what it's about in plain English.
Flag anything urgent or from tnkroofing.com as a quote response.
No markdown. Be concise.`,
    user: `Here are Brad's unread emails:\n\n${emailContext}`,
  });
  return reply(text);
}

/* ============================================================================
 * CALENDAR — read / write / shared lookup helpers
 * ========================================================================== */

function isCalendarQuestion(message) {
  const msg = message.toLowerCase();
  return (
    msg.includes("schedule") || msg.includes("calendar") ||
    msg.includes("today") || msg.includes("tomorrow") ||
    msg.includes("monday") || msg.includes("tuesday") ||
    msg.includes("wednesday") || msg.includes("thursday") ||
    msg.includes("friday") || msg.includes("saturday") ||
    msg.includes("sunday") || msg.includes("what do i have")
  );
}

function isCalendarWrite(message) {
  const msg = message.toLowerCase();
  const writeVerb =
    /\b(add|schedule|create|book|cancel|delete|remove|move|reschedule|push)\b/.test(msg) ||
    msg.includes("set up");
  const calendarHint =
    /\b(meeting|appointment|event|call|lunch|dinner|breakfast|coffee|standup|interview|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(msg) ||
    /\d\s*(am|pm)/.test(msg) || /\bat \d/.test(msg);
  return writeVerb && calendarHint;
}

async function getCalendarForDate(date) {
  const iso = date.toISOString();
  const res = await fetch(`${BASE_URL}/api/calendar/today?date=${encodeURIComponent(iso)}`);
  const data = await res.json();
  if (!data.events || data.events.length === 0) {
    return { label: formatDateLabel(date), text: "No events scheduled." };
  }
  const text = data.events
    .map((e) => `${e.time} — ${e.title}${e.location ? ` — ${e.location}` : ""}`)
    .join("\n");
  return { label: formatDateLabel(date), text };
}

async function findEventByCriteria({ date, time, title }) {
  if (!date && !title) return [];
  const dateObj = date ? new Date(`${date}T12:00:00`) : new Date();
  const res = await fetch(
    `${BASE_URL}/api/calendar/today?date=${encodeURIComponent(dateObj.toISOString())}`
  );
  const data = await res.json();
  const events = data.events || [];
  return events.filter((event) => {
    if (time && getPhoenixHHMM(event.start) !== time) return false;
    if (title && !(event.title || "").toLowerCase().includes(title.toLowerCase())) return false;
    return true;
  });
}

async function findEventsByTitleNext7Days(title) {
  const params = new URLSearchParams({ days: "7", searchTitle: title });
  const res = await fetch(`${BASE_URL}/api/calendar/today?${params.toString()}`);
  const data = await res.json();
  return data.events || [];
}

async function extractEventDetails(message) {
  const todayLabel = todayPhoenixLabel();
  const raw = await claudeJson({
    maxTokens: 1024,
    system: `You convert natural-language calendar commands into JSON.

Today is ${todayLabel} (America/Phoenix timezone).

Return ONLY a single JSON object. No preamble, no code fence, no extra text. The shape:
{
  "action": "add" | "delete" | "move" | "none",
  "title": "event title or null",
  "date": "YYYY-MM-DD or null (for add/delete; for move this is the OLD date)",
  "time": "HH:MM 24-hour or null (for add/delete; for move this is the OLD time)",
  "newDate": "YYYY-MM-DD or null (only for move)",
  "newTime": "HH:MM 24-hour or null (only for move)",
  "durationMinutes": "integer or null",
  "location": "string or null"
}

Rules:
- Resolve relative dates (today, tomorrow, weekday names) to absolute YYYY-MM-DD
- Convert times to 24-hour HH:MM. "2pm" -> "14:00", "10:30am" -> "10:30"
- For "add": title, date, and time are required. If user is asking a question (read), set action to "none".
- For "delete": at least one of date, time, or title must identify the event
- For "move": (date+time OR title) identifies the event; provide newDate and/or newTime
- If the user is asking what's on their calendar (read intent), return action "none"
- If unclear or not a calendar action, return action "none"`,
    user: message,
  });
  return parseJsonFromClaude(raw, { action: "none" });
}

async function handleCalendarWrite(ctx) {
  if (!isCalendarWrite(ctx.message)) return null;

  const details = await extractEventDetails(ctx.message);

  if (details.action === "add") {
    if (!details.title || !details.date || !details.time) {
      return reply("I need a title, date, and time to add that. Can you give me all three?");
    }
    const start = { date: details.date, time: details.time };
    const durationMinutes = details.durationMinutes || 60;
    const res = await fetch(`${BASE_URL}/api/calendar/today`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: details.title, start, durationMinutes, location: details.location }),
    });
    const data = await res.json();
    if (!data.success) return reply(`Couldn't add that event: ${data.error}`);
    const dayLabel = formatDateLabel(new Date(`${details.date}T12:00:00`));
    return reply(`Done — added "${details.title}" on ${dayLabel} at ${format12Hour(details.time)}.`);
  }

  if (details.action === "delete") {
    const matches = await findEventByCriteria({ date: details.date, time: details.time, title: details.title });
    if (matches.length === 0) return reply("Couldn't find an event matching that. Can you be more specific?");
    if (matches.length > 1) {
      const summary = matches.map((e) => `${e.time} ${e.title}`).join(", ");
      return reply(`Found multiple matches: ${summary}. Which one should I delete?`);
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
    if (matches.length === 0) return reply("Couldn't find an event matching that. Can you be more specific?");
    if (matches.length > 1) {
      const summary = matches.map((e) => `${e.time} ${e.title}`).join(", ");
      return reply(`Found multiple matches: ${summary}. Which one should I move?`);
    }
    const event = matches[0];
    const startMs = new Date(event.start).getTime();
    const endMs = new Date(event.end).getTime();
    const durationMinutes = Math.max(15, Math.round((endMs - startMs) / 60000));
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

    const dayLabel = formatDateLabel(new Date(`${newDate}T12:00:00`));
    return reply(`Done — moved "${event.title}" to ${format12Hour(newTime)} on ${dayLabel} (was ${event.time}).`);
  }

  // action === "none" — fall through to other handlers
  return null;
}

async function handleCalendarRead(ctx) {
  if (!isCalendarQuestion(ctx.message)) return null;

  // If history already shows a schedule and Brad isn't asking to refresh or for a new day,
  // fall through so normal chat answers from history without a fresh API hit.
  if (
    historyHasCalendarData(ctx.history) &&
    !isExplicitCalendarRefresh(ctx.message) &&
    !mentionsDifferentDay(ctx.message, ctx.history)
  ) {
    return null;
  }

  const dates = getDetectedDates(ctx.message);
  const schedules = await Promise.all(dates.map(getCalendarForDate));
  const calendarContext = schedules.map((s) => `${s.label}:\n${s.text}`).join("\n\n");

  const text = await claudeNarrate({
    system: `You are Jess, Brad's executive assistant.
Today is ${ctx.today}. Always use this as your reference for current date. Never reference events from wrong years.
Rules:
- Be direct and conversational, like a real assistant briefing their boss
- Summarize the schedule naturally, don't just list it robotically
- Mention the time and title of each event
- If there's a location, mention it naturally
- No markdown formatting
- Keep it tight — Brad is busy
- When reading calendar events, NEVER assume Brad is the host or that the event location is his home. Any address in a calendar event is always a DESTINATION Brad is traveling TO, never his home address.`,
    user: `Here is Brad's calendar data:\n\n${calendarContext}\n\nHis question was: "${ctx.message}"`,
  });
  return reply(text);
}

/* ============================================================================
 * DEPARTURE & ARRIVAL TARGET
 * ========================================================================== */

function detectOrigin(message) {
  const msg = message.toLowerCase();
  if (msg.includes("from the shop") || msg.includes("from shop")) return SHOP_ADDRESS;
  if (msg.includes("from home") || msg.includes("from my house")) return HOME_ADDRESS;
  return HOME_ADDRESS;
}

function isDepartureQuestion(message) {
  const msg = message.toLowerCase();
  const phrases = [
    "when do i need to leave","when should i leave","when do i leave","should i leave",
    "what time should i leave","what time do i leave","time should i leave",
    "do i need to leave","time to leave","leave now","leave for","leave by","leave my house",
    "how long until","how long will it take","how long would it take","how long does it take",
    "how long to get","how long to drive","how long from",
    "drive time","driving time","travel time",
    "how far is","how far away","distance to",
    "how's traffic","hows traffic","how is traffic","what's traffic","whats traffic",
    "am i going to be late","going to be late","make it to","get there on time","get there in time",
  ];
  if (phrases.some((p) => msg.includes(p))) return true;
  if (
    /\bnext (appointment|event|meeting|job|stop)\b/.test(msg) &&
    /\b(leave|get|drive|long|time|far|until)\b/.test(msg)
  ) return true;
  const fromKnown =
    msg.includes("from home") || msg.includes("from my house") ||
    msg.includes("from the shop") || msg.includes("from shop");
  if (
    fromKnown &&
    /\b(to|drive|driving|long|far|appointment|job|next|meeting|event|going|traffic)\b/.test(msg)
  ) return true;
  if (
    msg.includes("traffic") &&
    /\b(appointment|next|meeting|job|event|drive|driving|destination)\b/.test(msg)
  ) return true;
  return false;
}

function isArrivalTargetQuestion(message) {
  const msg = message.toLowerCase();
  const arrivalPattern = /\b(need to|have to|gotta|got to|i need to|i have to)\s+(?:be|get|make it)\s+(?:at|to|in|there|by)\b/;
  if (!arrivalPattern.test(msg)) return false;
  return /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/.test(msg);
}

async function extractDepartureContext(message, history = []) {
  const recentHistory = history.slice(-10);
  const conversationContext = recentHistory.length
    ? recentHistory.map((m) => `${m.role}: ${m.content}`).join("\n")
    : "(no prior turns)";
  const raw = await claudeJson({
    maxTokens: 384,
    system: `Brad is asking about departure / travel timing for a calendar event.

Look at the recent conversation. If history already shows the event's location AND start time, return them so we can skip looking up the calendar.

Return ONLY a single JSON object. No preamble, no code fence, no extra text:
{
  "eventReference": "1-3 word title fragment to search calendar by" | null,
  "knownLocation": "exact location string copied from history (full address if visible)" | null,
  "knownArrivalTime": "HH:MM 24-hour Phoenix" | null
}

If the event is named but the conversation does not include both a location and a time, set knownLocation/knownArrivalTime to null and just return eventReference.
If Brad is asking generically without naming an event, set eventReference to null too.

Examples:
- After "9 AM BNI at Rudy's BBQ 15257 N Northsight Blvd" in history, "when should I leave" -> {"eventReference":"BNI","knownLocation":"Rudy's BBQ 15257 N Northsight Blvd","knownArrivalTime":"09:00"}
- "what time should I leave for the shrimp boil tonight" with no prior context -> {"eventReference":"shrimp boil","knownLocation":null,"knownArrivalTime":null}
- "how long until I get to my next appointment" -> {"eventReference":null,"knownLocation":null,"knownArrivalTime":null}
- "should I leave for the Trunzo job" -> {"eventReference":"trunzo","knownLocation":null,"knownArrivalTime":null}`,
    user: `Recent conversation:\n${conversationContext}\n\nCurrent question: "${message}"`,
  });
  return parseJsonFromClaude(raw, { eventReference: null, knownLocation: null, knownArrivalTime: null });
}

async function extractArrivalTarget(message) {
  const raw = await claudeJson({
    maxTokens: 256,
    system: `Brad just told you a place he needs to be and a time. Extract them.

Brad's locations:
- "desk", "the desk", "office", "the office", "shop", "the shop" -> the SHOP
- "home", "house", "my house" -> HOME

Return ONLY a single JSON object, no preamble:
{
  "destinationKey": "shop" | "home" | "other",
  "destinationLiteral": "the literal place name if destinationKey is 'other'" | null,
  "arrivalTime": "HH:MM 24-hour Phoenix"
}

Examples:
- "I need to be at my desk at 8:45" -> {"destinationKey":"shop","destinationLiteral":null,"arrivalTime":"08:45"}
- "I have to be at the office by 9" -> {"destinationKey":"shop","destinationLiteral":null,"arrivalTime":"09:00"}
- "I need to be home by 6 PM" -> {"destinationKey":"home","destinationLiteral":null,"arrivalTime":"18:00"}
- "I need to be at Rudy's BBQ at 7" -> {"destinationKey":"other","destinationLiteral":"Rudy's BBQ","arrivalTime":"07:00"}`,
    user: message,
  });
  return parseJsonFromClaude(raw);
}

async function callMapsForDeparture({ origin, destination, arrivalIso }) {
  const params = new URLSearchParams({ origin, destination, arrivalTime: arrivalIso });
  const res = await fetch(`${BASE_URL}/api/maps?${params.toString()}`);
  const data = await res.json();
  if (!res.ok || data.error) {
    return { error: data.error || `maps API returned ${res.status}` };
  }
  return data;
}

async function handleArrivalTarget(ctx) {
  if (!isArrivalTargetQuestion(ctx.message)) return null;

  const target = await extractArrivalTarget(ctx.message);
  if (!target?.arrivalTime) return null; // fall through to departure / normal chat

  const origin = detectOrigin(ctx.message);
  const destination =
    target.destinationKey === "shop" ? SHOP_ADDRESS :
    target.destinationKey === "home" ? HOME_ADDRESS :
    target.destinationLiteral || SHOP_ADDRESS;

  const arrivalIso = buildPhoenixIsoFromTimeToday(target.arrivalTime);
  const maps = await callMapsForDeparture({ origin, destination, arrivalIso });
  if (maps.error) {
    console.log("[chat] arrival-target maps error:", maps.error);
    return reply("I'm having trouble reaching Google Maps right now - try again in a moment.");
  }

  const arrivalMs = new Date(arrivalIso).getTime();
  const driveMin = maps.driveTimeMinutes;
  const trafficMin = maps.trafficDelayMinutes;
  const departureMs = arrivalMs - (driveMin + 10) * 60 * 1000;
  const friendly = formatFriendlyDeparture(departureMs, Date.now());
  const arrivalLabel = new Date(arrivalIso).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: TIME_ZONE,
  });
  const trafficNote = trafficMin >= 5 ? ` Traffic is adding about ${trafficMin} minutes.` : "";
  return reply(`Leave ${friendly} to make ${arrivalLabel} at ${destination} — ${driveMin} minutes from where you are.${trafficNote}`);
}

async function handleDeparture(ctx) {
  if (!isDepartureQuestion(ctx.message)) return null;

  const origin = detectOrigin(ctx.message);
  const dctx = await extractDepartureContext(ctx.message, ctx.history);
  console.log("[chat] departure detected; origin:", origin, "ctx:", JSON.stringify(dctx), "message:", ctx.message);

  // Fast path: history already has both location and arrival time. Skip /api/departure.
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

  // Slow path: hit /api/departure (which queries calendar + maps).
  let data;
  try {
    const params = new URLSearchParams({ origin });
    if (dctx.eventReference) params.set("eventQuery", dctx.eventReference);
    const res = await fetch(`${BASE_URL}/api/departure?${params.toString()}`);
    data = await res.json();
    console.log("[chat] departure response:", JSON.stringify(data));
    if (!res.ok && !data?.error) {
      data = { error: `departure API returned status ${res.status}` };
    }
  } catch (fetchErr) {
    console.log("[chat] departure fetch threw:", fetchErr.message);
    return reply("I'm having trouble reaching Google Maps right now - try again in a moment.");
  }

  if (data.noEventMatch) {
    return reply(`I don't see an event matching "${data.query}" on your calendar in the next 7 days.`);
  }
  if (data.noEvent) {
    return reply("You don't have an upcoming event with a location in the next 24 hours.");
  }
  if (data.error) {
    console.log("[chat] departure surfaced error:", data.error);
    return reply("I'm having trouble reaching Google Maps right now - try again in a moment.");
  }

  const eventTimeLabel = new Date(data.event.start).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: TIME_ZONE,
  });

  const text = await claudeNarrate({
    system: `You are Jess, Brad's executive assistant.
Narrate departure timing naturally — like a real assistant briefing him.
USE THESE EXACT NUMBERS — do not estimate, recompute, or do math. Use the values verbatim.

Rules:
- Lead with WHEN to leave, using "Friendly departure time" verbatim (e.g., "right now", "in 12 minutes", "tomorrow at 8:35 AM").
- State the drive time in minutes. State the traffic delay only if it is 5 minutes or more.
- Mention the destination by event title and/or location.
- One or two sentences. No markdown. No bullet lists.`,
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

/* ============================================================================
 * NORMAL CHAT (fallback)
 * ========================================================================== */

async function handleNormalChat(ctx) {
  const completion = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: `You are Jess, Brad's executive assistant.

Today is ${ctx.today}. Always use this as your reference for current date. Never reference events from wrong years.

${NEVER_RESEARCH_RULE}

${KNOWN_LOCATIONS_CONTEXT}

Memory:
${ctx.memoryText}

CORE RULES:
- ALWAYS take action first, explain after if needed
- NEVER ask clarifying questions if you have enough context to act
- If Brad mentions an event, person, or email - go find it immediately without asking
- If Brad says 'find it' or 'look it up' - search his calendar and email right away
- If Brad asks about travel time - immediately call Google Maps, never ask for more info
- Chain actions automatically: if finding an email leads to a calendar update, do both
- Be direct and brief - one or two sentences max unless reading an email or calendar
- Never say 'I need more context' or 'Can you give me more details' unless truly impossible to proceed
- If something fails, try another approach before asking Brad
- Brad should never have to repeat himself

WRONG: 'What event are you referring to?'
RIGHT: Look at the calendar, find the most relevant event, act on it.

WRONG: 'Can you give me more details about which meeting?'
RIGHT: Search the calendar for BNI on Wednesday and update it.

Brad is busy. Every unnecessary question wastes his time.`,
    messages: [
      ...toAnthropicHistory(ctx.history),
      { role: "user", content: ctx.message },
    ],
  });
  return reply(cleanResponse(completion.content?.[0]?.text || ""));
}

/* ============================================================================
 * ROUTING
 *
 * Each handler is async (ctx) => { reply } | null.
 * Return null to fall through to the next handler.
 * Order matters — most specific intents first; normal chat is the catch-all.
 * ========================================================================== */

const INTENT_HANDLERS = [
  handleReminder,        // "remind me to leave for BNI" — must beat departure
  handleQuote,           // "send a quote" — narrow trigger
  handleEmailToCalendar, // "find email from X and update calendar"
  handleEmailRead,       // "read me that email" (uses history)
  handleEmailSearch,     // "emails from Nicole"
  handleEmail,           // generic "any unread emails"
  handleCalendarWrite,   // "add/move/cancel an event" (falls through on action=none)
  handleArrivalTarget,   // "I need to be at the shop at 8:45" — beats departure
  handleDeparture,       // "when should I leave"
  handleCalendarRead,    // "what's on my calendar" (falls through if history has it)
];

export async function POST(req) {
  try {
    const { message, history = [] } = await req.json();
    const today = todayPhoenixLabel();

    // Memory housekeeping runs on every turn.
    const coreMemory = await getCoreMemory();
    await saveOrUpdateMemory(message, coreMemory);

    const injectionMemory = await getInjectionMemory(message);
    const memoryText = injectionMemory.length > 0
      ? injectionMemory.map((m) => `- ${stripTag(m.content)}`).join("\n")
      : "";

    const ctx = { message, history, today, memoryText };

    for (const handler of INTENT_HANDLERS) {
      const result = await handler(ctx);
      if (result) return Response.json(result);
    }

    return Response.json(await handleNormalChat(ctx));
  } catch (error) {
    return Response.json({ reply: "Jess had an issue: " + error.message });
  }
}

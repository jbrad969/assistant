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

const HOME = "4139 East Desert Sands Place Chandler AZ";
const SHOP = "4211 East Elwood Street Phoenix AZ";
const TIMEZONE = "America/Phoenix";
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL;
const CLAUDE_MODEL = "claude-sonnet-4-5";

/* ============================================================================
 * INTENT DETECTION — mutually exclusive, evaluated in declared order
 * ========================================================================== */

function isDeleteReminders(msg) {
  return /\b(delete|clear|remove|wipe)\s+(?:all|every)\s+(?:of\s+)?(?:my\s+)?reminders?\b/i.test(msg);
}

function isCheckReminders(msg) {
  const m = msg.toLowerCase();
  if (/\b(delete|clear|remove)\b/.test(m)) return false;
  return (
    m.includes("what reminders") ||
    m.includes("any reminders") ||
    m.includes("show reminders") ||
    m.includes("show my reminders") ||
    m.includes("list reminders") ||
    m.includes("upcoming reminders") ||
    /\bdo (?:i|you) have (?:any )?reminders?\b/.test(m)
  );
}

function isSetReminder(msg) {
  const m = msg.toLowerCase();
  if (isDeleteReminders(msg) || isCheckReminders(msg)) return false;
  return (
    m.includes("remind me") ||
    m.includes("set a reminder") ||
    m.includes("set reminder") ||
    m.includes("don't let me forget") ||
    m.includes("dont let me forget") ||
    m.includes("don't forget") ||
    m.includes("dont forget")
  );
}

function isEmailRead(msg) {
  const m = msg.toLowerCase();
  return (
    /\bread\s+(?:my\s+)?emails?\b/.test(m) ||
    /\bcheck\s+(?:my\s+)?(?:emails?|inbox)\b/.test(m) ||
    /\bany\s+(?:unread\s+|new\s+)?emails?\b/.test(m) ||
    /\bunread\s+emails?\b/.test(m) ||
    /\bemails?\s+from\b/.test(m) ||
    /\bany\s+emails?\s+from\b/.test(m)
  );
}

function isEmailSend(msg) {
  const m = msg.toLowerCase();
  return (
    m.includes("send an email") ||
    m.includes("send email") ||
    m.includes("email to") ||
    /\bemail\s+(her|him|nicole|mike|john|sarah|yvonne)\b/.test(m) ||
    m.includes("draft an email") ||
    m.includes("draft email") ||
    m.includes("write an email") ||
    m.includes("write email") ||
    m.includes("send it") ||
    m.includes("yes send") ||
    m.includes("looks good")
  );
}

function isQuote(msg) {
  const m = msg.toLowerCase();
  return (
    m.includes("roof quote") ||
    m.includes("need a quote") ||
    m.includes("request a quote") ||
    m.includes("send a quote") ||
    m.includes("quote for")
  );
}

function isCalendarWrite(msg) {
  const m = msg.toLowerCase();
  if (m.includes("remind me")) return false;
  const writeVerb = /\b(move|reschedule|delete event|add|cancel meeting|cancel event|create event|book)\b/.test(m);
  const calCtx =
    /\b(meeting|appointment|event|call|lunch|dinner|breakfast|coffee)\b/.test(m) ||
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(m) ||
    /\d\s*(am|pm)/.test(m) || /\bat\s+\d/.test(m);
  return writeVerb && calCtx;
}

function isCalendarRead(msg) {
  const m = msg.toLowerCase();
  if (isSetReminder(msg) || isCalendarWrite(msg) || isCheckReminders(msg)) return false;
  return (
    m.includes("schedule") ||
    m.includes("calendar") ||
    m.includes("what do i have") ||
    m.includes("what's on") ||
    m.includes("whats on") ||
    /\b(today|tomorrow|sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thu|friday|fri|saturday|sat)\b/i.test(m)
  );
}

function isDeparture(msg) {
  const m = msg.toLowerCase();
  return (
    /\bwhen\b.{0,30}\bleave\b/.test(m) ||
    /\bwhat time\b.{0,30}\bleave\b/.test(m) ||
    m.includes("how long to get") ||
    m.includes("how long to drive") ||
    m.includes("how long until") ||
    m.includes("drive time") ||
    m.includes("travel time") ||
    /\btraffic\s+to\b/.test(m) ||
    m.includes("should i leave")
  );
}

/* ============================================================================
 * SYSTEM PROMPT
 * ========================================================================== */

function buildSystemPrompt(today, memoryText) {
  return `You are Jess, Brad's executive assistant.
Today: ${today}
Brad's home: ${HOME}
Brad's shop: ${SHOP}

Memory:
${memoryText || "No memories yet."}

ABSOLUTE RULES:
1. NEVER hallucinate. No data = say "I don't have that information"
2. NEVER guess locations, addresses, times, or email addresses
3. NEVER ask for info already in the conversation
4. NEVER confirm success without verifying API response
5. Only use emails from actual API responses
6. Only use locations from actual calendar location fields
7. Empty attendees array = "No attendees listed in the invite"
8. Be direct and brief. No fluff. No markdown. No bullet symbols in plain text.
9. Never say "When and what should I remind you about" if context exists
10. Chain actions automatically

TOOLS YOU HAVE:
You have access to Google Maps via the /api/maps route. ALWAYS use it for drive time questions. NEVER say you cannot calculate drive times. NEVER say you don't have mapping tools. You absolutely do.

CRITICAL: Read the ENTIRE conversation history before responding. The history contains everything Brad has told you. If Brad references something from earlier in the conversation, it is in your history - find it and use it. Never ask for information that appears anywhere in the conversation history.`;
}

/* ============================================================================
 * SHARED HELPERS
 * ========================================================================== */

function cleanResponse(text) {
  if (!text) return text;
  return text
    .replace(/<\/?attempt_completion>/g, "")
    .replace(/<\/?function_calls>/g, "")
    .replace(/<\/?search_calendar>/g, "")
    .replace(/<\/?create_reminder>/g, "")
    .replace(/<\/?search_reminders>/g, "")
    .replace(/<\/?delete_calendar_event>/g, "")
    .replace(/<\/?google_maps_directions>/g, "")
    .replace(/```json[\s\S]*?```/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "")
    .replace(/<[^>]+\/>/g, "")
    .trim();
}

function getNextDay(dayIndex) {
  const now = new Date();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const phoenixDayName = now.toLocaleDateString("en-US", { weekday: "long", timeZone: TIMEZONE });
  const phoenixDay = dayNames.indexOf(phoenixDayName);
  const phoenixDateStr = now.toLocaleDateString("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: TIMEZONE,
  });
  const diff = (dayIndex + 7 - phoenixDay) % 7 || 7;
  const startMs = new Date(`${phoenixDateStr}T00:00:00-07:00`).getTime();
  return new Date(startMs + diff * 24 * 60 * 60 * 1000);
}

function getDetectedDates(message) {
  const msg = message.toLowerCase();
  const today = new Date();
  const dates = [];
  if (/\btoday\b/i.test(msg)) dates.push(new Date(today));
  if (/\btomorrow\b/i.test(msg)) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    dates.push(d);
  }
  const dayMap = [
    { regex: /\bsunday\b|\bsun\b/i,                     idx: 0 },
    { regex: /\bmonday\b|\bmon\b/i,                     idx: 1 },
    { regex: /\btuesday\b|\btues\b|\btue\b/i,           idx: 2 },
    { regex: /\bwednesday\b|\bwed\b/i,                  idx: 3 },
    { regex: /\bthursday\b|\bthurs\b|\bthur\b|\bthu\b/i, idx: 4 },
    { regex: /\bfriday\b|\bfri\b/i,                     idx: 5 },
    { regex: /\bsaturday\b|\bsat\b/i,                   idx: 6 },
  ];
  for (const { regex, idx } of dayMap) {
    if (regex.test(msg)) dates.push(getNextDay(idx));
  }
  if (dates.length === 0) dates.push(today);
  return dates;
}

function formatDateLabel(date) {
  return date.toLocaleDateString("en-US", {
    weekday: "long", month: "short", day: "numeric", timeZone: TIMEZONE,
  });
}

/* ============================================================================
 * MEMORY (Supabase `memory` table; [CORE] = facts, [LOG] = action records)
 * ========================================================================== */

const MEMORY_CAP = 500;

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
    }
  }
  await supabase.from("memory").insert([{ content }]);
}

async function getMemory() {
  // Returns all CORE memories (personal facts) with tag stripped for prompt injection.
  const { data } = await supabase
    .from("memory")
    .select("id, content")
    .ilike("content", "[CORE]%")
    .order("created_at", { ascending: true });
  return (data || []).map((m) => ({
    id: m.id,
    content: m.content.replace(/^\[CORE\]\s*/, ""),
  }));
}

async function saveOrUpdateMemory(message, currentMemory) {
  const memoryText = currentMemory.length > 0
    ? currentMemory.map((m) => `ID: ${m.id} | ${m.content}`).join("\n")
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
    const tagged = action.content.startsWith("[") ? action.content : `[CORE] ${action.content}`;
    await supabase.from("memory").update({ content: tagged }).eq("id", action.id);
  }
}

/* ============================================================================
 * API HELPERS — reminders / calendar / maps / email
 * ========================================================================== */

async function saveReminder(message, remindAt) {
  const res = await fetch(`${BASE_URL}/api/reminders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, remind_at: remindAt }),
  });
  const data = await res.json();
  console.log("Reminder save result:", JSON.stringify(data));
  return data;
}

async function getReminders() {
  const res = await fetch(`${BASE_URL}/api/reminders`);
  const data = await res.json();
  return data.reminders || [];
}

async function deleteAllReminders() {
  const res = await fetch(`${BASE_URL}/api/reminders`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deleteAll: true }),
  });
  const data = await res.json();
  console.log("Delete reminders result:", JSON.stringify(data));
  return data;
}

async function getCalendar(date) {
  const iso = (date instanceof Date ? date : new Date(date)).toISOString();
  const res = await fetch(`${BASE_URL}/api/calendar/today?date=${encodeURIComponent(iso)}`);
  const data = await res.json();
  console.log("Calendar data:", JSON.stringify(data).slice(0, 600));
  return data;
}

async function updateCalendarEvent(eventId, updates) {
  const res = await fetch(`${BASE_URL}/api/calendar/today`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventId, ...updates }),
  });
  const data = await res.json();
  console.log("Calendar update result:", JSON.stringify(data));
  if (!data.success) {
    return { success: false, error: data.error || "Update failed" };
  }
  return data;
}

async function deleteCalendarEvent(eventId) {
  const res = await fetch(`${BASE_URL}/api/calendar/today`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventId }),
  });
  const data = await res.json();
  console.log("Calendar delete result:", JSON.stringify(data));
  return data;
}

async function getDriveTime(origin, destination) {
  const params = new URLSearchParams({ origin, destination });
  const res = await fetch(`${BASE_URL}/api/maps?${params.toString()}`);
  const data = await res.json();
  console.log("Maps result:", JSON.stringify(data));
  if (data.error) return null;
  return data;
}

async function getEmails(search = null, limit = 5) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (search) params.append("search", search);
  const res = await fetch(`${BASE_URL}/api/email?${params.toString()}`);
  const data = await res.json();
  return data.emails || [];
}

async function sendEmail(to, subject, body) {
  const res = await fetch(`${BASE_URL}/api/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to, subject, body }),
  });
  const data = await res.json();
  console.log("Email send result:", JSON.stringify(data));
  return data;
}

/* ============================================================================
 * EXTRACTORS (use OpenAI for structured JSON only)
 * ========================================================================== */

async function extractReminderDetails(message, history) {
  const context = history.slice(-5).map((m) => `${m.role}: ${m.content}`).join("\n");
  const todayIso = new Date().toISOString();
  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Extract reminder details. Today is ${todayIso}.

Phoenix AZ timezone is always UTC-7 (no daylight saving time ever). To convert Phoenix time to UTC, add 7 hours. Wednesday May 6 2026 at 7:45 AM Phoenix = 2026-05-06T14:45:00Z. Always output the remind_at as a UTC ISO string.

Examples:
- "remind me Wednesday at 7:45 AM" -> {"time": "2026-05-06T14:45:00Z", ...}  (7:45 AM Phoenix = 14:45 UTC)
- "remind me at 10 AM tomorrow" -> add 7 hours to Phoenix 10:00 -> "...T17:00:00Z"
- "remind me at 8 PM tonight" -> Phoenix 20:00 -> next day 03:00 UTC ("...T03:00:00Z" of the next date)

Return JSON: {"message": "what to remind Brad about (concise)", "time": "UTC ISO timestamp ending in Z"}

Write the reminder message in first person as an action, not as "Remind Brad to..." or "Brad needs to...".
Examples:
WRONG: "Remind Brad to leave the shop for BNI"
RIGHT: "Leave the shop for BNI"
WRONG: "Brad needs to call Nicole"
RIGHT: "Call Nicole"
WRONG: "Reminder for Brad to email Yvonne"
RIGHT: "Email Yvonne"

If day mentioned without year, use 2026.
If the conversation already establishes time/topic for the reminder, reuse them — do not ask.`,
      },
      {
        role: "user",
        content: `Conversation context:\n${context || "(none)"}\n\nLatest message: ${message}`,
      },
    ],
  });
  return JSON.parse(result.choices[0].message.content);
}

async function extractQuoteDetails(message) {
  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Extract roof quote details. Return JSON:
{"customerName": "full name or null", "customerEmail": "email or null", "customerAddress": "full address or null", "roofMaterial": "Tile" | "Shingle" | "Flat" | null, "notes": "any notes or null"}
Only Tile/Shingle/Flat for roofMaterial. If unclear, null.`,
      },
      { role: "user", content: message },
    ],
  });
  return JSON.parse(result.choices[0].message.content);
}

/* ============================================================================
 * DEPARTURE HELPERS
 * ========================================================================== */

function detectDepartureOrigin(message) {
  const m = message.toLowerCase();
  if (m.includes("from the shop") || m.includes("from shop")) return SHOP;
  if (m.includes("from home") || m.includes("from my house")) return HOME;
  return HOME; // default
}

// Extract the event Brad is departing for. Requires an explicit travel-verb prefix so
// "when do I need to leave" returns null and "leave for BNI" returns "BNI" (not "leave for BNI").
function extractEventNameFromDeparture(message) {
  const trigger = /\b(?:leave\s+(?:for|to)|leaving\s+(?:for|to)|head(?:ing)?\s+(?:for|to|over\s+to|out\s+(?:to|for))|go(?:ing)?\s+(?:to|over\s+to)|driv(?:e|ing)\s+(?:to|over\s+to)|get(?:ting)?\s+to)\s+(?:the\s+|my\s+)?([\w&'\-][\w &'\-]{0,40}?)(?:\s+meeting|\s+event|\s+appointment|\s+job|\s+at\b|\s+by\b|[?.,!]|$)/i;
  const match = message.match(trigger);
  if (!match) return null;
  let candidate = match[1].trim();
  candidate = candidate.replace(/^(the|my)\s+/i, "");
  if (!candidate) return null;
  if (/^next\b/i.test(candidate)) return null;
  if (candidate.split(/\s+/).length > 5) return null;
  return candidate;
}

// Scan the last 10 assistant messages for a "<eventName>... at <location>" pattern.
// Returns the captured location string or null.
function findEventLocationInHistory(eventName, history) {
  if (!eventName) return null;
  const needle = eventName.toLowerCase();
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (turn.role !== "assistant") continue;
    const lines = (turn.content || "").split("\n");
    for (const line of lines) {
      const idx = line.toLowerCase().indexOf(needle);
      if (idx === -1) continue;
      const after = line.slice(idx + needle.length);
      // Match " at <location>" up to "(attendees:" or end of line
      const atMatch = after.match(/\s+at\s+([^(\n]+?)(?:\s+\(attendees|$)/i);
      if (atMatch) return atMatch[1].trim().replace(/[.,;]\s*$/, "");
    }
  }
  return null;
}

// Tolerant draft parser. Handles:
//   - "To: x@y\nSubject: z\n\nbody..."
//   - "To: x@y\nSubject: z\nBody:\nbody..."
//   - "To: x@y\nSubject: z\nbody..."   (single newline before body)
// Trailing markers like "Send it?" / "---" are stripped from the body.
function parseEmailDraft(text) {
  if (!text) return null;
  const toMatch = text.match(/^\s*To:\s*(.+?)\s*$/im);
  const subjMatch = text.match(/^\s*Subject:\s*(.+?)\s*$/im);
  if (!toMatch || !subjMatch) return null;

  const to = toMatch[1].trim().replace(/^[<"']|[>"']$/g, "");
  const subject = subjMatch[1].trim();

  // Body = everything after the Subject line, with optional "Body:" label removed,
  // and any trailing approval marker cut. Do NOT split on bare blank lines — bodies
  // legitimately contain paragraph breaks.
  const subjEnd = subjMatch.index + subjMatch[0].length;
  let bodyRaw = text.slice(subjEnd);
  bodyRaw = bodyRaw.replace(/^\s*Body:\s*\n?/i, "");
  bodyRaw = bodyRaw.split(/\n\s*(?:Send it\?|Shall I send|---)/i)[0];
  bodyRaw = bodyRaw.replace(/\n*Send it\?\s*$/i, "").trim();

  if (!to || !subject || !bodyRaw) return null;
  return { to, subject, body: bodyRaw };
}

// True when every day-name Brad mentions in the current message already appears in the
// last 10 turns of conversation — i.e. that day's schedule has been retrieved and Claude
// can answer from history without re-calling /api/calendar/today.
function calendarAlreadyInHistory(message, history) {
  const days = message.toLowerCase().match(/\b(today|tomorrow|sun|mon|tue|tues|wed|thu|thurs|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g) || [];
  if (days.length === 0) return false;
  const recent = history.slice(-10).map((m) => m.content || "").join("\n").toLowerCase();
  return days.every((d) => recent.includes(d));
}

function isExplicitCalendarRefresh(message) {
  const m = message.toLowerCase();
  return /\b(check (?:my )?calendar again|refresh|look again|any new events|re-?check|refetch)\b/.test(m);
}

// Scan the last 5 messages for a US street-style address. Returns the most recent match
// (e.g. "2828 North PECO Drive", "15257 N Northsight Blvd", "5045 E Yale Street").
function findRecentAddressInHistory(history) {
  const recent = history.slice(-5);
  const addressRegex =
    /\b\d{2,5}\s+[\w'.\- ]+?\s+(?:Dr|Drive|St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Ln|Lane|Way|Pl|Place|Ct|Court|Pkwy|Parkway|Cir|Circle|Hwy|Highway|Ter|Terrace)\.?\b/gi;
  for (let i = recent.length - 1; i >= 0; i--) {
    const content = recent[i].content || "";
    const matches = content.match(addressRegex);
    if (matches && matches.length > 0) {
      // Take the LAST match in the most recent message — the freshest reference.
      return matches[matches.length - 1].trim();
    }
  }
  return null;
}

// Scan current message + last 5 history messages for an "at <time>" / "by <time>" pattern.
function findArrivalTimeInContext(message, history) {
  const sources = [message, ...history.slice(-5).map((m) => m.content || "")];
  for (const text of sources) {
    const match = text.match(/\b(?:at|by)\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm))/);
    if (match) return match[1].trim();
  }
  return null;
}

// Convert "8:30 AM" plus today's Phoenix date to an absolute UTC ISO. If the time has already
// passed today, push to tomorrow.
function arrivalIsoForTodayTime(timeText) {
  const m = timeText.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM|am|pm)/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = m[2] ? parseInt(m[2], 10) : 0;
  const period = m[3].toUpperCase();
  if (period === "PM" && hh < 12) hh += 12;
  if (period === "AM" && hh === 12) hh = 0;
  const phoenixDate = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: TIMEZONE,
  }).format(new Date());
  let target = new Date(`${phoenixDate}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00-07:00`);
  if (target.getTime() <= Date.now()) target = new Date(target.getTime() + 24 * 60 * 60 * 1000);
  return target.toISOString();
}

// Search the calendar by title across the next 7 days. Returns the soonest upcoming match.
async function findUpcomingEventByTitle(eventName) {
  const params = new URLSearchParams({ days: "7", searchTitle: eventName });
  const res = await fetch(`${BASE_URL}/api/calendar/today?${params.toString()}`);
  const data = await res.json();
  if (!res.ok || data.error) {
    console.log(`[departure] calendar search by title failed: ${data?.error || res.status}`);
    return null;
  }
  const events = (data.events || [])
    .filter((e) => new Date(e.start).getTime() > Date.now())
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return events[0] || null;
}

/* ============================================================================
 * POST HANDLER — intent dispatcher
 * ========================================================================== */

export async function POST(req) {
  try {
    const { message, history = [], pendingAction = null } = await req.json();

    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      timeZone: TIMEZONE,
    });

    // Memory housekeeping (always before any intent branch).
    const memory = await getMemory();
    await saveOrUpdateMemory(message, memory);
    const updatedMemory = await getMemory();
    const memoryText = updatedMemory.map((m) => `- ${m.content}`).join("\n");

    const msg = message.toLowerCase();

    // 1. DELETE REMINDERS
    if (isDeleteReminders(msg)) {
      const result = await deleteAllReminders();
      if (result.success) return Response.json({ reply: "Done — all reminders deleted." });
      return Response.json({ reply: "I had trouble deleting reminders: " + (result.error || "unknown") });
    }

    // 2. CHECK REMINDERS
    if (isCheckReminders(msg)) {
      const reminders = await getReminders();
      if (reminders.length === 0) return Response.json({ reply: "No reminders set." });

      const grouped = {};
      reminders.forEach((r) => {
        const day = new Date(r.remind_at).toLocaleDateString("en-US", {
          weekday: "long", month: "short", day: "numeric", timeZone: TIMEZONE,
        });
        if (!grouped[day]) grouped[day] = [];
        const time = new Date(r.remind_at).toLocaleTimeString("en-US", {
          hour: "numeric", minute: "2-digit", timeZone: TIMEZONE,
        });
        grouped[day].push(`${time} — ${r.message}`);
      });

      const reply = Object.entries(grouped)
        .map(([day, items]) => `${day}:\n${items.map((i) => `• ${i}`).join("\n")}`)
        .join("\n\n");
      return Response.json({ reply });
    }

    // 3. SET REMINDER
    if (isSetReminder(msg)) {
      const extracted = await extractReminderDetails(message, history);
      console.log("Extracted reminder:", JSON.stringify(extracted));

      if (!extracted.time || !extracted.message) {
        return Response.json({ reply: "What time and what should I remind you about?" });
      }

      const result = await saveReminder(extracted.message, extracted.time);
      console.log("Save result:", JSON.stringify(result));

      if (result.error) {
        return Response.json({ reply: "I had trouble saving that reminder: " + result.error });
      }

      // Verify by re-fetching: match by id when available, fall back to message text.
      let saved = null;
      try {
        const verify = await getReminders();
        const savedId = result.reminder?.id;
        saved =
          (savedId && verify.find((r) => String(r.id) === String(savedId))) ||
          verify.find((r) => r.message === extracted.message);
      } catch (e) {
        console.log("[chat] reminder verify fetch threw:", e.message);
      }
      if (!saved) {
        console.log("[chat] reminder save returned success but row not found on verify");
        return Response.json({ reply: "I had trouble saving that reminder. Please try again." });
      }

      const displayTime = new Date(extracted.time).toLocaleString("en-US", {
        weekday: "long", hour: "numeric", minute: "2-digit", timeZone: TIMEZONE,
      });
      return Response.json({
        reply: `Done — reminder set for ${displayTime}: ${extracted.message}`,
      });
    }

    // 4. EMAIL READ
    if (isEmailRead(msg)) {
      const searchMatch = msg.match(/from\s+(\w+)/);
      const search = searchMatch ? `from:${searchMatch[1]}` : null;
      const all = msg.includes("all");
      const emails = await getEmails(search, all ? 20 : 5);
      if (emails.length === 0) {
        return Response.json({
          reply: search ? `No emails found from ${searchMatch[1]}.` : "No unread emails.",
        });
      }
      const emailContext = emails
        .map((e, i) =>
          `${i + 1}. From: ${e.from}\nEmail address: ${e.fromEmail || "(unknown)"}\nSender name: ${e.fromName || "(unknown)"}\nSubject: ${e.subject}\nDate: ${e.date}\nBody: ${(e.body || "").slice(0, 300)}`
        )
        .join("\n\n");

      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: buildSystemPrompt(today, memoryText),
        messages: [
          ...history.map((m) => ({ role: m.role, content: m.content })),
          {
            role: "user",
            content: `${message}\n\n--- Email data fetched for this turn ---\n${emailContext}`,
          },
        ],
      });
      return Response.json({ reply: cleanResponse(response.content[0].text) });
    }

    // 5. EMAIL SEND
    if (isEmailSend(msg)) {
      const lastAssistantMsg = history.filter((m) => m.role === "assistant").slice(-1)[0];
      const lastContent = lastAssistantMsg?.content || "";

      // Approval phrases — Brad confirming a draft we already showed.
      const trimmed = msg.trim().replace(/[.!?]+$/, "");
      const APPROVAL_PHRASES = [
        "send it", "yes send", "yes send it", "send", "go", "go ahead",
        "do it", "looks good", "yes", "yep", "yeah", "ok send it", "okay send it",
      ];
      const isDraftApproval = APPROVAL_PHRASES.some(
        (p) => trimmed === p || trimmed.startsWith(p + " ")
      );

      // Detect that the prior assistant turn actually was a draft.
      const lookedLikeDraft = /^\s*To:\s*\S+/im.test(lastContent) && /^\s*Subject:\s*\S+/im.test(lastContent);

      if (isDraftApproval && lookedLikeDraft) {
        const draft = parseEmailDraft(lastContent);
        if (!draft) {
          console.log("[email send] draft approval detected but parse failed; lastContent:\n", lastContent.slice(0, 400));
          return Response.json({
            reply: "I had the draft but couldn't parse the To/Subject/Body cleanly. Tell me again who to send to, the subject, and the body.",
          });
        }

        console.log("SENDING EMAIL to:", draft.to, "subject:", draft.subject);
        const result = await sendEmail(draft.to, draft.subject, draft.body);
        console.log("EMAIL SEND RESULT:", JSON.stringify(result));

        if (result?.success === true) {
          try {
            await insertMemoryWithCap(`[LOG] Sent email to ${draft.to} on ${today}: ${draft.subject}`);
          } catch (e) { console.log("[email send] couldn't log memory:", e.message); }
          return Response.json({ reply: `Email sent to ${draft.to}.` });
        }
        return Response.json({
          reply: "I couldn't send that email: " + (result?.error || "unknown error"),
        });
      }

      // Not an approval (or no draft visible) — have Claude draft a fresh one.
      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: buildSystemPrompt(today, memoryText),
        messages: [
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: message },
        ],
      });
      return Response.json({ reply: cleanResponse(response.content[0].text) });
    }

    // 6. QUOTE
    if (isQuote(msg)) {
      const extracted = await extractQuoteDetails(message);
      if (!extracted.customerName || !extracted.customerAddress || !extracted.roofMaterial) {
        return Response.json({
          reply: "I need the customer's full name, address, and roof material (Tile, Shingle, or Flat) to submit the quote.",
        });
      }
      const res = await fetch(`${BASE_URL}/api/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(extracted),
      });
      const data = await res.json();
      if (data.success) {
        return Response.json({
          reply: `Done — quote sent to T&K Roofing for ${extracted.customerName} at ${extracted.customerAddress}. They'll respond in 15-30 minutes.`,
        });
      }
      return Response.json({ reply: "Quote submission failed: " + (data.error || "unknown") });
    }

    // 7. CALENDAR WRITE
    if (isCalendarWrite(msg)) {
      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system:
          buildSystemPrompt(today, memoryText) +
          "\n\nWhen moving or updating a calendar event, always show what you're about to do and ask Brad to confirm with 'yes do it' before making changes.",
        messages: [
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: message },
        ],
      });
      return Response.json({ reply: cleanResponse(response.content[0].text) });
    }

    // 8. CALENDAR READ
    if (isCalendarRead(msg)) {
      // If the day Brad's asking about was already retrieved earlier in the conversation,
      // skip the fetch — Claude can answer from history. Only re-fetch when Brad explicitly
      // asks ("check my calendar again", "refresh", "any new events", etc.).
      if (calendarAlreadyInHistory(message, history) && !isExplicitCalendarRefresh(message)) {
        console.log("[calendar read] using cached calendar data from history; no fetch");
        const cachedResponse = await anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 1024,
          system: buildSystemPrompt(today, memoryText),
          messages: [
            ...history.map((m) => ({ role: m.role, content: m.content })),
            { role: "user", content: message },
          ],
        });
        return Response.json({ reply: cleanResponse(cachedResponse.content[0].text) });
      }

      const dates = getDetectedDates(message);
      const schedules = await Promise.all(dates.map(getCalendar));

      const calendarContext = schedules
        .map((s, i) => {
          const dayLabel = formatDateLabel(dates[i]);
          if (s.error) return `${dayLabel}:\nCalendar unavailable right now.`;
          const events = s.events || [];
          if (events.length === 0) return `${dayLabel}:\nNo events scheduled.`;
          const lines = events
            .map((e) => {
              const loc = e.location ? ` at ${e.location}` : "";
              const attendeeEmails = (e.attendees || []).map((a) => a.email).filter(Boolean);
              const att = attendeeEmails.length ? ` (attendees: ${attendeeEmails.join(", ")})` : "";
              return `${e.time} — ${e.title}${loc}${att}`;
            })
            .join("\n");
          return `${dayLabel}:\n${lines}`;
        })
        .join("\n\n");

      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: buildSystemPrompt(today, memoryText),
        messages: [
          ...history.map((m) => ({ role: m.role, content: m.content })),
          {
            role: "user",
            content: `${message}\n\n--- Calendar data fetched for this turn ---\n${calendarContext}`,
          },
        ],
      });
      return Response.json({ reply: cleanResponse(response.content[0].text) });
    }

    // 9. DEPARTURE
    if (isDeparture(msg)) {
      const origin = detectDepartureOrigin(message);
      const eventName = extractEventNameFromDeparture(message);
      console.log(`[departure] origin=${origin} eventName=${eventName || "(none)"}`);

      let location = null;
      let title = eventName;
      let arrivalIso = null;
      let arrivalTimeText = null;

      if (eventName) {
        // Step 1: scan conversation history for the event Brad named.
        const histLocation = findEventLocationInHistory(eventName, history);
        // Step 2: search the calendar by title across 7 days for the canonical event/start time.
        const apiEvent = await findUpcomingEventByTitle(eventName);

        if (!apiEvent && !histLocation) {
          console.log(`[departure] no "${eventName}" found in history or calendar`);
          return Response.json({
            reply: `I don't see a "${eventName}" event on your calendar in the next 7 days.`,
          });
        }

        // Prefer history's location if present (per spec); fall back to the calendar API's value.
        location = histLocation || apiEvent?.location || null;
        title = apiEvent?.title || eventName;
        arrivalIso = apiEvent ? new Date(apiEvent.start).toISOString() : null;
        arrivalTimeText = apiEvent?.time || null;

        console.log(
          `[departure] using location="${location}" (source=${histLocation ? "history" : "api"}) for "${title}"`
        );

        if (!location) {
          return Response.json({
            reply: `I see "${title}" on your calendar but no location is set. What address?`,
          });
        }
      } else {
        // No specific event named — first try a fresh address from the recent conversation
        // (e.g. an event Brad just discussed or added). If found, use it directly without
        // re-fetching the calendar. Pair with an explicit "at/by <time>" if one is in scope.
        const histAddress = findRecentAddressInHistory(history.concat([{ role: "user", content: message }]));
        const arrivalText = findArrivalTimeInContext(message, history);

        if (histAddress) {
          location = histAddress;
          title = "the address you mentioned";
          if (arrivalText) {
            arrivalIso = arrivalIsoForTodayTime(arrivalText);
            arrivalTimeText = arrivalText;
          }
          console.log(`[departure] using address from history: "${histAddress}" arrivalText=${arrivalText || "(none)"}`);
        } else {
          // Fallback: next event with a location across 7 days.
          const params = new URLSearchParams({ days: "7" });
          const res = await fetch(`${BASE_URL}/api/calendar/today?${params.toString()}`);
          const data = await res.json();
          const upcoming = (data.events || [])
            .filter((e) => e.location && new Date(e.start).getTime() > Date.now())
            .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
          if (upcoming.length === 0) {
            return Response.json({
              reply: "I can see your calendar but none of the upcoming events have a location listed. What address are you heading to?",
            });
          }
          const ev = upcoming[0];
          location = ev.location;
          title = ev.title;
          arrivalIso = new Date(ev.start).toISOString();
          arrivalTimeText = ev.time;
          console.log(`[departure] no event named; using next: "${title}" at "${location}"`);
        }
      }

      console.log(`[departure] calling Maps with origin="${origin}" destination="${location}"`);
      const maps = await getDriveTime(origin, location);
      if (!maps) {
        return Response.json({
          reply: "I'm having trouble reaching Google Maps right now. Try again in a moment.",
        });
      }

      const driveMinutes = maps.driveTimeMinutes;
      const originLabel = origin === HOME ? "home" : "the shop";

      if (!arrivalIso) {
        return Response.json({
          reply: `It's ${driveMinutes} minutes from ${originLabel} to ${location}.`,
        });
      }

      const arrivalMs = new Date(arrivalIso).getTime();
      const departureMs = arrivalMs - driveMinutes * 60 * 1000;
      const reminderMs = departureMs - 10 * 60 * 1000; // 10-min buffer before departure
      const fmt = (ms) =>
        new Date(ms).toLocaleTimeString("en-US", {
          hour: "numeric", minute: "2-digit", timeZone: TIMEZONE,
        });
      const departureStr = fmt(departureMs);
      const reminderStr = fmt(reminderMs);

      // Auto-save the reminder for departure - 10 min, then verify.
      const reminderText = `Leave ${originLabel} for ${title}`;
      const reminderUtc = new Date(reminderMs).toISOString();
      let reminderConfirmed = false;
      try {
        const saveRes = await saveReminder(reminderText, reminderUtc);
        if (!saveRes.error) {
          const verify = await getReminders();
          reminderConfirmed = verify.some(
            (r) => String(r.id) === String(saveRes.reminder?.id) || r.message === reminderText
          );
        }
      } catch (e) {
        console.log("[departure] reminder auto-save threw:", e.message);
      }

      const reminderClause = reminderConfirmed
        ? ` I'll set a reminder for ${reminderStr} to give you buffer. Done.`
        : ` (couldn't auto-set the reminder — try saying \"remind me at ${reminderStr}\")`;

      return Response.json({
        reply: `Leave ${originLabel} by ${departureStr} to make your ${arrivalTimeText} ${title} at ${location}. That's a ${driveMinutes}-minute drive.${reminderClause}`,
      });
    }

    // 10. NORMAL CHAT
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(today, memoryText),
      messages: [
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: message },
      ],
    });
    return Response.json({ reply: cleanResponse(response.content[0].text) });
  } catch (error) {
    console.log("[chat] POST threw:", error.message);
    return Response.json({ reply: "Jess had an issue: " + error.message });
  }
}

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

const DAYS_PATTERN = /\b(today|tomorrow|sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/i;

const DAY_NAME_TO_INDEX = [
  { regex: /\bsunday\b|\bsun\b/i,                     idx: 0 },
  { regex: /\bmonday\b|\bmon\b/i,                     idx: 1 },
  { regex: /\btuesday\b|\btues\b|\btue\b/i,           idx: 2 },
  { regex: /\bwednesday\b|\bwed\b/i,                  idx: 3 },
  { regex: /\bthursday\b|\bthurs\b|\bthur\b|\bthu\b/i, idx: 4 },
  { regex: /\bfriday\b|\bfri\b/i,                     idx: 5 },
  { regex: /\bsaturday\b|\bsat\b/i,                   idx: 6 },
];

const NO_GUESS_EMAIL_RULE = `NEVER guess or make up email addresses. NEVER. If you don't have the exact email address from the API data, say exactly this: 'I can see Nicole's emails but I need you to confirm her email address - I don't want to guess.' Do not attempt to construct or guess any email address under any circumstances.`;

const ANTI_HALLUCINATION_RULE = `RULE #1 - NEVER HALLUCINATE: If the API returns no data or an error, say you cannot access the information right now. NEVER invent appointments, email addresses, names, times, or any facts. If you don't have real data from an API call, say 'I don't have that information right now' and stop.`;

const MEMORY_VS_CALENDAR_RULE = `IMPORTANT: Calendar events come from the Google Calendar API and are always accurate. Memory is for personal facts about Brad only (addresses, preferences, people). NEVER use memory to modify or override what the calendar API returns. If the calendar says the Weekly Meeting is at 9:00 AM with attendees nicole@nerconsultingllc.com and nicole@solarfixaz.com, that is the truth - do not change it based on memory.`;

const JESS_RULES = `JESS RULES (NON-NEGOTIABLE):
RULE 1 — NEVER ASK "When and what should I remind you about?". If a reminder request lacks an explicit time or topic, scan the recent conversation. If the time and topic appear there, use them. Only ask Brad for clarification if the conversation has zero relevant context.
RULE 2 — NEVER HALLUCINATE. If data isn't in the API response, say "I don't have that information" and stop. Never invent events, emails, times, names, or addresses.
RULE 3 — USE CONVERSATION HISTORY. Before doing anything, scan the last 10 messages for relevant context. If Brad references something already discussed, use it. Never ask for info already in the conversation.
RULE 4 — REMINDERS NEED A BUFFER. When setting a reminder tied to a departure or meeting time, default to 15 minutes before that time unless Brad specifies otherwise.
RULE 5 — CHAINED ACTIONS. When Brad asks for multiple things in one message (move meeting + send email + set reminder), do ALL of them in sequence and confirm each. Never do one and forget the others.
RULE 6 — CALENDAR IS SOURCE OF TRUTH. Never modify or override calendar data with memory or assumptions.
RULE 7 — EMAIL ADDRESSES. Only use email addresses from the calendar attendees array or actual Gmail messages. Never construct or guess.`;

const CALENDAR_FAILURE_REPLY = "I'm having trouble loading your calendar right now. Please try again in a moment.";

function extractReminderBufferMinutes(message) {
  const m = message.match(/(\d+)\s*(?:min|minutes?|m)\s+(?:before|prior|ahead|early)/i);
  return m ? parseInt(m[1], 10) : 15;
}

function mentionsRemindMe(message) {
  return /\bremind me\b/i.test(message) ||
    /\bset (?:a |the )?reminder\b/i.test(message) ||
    /\bdon'?t (?:let me )?forget\b/i.test(message);
}

function subtractMinutesFromPhoenixIso(phoenixIso, minutes) {
  // phoenixIso = "YYYY-MM-DDTHH:MM:00-07:00"
  const ms = new Date(phoenixIso).getTime() - minutes * 60 * 1000;
  const date = new Date(ms);
  // Re-emit in Phoenix-local YYYY-MM-DD HH:MM
  const phoenixDate = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: TIME_ZONE,
  }).format(date);
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: TIME_ZONE,
  }).formatToParts(date);
  const hh = parts.find((p) => p.type === "hour")?.value || "00";
  const mm = parts.find((p) => p.type === "minute")?.value || "00";
  return `${phoenixDate}T${hh}:${mm}:00-07:00`;
}

async function saveReminder({ message, phoenixIso }) {
  // Convert Phoenix-local ISO ("...-07:00") to UTC ISO ("...Z") so the Supabase row stores
  // the canonical UTC instant. Postgres timestamptz treats both as equivalent, but UTC is
  // what we want when inspecting the table directly.
  const utcIso = new Date(phoenixIso).toISOString();
  console.log(`saveReminder: phoenix=${phoenixIso} -> utc=${utcIso}`);
  const res = await fetch(`${BASE_URL}/api/reminders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, remind_at: utcIso }),
  });
  const data = await res.json();
  return { ok: res.ok && !data.error, data };
}

// Pending calendar change marker — parseable, survives cleanResponse (no XML tags).
function formatPendingCalendarBlock({ eventId, eventTitle, newDate, newTime, durationMinutes, newTimeLabel, dayLabel, oldTimeLabel }) {
  return `[Calendar update queued]
event_id: ${eventId}
event_title: ${eventTitle}
new_date: ${newDate}
new_time: ${newTime}
duration_minutes: ${durationMinutes}
new_time_label: ${newTimeLabel}
day_label: ${dayLabel}
old_time_label: ${oldTimeLabel}
[End calendar update]`;
}

function parsePendingCalendarBlock(text) {
  if (!text) return null;
  const m = text.match(/\[Calendar update queued\]([\s\S]+?)\[End calendar update\]/);
  if (!m) return null;
  const block = m[1];
  const get = (k) => block.match(new RegExp(`^${k}:\\s*(.+)$`, "im"))?.[1]?.trim();
  const eventId = get("event_id");
  const newDate = get("new_date");
  const newTime = get("new_time");
  if (!eventId || !newDate || !newTime) return null;
  return {
    eventId,
    eventTitle: get("event_title") || "event",
    newDate,
    newTime,
    durationMinutes: parseInt(get("duration_minutes") || "60", 10),
    newTimeLabel: get("new_time_label") || newTime,
    dayLabel: get("day_label") || newDate,
    oldTimeLabel: get("old_time_label") || "",
  };
}

async function applyPendingCalendarChange(pending) {
  const newStart = { date: pending.newDate, time: pending.newTime };
  const newEnd = addMinutesToDateTime(newStart, pending.durationMinutes);
  const res = await fetch(`${BASE_URL}/api/calendar/today`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventId: pending.eventId, start: newStart, end: newEnd }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    return { ok: false, error: data?.error || `status ${res.status}` };
  }
  // Verify the change actually landed by re-fetching the event for the new day.
  const verifyDate = new Date(`${pending.newDate}T12:00:00-07:00`);
  const verifyRes = await fetch(
    `${BASE_URL}/api/calendar/today?date=${encodeURIComponent(verifyDate.toISOString())}`
  );
  const verifyData = await verifyRes.json();
  const verified = (verifyData.events || []).find((e) => e.id === pending.eventId);
  if (!verified) {
    return { ok: false, error: "calendar didn't echo the change after PATCH" };
  }
  const actualHHMM = getPhoenixHHMM(verified.start);
  if (actualHHMM !== pending.newTime) {
    return {
      ok: false,
      error: `expected ${pending.newTime} but calendar still shows ${actualHHMM}`,
    };
  }
  return { ok: true };
}

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
  // Resolve "next <weekday>" using Phoenix-local day-of-week, not the server's UTC day.
  // Otherwise: at e.g. Phoenix Tue 9 PM (= UTC Wed 04:00) the server thinks today is Wednesday
  // and getDay-based math returns the FOLLOWING Wednesday (7 days later) instead of tomorrow.
  const now = new Date();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const phoenixDayName = now.toLocaleDateString("en-US", { weekday: "long", timeZone: TIME_ZONE });
  const phoenixDay = dayNames.indexOf(phoenixDayName);

  // Today's date in Phoenix as YYYY-MM-DD (en-CA gives that format natively).
  const phoenixDateStr = now.toLocaleDateString("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: TIME_ZONE,
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
    const d = new Date(today); d.setDate(d.getDate() + 1); dates.push(d);
  }
  for (const { regex, idx } of DAY_NAME_TO_INDEX) {
    if (regex.test(msg)) dates.push(getNextDay(idx));
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
  // No "remind me" exclusion — when both intents are present we want write to win so the
  // move/add/delete actually happens, and the move handler chains the reminder save itself.
  // Pure reminder intents (message starts with "remind me") are kept by isReminder via the
  // cross-check there.
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
  const hasReminderPhrase =
    m.includes("remind me") ||
    m.includes("set a reminder") ||
    m.includes("set reminder") ||
    m.includes("don't forget") ||
    m.includes("dont forget") ||
    m.includes("don't let me forget") ||
    m.includes("dont let me forget");
  if (!hasReminderPhrase) return false;
  // RULE 5: when message ALSO contains a calendar write action, defer to handleCalendarWrite
  // which will chain a reminder save itself.
  if (isCalendarWrite(message)) return false;
  return true;
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

async function handleCompoundApproval(ctx) {
  // Compound = the prior assistant message contains BOTH a [Calendar update queued] block
  // AND a Draft email block, ending with "Send it?". Brad's reply must be an approval phrase.
  const last = lastAssistantMessage(ctx.history);
  if (!last) return null;
  const pending = parsePendingCalendarBlock(last);
  const draft = parseEmailDraft(last);
  if (!pending || !draft) return null;
  if (!/Send it\?/i.test(last)) return null;
  if (!isEmailApproval(ctx.message)) return null;

  // Run BOTH actions independently. Calendar PATCH does not wait on the email and vice versa.
  const [calRes, emailRes] = await Promise.all([
    applyPendingCalendarChange(pending),
    fetch(`${BASE_URL}/api/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: draft.to, subject: draft.subject, body: draft.body }),
    }).then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) })),
  ]);

  const parts = [];
  if (calRes.ok) {
    parts.push(`calendar updated to ${pending.newTimeLabel}`);
    try {
      await insertMemoryWithCap(
        `[LOG] Moved ${pending.eventTitle} to ${pending.newTimeLabel} on ${pending.dayLabel}`
      );
    } catch (e) { console.log("[chat] couldn't save move memory:", e.message); }
  } else {
    parts.push(`calendar update FAILED — ${calRes.error}`);
  }

  const emailOk = emailRes.ok && (emailRes.body?.success || !emailRes.body?.error);
  if (emailOk) {
    parts.push(`email sent to ${draft.to}`);
    try {
      await insertMemoryWithCap(
        `[LOG] Sent email to ${draft.to} on ${ctx.today}: ${draft.subject}`
      );
    } catch (e) { console.log("[chat] couldn't save email memory:", e.message); }
  } else {
    parts.push(
      `email send FAILED — ${emailRes.body?.error || `status ${emailRes.body?.status || "unknown"}`}`
    );
  }

  return reply(parts.join(" and ") + ".");
}

async function handleEmailSendApproval(ctx) {
  if (!hasPendingEmailDraft(ctx.history)) return null;
  if (!isEmailApproval(ctx.message)) return null;
  // Defer compound approvals to handleCompoundApproval (which runs first).
  if (parsePendingCalendarBlock(lastAssistantMessage(ctx.history))) return null;

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
  console.log("[chat] calendar dates resolved:", dates.map((d) => d.toISOString()));

  const schedules = await Promise.all(
    dates.map(async (date) => {
      const iso = date.toISOString();
      const url = `${process.env.NEXT_PUBLIC_BASE_URL}/api/calendar/today?date=${encodeURIComponent(iso)}`;
      console.log("Fetching calendar:", url);
      try {
        const res = await fetch(url);
        const data = await res.json();
        console.log("Calendar response:", JSON.stringify(data).slice(0, 800));
        if (!res.ok || data.error) {
          return {
            label: formatDateLabel(date),
            error: true,
            details: data.error || `status ${res.status}`,
          };
        }
        // Expose events directly so downstream consumers can read attendees/organizer/etc.
        return { label: formatDateLabel(date), events: data.events || [], text: data.text || "" };
      } catch (e) {
        console.log("Calendar fetch threw:", e.message);
        return { label: formatDateLabel(date), error: true, details: e.message };
      }
    })
  );

  // If any day failed, refuse to narrate — never let Claude invent events.
  if (schedules.some((s) => s.error)) {
    console.log("[chat] calendar narration skipped due to API error(s)");
    return reply(CALENDAR_FAILURE_REPLY);
  }

  const calendarContext = schedules
    .map((s) => {
      if (!s.events || s.events.length === 0) {
        return `${s.label}:\nNo events scheduled.`;
      }
      const eventList = s.events
        .map((e) => {
          const lines = [`${e.time} — ${e.title}`];
          // Explicit "location: ..." line so Claude can read the field by name. Empty = "(none)".
          lines.push(`  location: ${e.location && e.location.trim() ? e.location : "(none)"}`);
          if (e.attendees?.length) {
            const emails = e.attendees.map((a) => a.email).filter(Boolean).join(", ");
            if (emails) lines.push(`  attendees: ${emails}`);
          }
          return lines.join("\n");
        })
        .join("\n");
      return `${s.label}:\n${eventList}`;
    })
    .join("\n\n");

  const text = await claudeNarrate({
    system: `You are Jess, Brad's executive assistant.

${ANTI_HALLUCINATION_RULE}

${MEMORY_VS_CALENDAR_RULE}

Today is ${ctx.today}. Use it as the reference for the current date — never reference events from wrong years.
Summarize the schedule naturally — time, title, and location. No markdown. Brief.
Calendar event locations are DESTINATIONS Brad is going to, never his home.
Only mention events that appear in the Calendar data block below. If a day shows "No events scheduled.", say exactly that — never invent events.
Show ALL events exactly as listed — if two events share the same start time (e.g. two 9:00 AM events), include BOTH separately. Never merge or hide same-time events.

LOCATION RULE — When you need a location from a calendar event, it will be provided in the event data as 'location: [address]'. If location is empty (shown as 'location: (none)'), say "I don't see a location in that calendar event." NEVER invent or guess a location. NEVER. Use the address verbatim — never paraphrase, abbreviate, or substitute a venue name for the full address.

When attendee emails are provided in the calendar data, use them exactly as shown. Never guess or construct email addresses. Nicole's emails for the Weekly Meeting are nicole@nerconsultingllc.com and nicole@solarfixaz.com.

ATTENDEE NAMES vs EMAILS:
- When summarizing a calendar event, you MAY mention attendee names/emails from the "(attendees: ...)" segment.
- DO NOT recite every attendee email unless Brad asks for them. If he just asks "what's on Wednesday", a brief mention by role/name is enough.

EMPTY ATTENDEES (NON-NEGOTIABLE):
- If Brad asks who's invited / who the attendees are / who's on a calendar event AND that event has no "(attendees: ...)" segment (the attendees array is empty or missing in the data), respond EXACTLY in this form, substituting the real event title:
  "The <EVENT TITLE> meeting doesn't have any attendee emails listed in the calendar invite. You may need to open the invite directly in Google Calendar to see the full list."
- Example for the HomeSmart event: "The HomeSmart meeting doesn't have any attendee emails listed in the calendar invite. You may need to open the invite directly in Google Calendar to see the full list."
- NEVER make up attendee names or emails when the attendees array is empty or missing. NEVER fill in plausible-sounding people. This is non-negotiable.

${NO_GUESS_EMAIL_RULE}
When asked for a SPECIFIC named person's email from a calendar event, ONLY use the exact email from the "(attendees: ...)" segment for that event. If that segment exists but doesn't include the person Brad named, say: "I can see [name] is on the invite but I cannot read their email address from the data - can you confirm it?" NEVER construct or guess an email address.`,
    user: `Calendar data:\n\n${calendarContext}\n\nBrad asked: "${ctx.message}"`,
  });
  return reply(text);
}

/* ---------------- CALENDAR WRITE (add / delete / move) ---------------- */

// Single helper for hitting /api/calendar/today. Supports an optional multi-day window
// and server-side title filter (the GET handler already understands `days` and `searchTitle`).
async function getCalendarForDate(date, options = {}) {
  const isoBase = typeof date === "string" ? date : (date instanceof Date ? date.toISOString() : new Date().toISOString());
  const params = new URLSearchParams({ date: isoBase });
  if (options.days) params.set("days", String(options.days));
  if (options.searchTitle) params.set("searchTitle", options.searchTitle);
  const res = await fetch(`${BASE_URL}/api/calendar/today?${params.toString()}`);
  const data = await res.json();
  if (!res.ok || data.error) {
    return { events: [], error: data?.error || `status ${res.status}` };
  }
  return { events: data.events || [], text: data.text || "" };
}

async function findEventByCriteria({ date, time, title }) {
  if (!date && !title) return [];

  // If a title fragment is given, search a 7-day window so events on other days are still findable.
  // Otherwise scope to the given date only.
  const result = title
    ? await getCalendarForDate(new Date(), { days: 7, searchTitle: title })
    : await getCalendarForDate(new Date(`${date}T12:00:00`));

  if (result.error) {
    console.log("[chat] findEventByCriteria calendar fetch failed:", result.error);
    return [];
  }

  return (result.events || []).filter((event) => {
    if (date && getPhoenixDate(event.start) !== date) return false;
    if (time && getPhoenixHHMM(event.start) !== time) return false;
    if (title && !(event.title || "").toLowerCase().includes(title.toLowerCase())) return false;
    return true;
  });
}

async function extractEventDetails(message, today, history = []) {
  const recentHistory = history.slice(-10);
  const conversationContext = recentHistory.length
    ? recentHistory.map((m) => `${m.role}: ${m.content}`).join("\n")
    : "(no prior turns)";

  const raw = await claudeJson({
    maxTokens: 1024,
    system: `You convert natural-language calendar commands into JSON.
Today is ${today} (America/Phoenix timezone).

If Brad references an event by attendee or paraphrase ("the meeting with Nicole", "the BNI thing", "my call with Mike"), use the recent conversation to resolve it to an actual event title, date, and time visible in history. Prefer the exact event title shown in history.

Return ONLY a JSON object, no preamble:
{
  "action": "add" | "delete" | "move" | "none",
  "title": "event title or null (use the history-known title when possible)",
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
    user: `Recent conversation:\n${conversationContext}\n\nCurrent request: "${message}"`,
  });
  return parseJsonFromClaude(raw, { action: "none" });
}

function extractPersonFromMessage(message) {
  // "with Nicole", "to Nicole", "for Nicole" — capitalized first name.
  const match = message.match(/\b(?:with|to|for|tell)\s+([A-Z][a-zA-Z]+)\b/);
  return match ? match[1] : null;
}

function findAttendeeEmailInEvent(name, event) {
  if (!event?.attendees || !name) return null;
  const lower = name.toLowerCase();
  const matches = event.attendees.filter(
    (a) => a.email && a.email.toLowerCase().startsWith(lower)
  );
  if (matches.length === 0) return null;
  // Prefer @solarfixaz.com when multiple addresses match the name.
  const solar = matches.find((a) => a.email.toLowerCase().includes("@solarfixaz.com"));
  return (solar || matches[0]).email;
}

function findAttendeeEmailInHistory(name, history) {
  if (!name || !history?.length) return null;
  const lower = name.toLowerCase();
  const recent = history.slice(-10).map((m) => m.content || "").join("\n");
  const emails = recent.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [];
  const matches = emails.filter((e) => e.toLowerCase().startsWith(lower));
  if (matches.length === 0) return null;
  const solar = matches.find((e) => e.toLowerCase().includes("@solarfixaz.com"));
  return solar || matches[0];
}

async function handleCalendarWrite(ctx) {
  if (!isCalendarWrite(ctx.message)) return null;

  const details = await extractEventDetails(ctx.message, ctx.today, ctx.history);

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
    if (!res.ok || !data.success) {
      return reply(`Couldn't add that event — ${data?.error || `status ${res.status}`}.`);
    }
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
    if (!res.ok || !data.success) {
      return reply(`Couldn't delete that event — ${data?.error || `status ${res.status}`}.`);
    }
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

    const oldTimeLabel = event.time;
    const newTimeLabel = format12Hour(newTime);
    const dayLabel = formatDateLabel(new Date(`${newDate}T12:00:00`));

    // Detect compound intent — Brad named a person whose email we can pull from data,
    // i.e. the move should also notify them.
    const personName = extractPersonFromMessage(ctx.message);
    const attendeeEmail = personName
      ? findAttendeeEmailInEvent(personName, event) ||
        findAttendeeEmailInHistory(personName, ctx.history)
      : null;

    // PATH A — compound (move + email): defer BOTH actions until Brad approves. Show the
    // pending calendar change and the draft email together. handleCompoundApproval runs
    // both atomically on the next "send it" / "yes" / "go".
    if (personName && attendeeEmail) {
      const pendingBlock = formatPendingCalendarBlock({
        eventId: event.id,
        eventTitle: event.title,
        newDate, newTime,
        durationMinutes,
        newTimeLabel, dayLabel, oldTimeLabel,
      });
      return reply(`Pending changes — reply "send it" to apply both:

Calendar: move "${event.title}" to ${newTimeLabel} on ${dayLabel} (was ${oldTimeLabel}).

${pendingBlock}

Draft email:
To: ${attendeeEmail}
Subject: Meeting moved to ${newTimeLabel}
Body:
Hi ${personName},

I had to reschedule our meeting from ${oldTimeLabel} to ${newTimeLabel} on ${dayLabel}. Hope that still works for you — let me know if not.

Best,
Brad

Send it?`);
    }

    // PATH B — calendar-only move: apply immediately with verify.
    const apply = await applyPendingCalendarChange({
      eventId: event.id,
      eventTitle: event.title,
      newDate, newTime,
      durationMinutes,
      newTimeLabel, dayLabel, oldTimeLabel,
    });
    if (!apply.ok) {
      return reply(`Couldn't move that event — ${apply.error}.`);
    }

    let confirmation = `Done — moved "${event.title}" to ${newTimeLabel} on ${dayLabel} (was ${oldTimeLabel}).`;

    // RULE 5 — chained reminder: if Brad said "remind me ..." in the same message, save a
    // reminder for the new event time minus the requested buffer (default 15 min).
    if (mentionsRemindMe(ctx.message)) {
      const buffer = extractReminderBufferMinutes(ctx.message);
      const eventStartIso = `${newDate}T${newTime}:00-07:00`;
      const remindIso = subtractMinutesFromPhoenixIso(eventStartIso, buffer);
      const remindResult = await saveReminder({
        message: `${event.title} starts in ${buffer} minutes`,
        phoenixIso: remindIso,
      });
      if (remindResult.ok) {
        const remindLabel = new Date(remindIso).toLocaleTimeString("en-US", {
          hour: "numeric", minute: "2-digit", hour12: true, timeZone: TIME_ZONE,
        });
        confirmation += ` Reminder set for ${remindLabel} (${buffer} min before).`;
      } else {
        confirmation += ` (Couldn't save the reminder — ${remindResult.data?.error || "please try again"}.)`;
      }
    }

    try {
      await insertMemoryWithCap(
        `[LOG] Moved ${event.title} from ${oldTimeLabel} to ${newTimeLabel} on ${dayLabel}`
      );
    } catch (e) { console.log("[chat] couldn't save move memory:", e.message); }

    return reply(confirmation);
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
  console.log("[chat] departure detected; origin:", origin, "ctx:", JSON.stringify(dctx));

  // RULE — when Brad names a specific event, ALWAYS re-fetch the canonical event from the
  // calendar API. Never use Claude's paraphrased "knownLocation" from history (it might be
  // truncated like "Rudy's BBQ" instead of "Rudy's BBQ, 15257 N Northsight Blvd, Scottsdale, AZ 85260").
  if (dctx.eventReference) {
    const matches = await findEventByCriteria({ title: dctx.eventReference });
    if (matches.length === 0) {
      return reply(`I don't see a "${dctx.eventReference}" event on your calendar in the next 7 days.`);
    }
    // Pick the soonest future match.
    const upcoming = matches
      .filter((e) => new Date(e.start).getTime() > Date.now())
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    const event = upcoming[0] || matches[0];

    if (!event.location || !event.location.trim()) {
      return reply(
        `I don't see a location in the "${event.title}" calendar event. What address should I route to?`
      );
    }

    // Use Brad's explicit knownArrivalTime if he stated one, else the event's actual start.
    const arrivalIso = dctx.knownArrivalTime
      ? buildPhoenixIsoFromTimeToday(dctx.knownArrivalTime)
      : new Date(event.start).toISOString();

    const maps = await callMapsForDeparture({
      origin,
      destination: event.location, // canonical from calendar API; never modified
      arrivalIso,
    });
    if (maps.error) {
      console.log("[chat] departure (named event) maps error:", maps.error);
      return reply("I'm having trouble reaching Google Maps right now - try again in a moment.");
    }

    const arrivalMs = new Date(arrivalIso).getTime();
    const driveMin = maps.driveTimeMinutes;
    const trafficMin = maps.trafficDelayMinutes;
    const departureMs = arrivalMs - (driveMin + 10) * 60 * 1000;
    const friendly = formatFriendlyDeparture(departureMs, Date.now());
    const trafficNote = trafficMin >= 5 ? ` Traffic is adding about ${trafficMin} minutes.` : "";
    return reply(
      `Leave ${friendly} to make "${event.title}" at ${event.location} — ${driveMin} minutes drive.${trafficNote}`
    );
  }

  // No specific event — fall back to /api/departure (next-event lookup).
  let data;
  try {
    const params = new URLSearchParams({ origin });
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

async function extractReminder(message, history = []) {
  const currentPhoenix = new Date().toLocaleString("en-US", {
    timeZone: TIME_ZONE,
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const recentHistory = history.slice(-10);
  const conversationContext = recentHistory.length
    ? recentHistory.map((m) => `${m.role}: ${m.content}`).join("\n")
    : "(no prior turns)";

  const raw = await claudeJson({
    maxTokens: 384,
    system: `Extract reminder details. Current Phoenix local date/time: ${currentPhoenix}. America/Phoenix is UTC-7 with no DST.

If Brad's CURRENT message lacks a time or topic, look at the recent conversation. If the time and topic are already there (e.g. assistant just said "BNI is at 11:45 AM" and Brad now says "remind me about that"), reconstruct {message, remindAt} from history. Only return null fields when the conversation truly has zero relevant context.

Return ONLY JSON, no preamble:
{"message": "what to remind Brad about (concise)" | null, "remindAt": "YYYY-MM-DD HH:MM in 24-hour Phoenix local time" | null}

Time resolution against current Phoenix time:
- "in 30 minutes" -> add 30 min
- "tomorrow at 3pm" -> next day, 15:00
- "Wednesday at 10am" -> next Wednesday, 10:00
- "tonight at 8" -> today, 20:00
If Brad says "remind me 15 min before X" and X has a time in history, set remindAt = (X's time minus 15 minutes).`,
    user: `Recent conversation:\n${conversationContext}\n\nCurrent reminder request: "${message}"`,
  });
  return parseJsonFromClaude(raw);
}

function isDeleteAllReminders(message) {
  const m = message.toLowerCase();
  // Require an explicit "all" / "every" qualifier so "delete my reminder" (singular,
  // specific) doesn't accidentally wipe the whole table.
  return /\b(delete|clear|remove|wipe)\s+(?:all|every)\s+(?:of\s+)?(?:my\s+)?reminders?\b/.test(m);
}

async function handleDeleteAllReminders(ctx) {
  if (!isDeleteAllReminders(ctx.message)) return null;

  // Count before so we can confirm an exact number to Brad.
  let beforeCount = 0;
  try {
    const beforeRes = await fetch(`${BASE_URL}/api/reminders`);
    const before = await beforeRes.json();
    beforeCount = (before.reminders || []).length;
  } catch (e) {
    console.log("[chat] pre-delete count failed:", e.message);
  }

  const res = await fetch(`${BASE_URL}/api/reminders`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deleteAll: true }),
  });
  const data = await res.json();
  console.log("Delete all reminders result:", JSON.stringify(data));

  if (!res.ok || !data.success) {
    return reply(`I had trouble deleting reminders: ${data?.error || `status ${res.status}`}`);
  }

  // Verify by re-fetching.
  let afterCount = null;
  try {
    const afterRes = await fetch(`${BASE_URL}/api/reminders`);
    const after = await afterRes.json();
    afterCount = (after.reminders || []).length;
  } catch (e) {
    console.log("[chat] post-delete verify failed:", e.message);
  }

  const noun = beforeCount === 1 ? "reminder" : "reminders";
  if (afterCount === 0) {
    return reply(`Done — deleted all ${beforeCount} ${noun}. Your reminder list is now empty.`);
  }
  if (afterCount === null) {
    return reply(`Done — deleted all ${beforeCount} ${noun}.`);
  }
  return reply(
    `Deleted some, but ${afterCount} reminder${afterCount === 1 ? "" : "s"} still showing — something may have failed. Try again.`
  );
}

function isRemindersListQuestion(message) {
  const m = message.toLowerCase();
  return (
    m.includes("any reminders") ||
    m.includes("what reminders") ||
    m.includes("which reminders") ||
    m.includes("show me my reminders") ||
    m.includes("show my reminders") ||
    m.includes("show reminders") ||
    m.includes("list reminders") ||
    m.includes("list my reminders") ||
    m.includes("upcoming reminders") ||
    m.includes("what's reminded") ||
    /\bdo (?:i|you) have (?:any )?reminders?\b/.test(m) ||
    /\breminders?\s+(?:set|left|coming|today|tomorrow|this week)\b/.test(m)
  );
}

async function handleRemindersList(ctx) {
  if (!isRemindersListQuestion(ctx.message)) return null;

  const res = await fetch(`${BASE_URL}/api/reminders`);
  const data = await res.json();
  if (!res.ok || data.error) {
    console.log("[chat] reminders list fetch failed:", data?.error || res.status);
    return reply("I'm having trouble loading your reminders right now.");
  }

  const reminders = data.reminders || [];
  if (reminders.length === 0) return reply("You don't have any active reminders.");

  // Group by Phoenix-local day; format times in Phoenix tz.
  const groups = new Map();
  for (const r of reminders) {
    const d = new Date(r.remind_at);
    const dayLabel = d.toLocaleDateString("en-US", {
      timeZone: TIME_ZONE,
      weekday: "long", month: "short", day: "numeric",
    });
    const timeLabel = d.toLocaleTimeString("en-US", {
      timeZone: TIME_ZONE,
      hour: "numeric", minute: "2-digit", hour12: true,
    });
    if (!groups.has(dayLabel)) groups.set(dayLabel, []);
    groups.get(dayLabel).push(`${timeLabel} — ${r.message}`);
  }

  const text = [...groups.entries()]
    .map(([day, items]) => `${day}:\n${items.map((i) => `  • ${i}`).join("\n")}`)
    .join("\n\n");

  return reply(text);
}

async function handleReminder(ctx) {
  if (!isReminder(ctx.message)) return null;

  const reminder = await extractReminder(ctx.message, ctx.history);
  // RULE 1: never ask "When and what should I remind you about?" if the conversation already has the answer.
  // We only ask when BOTH the current message and the last 10 turns of history are silent on time AND topic.
  if (!reminder?.message || !reminder?.remindAt) {
    const ctxBlob = ctx.history.slice(-10).map((m) => m.content || "").join(" ").toLowerCase();
    const hasContextualTime = /\b\d{1,2}(?::\d{2})?\s*(am|pm)\b/i.test(ctxBlob) || /\b\d{1,2}:\d{2}\b/.test(ctxBlob);
    const hasContextualTopic = ctxBlob.length > 30; // any meaningful prior content
    if (hasContextualTime && hasContextualTopic) {
      return reply("I don't have that information — tell me the time and topic and I'll save it.");
    }
    return reply("Tell me what to remind you about and when, and I'll save it.");
  }

  let phoenixIso = `${reminder.remindAt.replace(" ", "T")}:00-07:00`;
  let remindDate = new Date(phoenixIso);
  if (Number.isNaN(remindDate.getTime())) {
    return reply("I had trouble saving that reminder, please try again.");
  }

  // RULE 4 — when the reminder is about leaving/heading-out for something, default to 15
  // minutes before the supplied time (Brad can override with "remind me X min before").
  const isDepartureReminder = /\b(leave|head out|head over|depart|get going|head to|drive to)\b/i.test(reminder.message);
  if (isDepartureReminder) {
    const buffer = extractReminderBufferMinutes(ctx.message);
    phoenixIso = subtractMinutesFromPhoenixIso(phoenixIso, buffer);
    remindDate = new Date(phoenixIso);
    console.log(`Applied ${buffer}-minute departure buffer; remindAt now ${phoenixIso}`);
  }

  // Send as canonical UTC ISO. Postgres timestamptz stores it the same either way, but the
  // value Brad sees in Supabase will now be in UTC ("...Z" / "...+00:00") rather than -07:00.
  const utcIso = new Date(phoenixIso).toISOString();
  console.log(`Saving reminder: "${reminder.message}" at ${phoenixIso} (utc ${utcIso})`);
  let data;
  try {
    const res = await fetch(`${BASE_URL}/api/reminders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: reminder.message, remind_at: utcIso }),
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

${JESS_RULES}

${ANTI_HALLUCINATION_RULE}

${MEMORY_VS_CALENDAR_RULE}

Brad's home: ${HOME_ADDRESS}
Brad's shop: ${SHOP_ADDRESS}
Today: ${ctx.today}

Memory:
${ctx.memoryText}

Operational rules:
- Take action first, ask questions never
- Use conversation history - never ask for info already discussed
- Never guess drive times or traffic - call Google Maps only
- Never re-search calendar if data already in conversation
- If calendar data is in conversation history, use it directly — never reply "couldn't find that event" for something already listed in history
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
  handleCompoundApproval,  // "send it" when prior turn queued BOTH a calendar move and an email
  handleEmailSendApproval, // "send it" when only a Draft email is pending
  handleDeleteAllReminders,// "delete all reminders" / "clear all reminders" — destructive, narrow trigger
  handleRemindersList,     // "any reminders" / "what reminders are set" — read-only
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

// Jess AI v2 - deployed 2026-05-03
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
    /\bany\s+emails?\s+from\b/.test(m) ||
    /\blast\s+emails?\b/.test(m) ||
    /\brecent\s+emails?\b/.test(m) ||
    /\bwhat\s+emails?\b/.test(m) ||
    /\breach(?:ed)?\s+out\b/.test(m) ||
    /\bemailed\s+(?:me|us)\b/.test(m) ||
    /\bcontacted\s+(?:me|us)\b/.test(m)
  );
}

const EMAIL_APPROVAL_PHRASES = [
  "send it", "yes send", "yes send it", "send", "go", "go ahead",
  "do it", "looks good", "yes", "yep", "yeah", "ok send it", "okay send it",
];

function isEmailApprovalPhrase(msg) {
  const m = msg.toLowerCase().trim().replace(/[.!?]+$/, "");
  return EMAIL_APPROVAL_PHRASES.some((p) => m === p || m.startsWith(p + " "));
}

function isExplicitEmailSend(msg) {
  const m = msg.toLowerCase();
  return (
    m.includes("send an email") ||
    m.includes("send email") ||
    m.includes("email to") ||
    /\bemail\s+(her|him|nicole|mike|john|sarah|yvonne|eric|brad)\b/.test(m) ||
    m.includes("draft an email") ||
    m.includes("draft email") ||
    m.includes("write an email") ||
    m.includes("write email")
  );
}

function isEmailSend(msg, history = []) {
  if (isExplicitEmailSend(msg)) return true;
  if (!isEmailApprovalPhrase(msg)) return false;
  // Approval phrases ("yes", "go ahead", "send it") only route to the email
  // branch when the previous assistant turn actually looks like a draft.
  // Otherwise the same words are confirming something else — calendar,
  // reminder, departure — and must fall through.
  const lastAssistant = history.filter((m) => m.role === "assistant").slice(-1)[0];
  return lookedLikeEmailDraft(lastAssistant?.content);
}

function isQuote(msg) {
  const m = msg.toLowerCase();
  // Require an unambiguous quote-request phrase. Bare "quote for" (e.g.
  // "got a quote for that?") is too broad and used to false-positive.
  return (
    m.includes("roof quote") ||
    m.includes("request a quote") ||
    m.includes("send a quote") ||
    /\bneed a quote\s+for\b/.test(m)
  );
}

function isEmailToDrive(msg) {
  const m = msg.toLowerCase();
  const verb = /\b(save|move|put|upload)\b/.test(m);
  return verb && m.includes("attachment") && (m.includes("drive") || m.includes("folder"));
}

// "put it back" / "move it back" — Brad is asking to undo a prior move, but
// we don't track move history, so the handler asks for the destination
// explicitly instead of guessing.
function isDriveRevert(msg) {
  const m = msg.toLowerCase();
  return (
    /\b(put|move)\b/.test(m) &&
    /\bback\b/.test(m) &&
    /\b(it|that|file|files|folder|doc|document|pdf)\b/.test(m)
  );
}

// Marker embedded in the assistant's "are you sure" prompt so the approval
// handler can recover the file ID on the next turn without needing session
// storage. Format: [delete:abc123]
const DELETE_MARKER_RE = /\[delete:([A-Za-z0-9_\-]+)\]/;

function isDriveDelete(msg) {
  if (isEmailToDrive(msg)) return false;
  const m = msg.toLowerCase();
  if (!/\b(delete|remove|trash)\b/.test(m)) return false;
  return /\b(file|files|folder|folders|doc|docs|document|documents|pdf|contract|report)\b/.test(m);
}

function isDriveDeleteApproval(msg, history = []) {
  const m = msg.toLowerCase().trim().replace(/[.!?]+$/, "");
  if (m !== "yes delete it") return false;
  const lastAssistant = history.filter((h) => h.role === "assistant").slice(-1)[0];
  return DELETE_MARKER_RE.test(lastAssistant?.content || "");
}

function isDriveMove(msg) {
  if (isEmailToDrive(msg) || isDriveRevert(msg) || isDriveDelete(msg)) return false;
  const m = msg.toLowerCase();
  // Verbs are word-boundaried — \bput\b prevents matching computer/input/etc.
  if (!/\b(move|put)\b/.test(m)) return false;
  // Mandatory file/folder/doc target — without this, calendar and reminder
  // messages ("put gas in the truck", "move my meeting to Friday") would
  // false-positive constantly.
  if (!/\b(file|files|folder|folders|doc|docs|document|documents|pdf|contract|report)\b/.test(m)) return false;
  // Destination preposition AFTER the move verb. Bare "in" excluded — every
  // sentence has it.
  const verbIdx = m.search(/\b(move|put)\b/);
  return /\b(to|into|inside)\b/.test(m.slice(verbIdx));
}

function isDriveCreate(msg) {
  if (isDriveMove(msg) || isEmailToDrive(msg) || isDriveRevert(msg) || isDriveDelete(msg)) return false;
  const m = msg.toLowerCase();
  return /\b(create|make|new|add)\b/.test(m) && /\bfolder\b/.test(m);
}

function isDriveSearch(msg) {
  if (isDriveCreate(msg) || isDriveMove(msg) || isEmailToDrive(msg) || isDriveRevert(msg) || isDriveDelete(msg)) return false;
  const m = msg.toLowerCase();
  if (m.includes("search drive") || m.includes("search my drive")) return true;
  const verb = /\b(find|search|look for|locate|get)\b/.test(m);
  // \bpo\b prevents matching "post", "spot", "polo", etc.
  const target =
    /\b(file|files|document|documents|doc|docs|folder|folders|pdf|contract|report|po)\b/.test(m) ||
    m.includes("in drive") ||
    m.includes("in my drive") ||
    m.includes("on drive");
  return verb && target;
}

function isDriveShare(msg) {
  const m = msg.toLowerCase();
  const verb =
    /\bshare\b/.test(m) ||
    m.includes("send link") ||
    m.includes("email link") ||
    m.includes("send the file") ||
    m.includes("send the doc");
  const target = /\b(file|doc|document|folder|link|pdf)\b/.test(m);
  return verb && target;
}

function isDriveRead(msg) {
  const m = msg.toLowerCase();
  const verb =
    /\b(read|open)\b/.test(m) ||
    m.includes("show me") ||
    m.includes("what does") ||
    m.includes("what is in") ||
    m.includes("what's in");
  const target = /\b(file|doc|document|pdf)\b/.test(m);
  return verb && target;
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
  // Require an explicit calendar-intent word. Day names alone do NOT trigger
  // (e.g. "see you Monday" is not a calendar query).
  return (
    m.includes("schedule") ||
    m.includes("calendar") ||
    m.includes("what do i have") ||
    m.includes("what's on") ||
    m.includes("whats on") ||
    /\bappointments?\b/.test(m) ||
    /\bmeetings?\b/.test(m) ||
    /\bagenda\b/.test(m)
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

HALLUCINATION IS A FIRING OFFENSE. If email data is not in the API response, say exactly: "I don't see that in the results I got back." Never invent names, email addresses, subjects, or content. If Brad says you're wrong, believe him - you made it up. The only acceptable responses when data is missing are:
1. "I found nothing matching that search"
2. "I found X emails - here they are: [list actual results]"
Nothing else is acceptable.

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
11. NEVER move, delete, or modify any file that Brad did not explicitly name in his message. If the move fails for one file, do not attempt to move other files. Ask Brad which specific file to try next.

TOOLS YOU HAVE:
You have access to Google Maps via the /api/maps route. ALWAYS use it for drive time questions. NEVER say you cannot calculate drive times. NEVER say you don't have mapping tools. You absolutely do.

You can both READ and SEND emails via Gmail.
- To read: fetch unread emails from /api/email
- To send: draft first, get approval, then send
Never say you cannot read emails. You absolutely can.

SPEED AND FOLLOW-THROUGH RULES:
- Every API call must complete and return results in the SAME response. Never split a search across multiple turns.
- If you need to fetch data, fetch it and include the results in your response. Never say "I'll look that up" without immediately including the answer.
- If an API call returns no results, say exactly what you searched for and what came back empty. Then ask ONE specific question to refine.
- Never make Brad send a follow-up message to get results you should have included the first time.
- Response time goal: fetch and answer in one shot, every time.

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

// Cheap pre-filter so trivial messages (greetings, thanks, one-word replies)
// don't burn a gpt-4o-mini call AND a Supabase re-fetch on every turn.
function shouldSkipMemoryExtraction(message) {
  const raw = String(message || "").trim();
  if (!raw) return true;

  const wordCount = raw.split(/\s+/).filter(Boolean).length;
  if (wordCount < 5) return true;

  const lower = raw.toLowerCase().replace(/[.!?,]+$/g, "").trim();
  const trivialPatterns = [
    /^(?:hi|hey|hello|yo|sup|good morning|good afternoon|good evening|gm|ga)\b/,
    /^(?:thanks|thank you|thx|ty|appreciate it|appreciated|cool|nice|great|perfect|awesome|sweet|got it|gotcha)\b/,
    /^(?:yes|yep|yeah|yup|y|sure|ok|okay|k|alright|right|sounds good|works for me|do it|go ahead|send it|looks good)\b/,
    /^(?:no|nope|nah|n|not now|not yet|never mind|nvm)\b/,
    /^(?:stop|cancel|wait|hold on|hold up|pause)\b/,
  ];
  return trivialPatterns.some((p) => p.test(lower));
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

async function getEmails(searchOrSearches = null, limit = null, recent = false) {
  const params = new URLSearchParams();
  if (limit != null) params.append("limit", String(limit));
  if (Array.isArray(searchOrSearches)) {
    for (const s of searchOrSearches) if (s) params.append("search", s);
  } else if (searchOrSearches) {
    params.append("search", searchOrSearches);
  }
  if (recent) params.append("recent", "true");
  const res = await fetch(`${BASE_URL}/api/email?${params.toString()}`);
  const data = await res.json();
  return data.emails || [];
}

async function buildEmailSearchQuery(personDescription) {
  try {
    const result = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Build Gmail search queries for finding emails involving a person.
Return JSON: {
  "queries": ["query1", "query2", "query3"]
}
Rules:
- Do not hardcode any email domain.
- Never include in:inbox, is:unread, label:, or any other Gmail filter operator. Those over-restrict results.
- Use only name variations with the from:, cc:, and to: operators, plus a bare-name query.
Examples:
- "Eric Brandley" -> ["Eric Brandley", "from:Eric Brandley", "cc:Eric Brandley"]
- "Nicole" -> ["Nicole", "from:Nicole", "cc:Nicole", "to:Nicole"]
Generate 3-4 different query variations to maximize chances of finding the emails.`,
        },
        {
          role: "user",
          content: `Find emails involving: ${personDescription}`,
        },
      ],
    });
    const parsed = JSON.parse(result.choices[0].message.content);
    const queries = Array.isArray(parsed?.queries) ? parsed.queries.filter(Boolean) : [];
    console.log(`[buildEmailSearchQuery] "${personDescription}" ->`, JSON.stringify(queries));
    return queries.length > 0 ? queries : [`from:${personDescription} OR cc:${personDescription} OR to:${personDescription}`];
  } catch (e) {
    console.log("[buildEmailSearchQuery] failed:", e.message);
    return [`from:${personDescription} OR cc:${personDescription} OR to:${personDescription}`];
  }
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

// Quick predicate: does the text look like an email draft we showed to Brad?
// Mirrors parseEmailDraft's expanded label set so an approval phrase ("yes",
// "send it") is only treated as confirming an email when the last assistant
// turn actually presented one.
function lookedLikeEmailDraft(text) {
  if (!text) return false;
  const TO_LABEL = /(?:^|\n)\s*\*?\*?(?:to|recipient|send\s*to|email\s*to)\*?\*?\s*[:\-]\s*\S+/im;
  const SUBJECT_LABEL = /(?:^|\n)\s*\*?\*?(?:subject(?:\s*line)?|re)\*?\*?\s*[:\-]\s*\S+/im;
  return TO_LABEL.test(text) && SUBJECT_LABEL.test(text);
}

// Parse a To/Subject/Body draft from an assistant message. Tolerates
// markdown bold ("**To:**"), markdown links ("[email](mailto:...)"), and
// label variants — "Recipient", "Send to", "Email to", "Subject Line",
// "Re", "Message", "Content". If the To label is missing entirely, falls
// back to the first bare email address in the text.
function parseEmailDraft(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/\*\*/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Anchor each label to start-of-line so "want to" / "going to" don't false-match.
  // Allow ":" or "-" separator after the label.
  const TO_LABEL = /(?:^|\n)\s*(?:to|recipient|send\s*to|email\s*to)\s*[:\-]\s*([^\n]+)/i;
  const SUBJECT_LABEL = /(?:^|\n)\s*(?:subject(?:\s*line)?|re)\s*[:\-]\s*([^\n]+)/i;
  const BODY_LABEL = /(?:^|\n)\s*(?:body|message|content)\s*[:\-]\s*([\s\S]+?)(?:\n\s*(?:want\b|shall\b|---|send\s*it\b|send\?|let\s*me\s*know\b)|$)/i;

  const toMatch = cleaned.match(TO_LABEL);
  const subjectMatch = cleaned.match(SUBJECT_LABEL);
  const bodyMatch = cleaned.match(BODY_LABEL);

  let to = null;
  if (toMatch) {
    to = toMatch[1].trim().replace(/^[<"']+|[>"',]+$/g, "");
  } else {
    // Last-resort: pull the first bare email address out of the draft.
    const emailRe = cleaned.match(/[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}/);
    if (emailRe) to = emailRe[0];
  }

  const subject = subjectMatch ? subjectMatch[1].trim() : null;

  let body = bodyMatch ? bodyMatch[1].trim() : null;
  // If no Body label, take "everything after Subject" up to the first send-confirmation prompt.
  if (!body && subjectMatch) {
    const subjEnd = subjectMatch.index + subjectMatch[0].length;
    let raw = cleaned.slice(subjEnd);
    raw = raw.split(/\n\s*(?:Send it\?|Shall I send|---|Want me to send|Want to send|Let me know)/i)[0];
    body = raw.trim();
  }

  if (!to || !subject || !body) return null;
  return { to, subject, body };
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

    // Memory housekeeping (always before any intent branch). Skip the GPT
    // extraction + re-fetch on trivial messages — saves ~30%+ of turns.
    const memory = await getMemory();
    const skipMemory = shouldSkipMemoryExtraction(message);
    if (!skipMemory) await saveOrUpdateMemory(message, memory);
    const updatedMemory = skipMemory ? memory : await getMemory();
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
      const lower = msg.toLowerCase();

      // Person extraction. Captures multi-word names (e.g. "Eric Brandley") by
      // grabbing everything from the trigger word until punctuation or EOL,
      // then trimming filler words off the tail.
      const STOP = ["i", "you", "we", "they", "he", "she", "me", "us", "someone", "anyone", "the", "a", "an"];
      const TAIL_FILLER = /\s+(?:please|today|now|recently|lately|ever|yesterday|this week|last week)\.?$/i;
      const cleanName = (raw) =>
        raw.trim().replace(TAIL_FILLER, "").replace(/[?.!,]+$/, "").trim();

      const reachMatch =
        msg.match(/when\s+did\s+(.+?)\s+(?:last\s+)?(?:reach(?:ed)?\s+out|email(?:ed)?|message(?:d)?|contact(?:ed)?)/i) ||
        msg.match(/\b([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)?)\s+(?:last\s+)?(?:reached\s+out|emailed|messaged|contacted)\b/);
      const fromMatch =
        msg.match(/\b(?:from|by|involving|about|with)\s+(.+?)(?:[?.!,]|$)/i);

      let searchedName = null;
      if (reachMatch) {
        const name = cleanName(reachMatch[1]);
        if (name && !STOP.includes(name.toLowerCase())) searchedName = name;
      }
      if (!searchedName && fromMatch) {
        const name = cleanName(fromMatch[1]);
        if (name && !STOP.includes(name.toLowerCase())) searchedName = name;
      }

      // Build queries. Use GPT to expand the person description into 3-4 Gmail
      // query variations (from:, cc:, email-domain guesses, raw name) and run
      // them in parallel.
      let queries = null;
      if (searchedName) {
        queries = await buildEmailSearchQuery(searchedName);
        console.log("Email search queries built:", JSON.stringify(queries));
      }

      const all = msg.includes("all");
      const recent =
        /\blast\s+emails?\b/.test(lower) ||
        /\bmost\s+recent\s+emails?\b/.test(lower) ||
        /\brecent\s+emails?\b/.test(lower) ||
        /\bwhat\s+did\s+i\s+just\s+get\b/.test(lower);
      // For multi-query person searches let the email route default to 50/query.
      // For "last/recent email" peeks limit to 1. Otherwise default to 5.
      const limit = recent ? 1 : queries ? null : all ? 20 : 5;
      console.log("Fetching emails with queries:", JSON.stringify(queries));
      const rawEmails = await getEmails(queries, limit, recent);
      console.log("Emails returned:", (rawEmails || []).length);
      console.log("First email:", JSON.stringify((rawEmails || [])[0]));

      // ID VALIDATION: every email must carry a real Gmail message id. Anything
      // without one is fabricated/garbage and must be dropped before Claude
      // sees it. Without this, a malformed upstream response could let invented
      // entries reach the model.
      const emails = (rawEmails || []).filter(
        (e) => e && typeof e.id === "string" && e.id.length > 0
      );
      const dropped = (rawEmails || []).length - emails.length;
      if (dropped > 0) {
        console.log(`[email read] DROPPED ${dropped} email(s) missing a Gmail id`);
      }

      // HALLUCINATION HARD STOP: zero results NEVER reach Claude. The reply is
      // the fixed string below — Claude is not invoked. This is the only way
      // to guarantee the model cannot fabricate email content.
      if (emails.length === 0) {
        const subject = searchedName ? `${searchedName} emails` : "your emails";
        return Response.json({
          reply: `I searched for ${subject} and found nothing. Try a different name, date range, or keyword.`,
        });
      }

      // ONLY reach Claude when we have REAL email data (every entry has a
      // verified Gmail id).
      const emailContext = emails
        .map(
          (e, i) =>
            `${i + 1}. [id:${e.id}] From: ${e.from} (${e.fromEmail})\nSubject: ${e.subject}\nDate: ${e.date}\nBody: ${e.body?.slice(0, 300) || ""}`
        )
        .join("\n\n");

      const groupingHint = searchedName
        ? `\n\nThe results above were the union of multiple Gmail searches (${queries.join(" | ")}), already deduped and sorted newest-first. List EVERY email shown above, grouped by date (most recent date first), with subject + sender. Do not omit any.`
        : "";

      const emailGuardrail =
        "\n\nEMAIL SUMMARY GUARDRAIL:\nYou are summarizing REAL emails from the API. The emails above are the ONLY emails that exist. Do not mention, invent, or reference any emails not in the list above. If the list is empty, say you found nothing.";

      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: buildSystemPrompt(today, memoryText) + emailGuardrail,
        messages: [
          ...history.map((m) => ({ role: m.role, content: m.content })),
          {
            role: "user",
            content: `${message}\n\n--- Email data fetched for this turn ---\n${emailContext}${groupingHint}`,
          },
        ],
      });
      return Response.json({ reply: cleanResponse(response.content[0].text) });
    }

    // 5. EMAIL SEND
    if (isEmailSend(msg, history)) {
      const lastAssistantMsg = history.filter((m) => m.role === "assistant").slice(-1)[0];
      const lastContent = lastAssistantMsg?.content || "";

      const isDraftApproval = isEmailApprovalPhrase(msg);
      const lookedLikeDraft = lookedLikeEmailDraft(lastContent);

      console.log("=== EMAIL SEND TRIGGERED ===");
      console.log("Message:", message);
      console.log("Last assistant msg:", lastContent?.slice(0, 200));
      console.log("isDraftApproval:", isDraftApproval);
      console.log("lookedLikeDraft:", lookedLikeDraft);

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
        system:
          buildSystemPrompt(today, memoryText) +
          "\n\nCRITICAL: Do NOT claim you sent any email. Do NOT say 'sent' or 'email sent'. Only draft the email and show it to Brad. Say 'Here's what I'll send - shall I send it?' Never claim an action happened that you didn't execute.",
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

    // 7a. DRIVE SEARCH
    if (isDriveSearch(msg)) {
      const extractRes = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Extract the search term for Google Drive.
File names in this Drive look like: "PO-0418 - David Wheat - 2026-01-12.pdf"
Extract just the person name or keyword to search for.
Examples:
"find PO for David Wheat" -> {"searchTerm": "David Wheat", "folderName": null}
"find Green Tech files" -> {"searchTerm": "Green Tech", "folderName": null}
"find WattMonk contract" -> {"searchTerm": "WattMonk", "folderName": null}
"find files in SolarFix POs folder" -> {"searchTerm": "", "folderName": "SolarFix POs"}
Return JSON: {"searchTerm": "exact name or keyword", "folderName": "folder name or null"}`,
          },
          { role: "user", content: message },
        ],
      });
      const { searchTerm, folderName, fileType } = JSON.parse(
        extractRes.choices[0].message.content
      );
      console.log("[drive search] extracted:", { searchTerm, folderName, fileType });

      const params = new URLSearchParams({ limit: "20" });
      if (searchTerm) params.append("search", searchTerm);
      if (folderName) params.append("folder", folderName);
      if (fileType && fileType !== "any") params.append("type", fileType);

      const driveRes = await fetch(`${BASE_URL}/api/drive?${params.toString()}`);
      const driveData = await driveRes.json();
      console.log("[drive search] results:", driveData.files?.length, "warning:", driveData.warning);

      // ID validation: drop anything missing a Drive id (parity w/ email guard).
      const validFiles = (driveData.files || []).filter(
        (f) => f && typeof f.id === "string" && f.id.length > 0
      );

      if (validFiles.length === 0) {
        const subject = searchTerm ? `"${searchTerm}"` : "your Drive";
        const folderHint = driveData.warning ? ` ${driveData.warning}` : "";
        return Response.json({
          reply: `I searched Drive for ${subject} and found nothing.${folderHint} Try a different keyword or check the file name.`,
        });
      }

      const fileList = validFiles
        .map((f) => {
          const icon = f.mimeType?.includes("folder")
            ? "📁"
            : f.mimeType?.includes("pdf")
            ? "📄"
            : f.mimeType?.includes("sheet")
            ? "📊"
            : f.mimeType?.includes("document")
            ? "📝"
            : "📎";
          const modified = f.modifiedTime
            ? new Date(f.modifiedTime).toLocaleDateString("en-US", { timeZone: TIMEZONE })
            : "unknown";
          return `${icon} [id:${f.id}] ${f.name} — modified ${modified} — ${f.webViewLink || "(no link)"}`;
        })
        .join("\n");

      const driveGuardrail =
        "\n\nDRIVE GUARDRAIL: The files listed above are the ONLY files that exist for this query. Do not invent file names, IDs, or links. Only reference files from the list. Show the name and link for each.";

      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 768,
        system: buildSystemPrompt(today, memoryText) + driveGuardrail,
        messages: [
          {
            role: "user",
            content: `Brad searched Drive for "${searchTerm}".\n\nFiles found (${validFiles.length}):\n${fileList}\n\nList them clearly with names and links. Then ask if he wants to open, share, email, or read any of them.`,
          },
        ],
      });
      return Response.json({ reply: cleanResponse(response.content[0].text) });
    }

    // 7b. DRIVE CREATE FOLDER
    if (isDriveCreate(msg)) {
      const extractRes = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Extract folder creation details and clean up the folder name to be professional.
Rules:
- Strip leading articles ("the", "a", "an")
- Title-case the words ("Don Peterson Project", not "don peterson project")
- Keep proper nouns, brand names, and acronyms intact (POs, WattMonk, BNI)
- Drop filler phrasing like "for", "called", "named"
- Trim trailing punctuation

Examples:
"create a folder called the Don Peterson project" -> {"folderName": "Don Peterson Project", "parentFolderName": null}
"new folder for invoices" -> {"folderName": "Invoices", "parentFolderName": null}
"make a folder named the David Wheat 2026 stuff inside SolarFix POs" -> {"folderName": "David Wheat 2026", "parentFolderName": "SolarFix POs"}
"create folder for green tech proposals" -> {"folderName": "Green Tech Proposals", "parentFolderName": null}

Return JSON: {"folderName": "cleaned name", "parentFolderName": "parent folder name or null"}`,
          },
          { role: "user", content: message },
        ],
      });
      const { folderName, parentFolderName } = JSON.parse(
        extractRes.choices[0].message.content
      );

      if (!folderName) {
        return Response.json({ reply: "What should I name the new folder?" });
      }

      const driveRes = await fetch(`${BASE_URL}/api/drive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderName, parentFolderName }),
      });
      const data = await driveRes.json();

      if (data.success) {
        try {
          await insertMemoryWithCap(
            `[LOG] Created Drive folder "${data.name}"${parentFolderName ? ` inside ${parentFolderName}` : ""} on ${today}`
          );
        } catch (e) { console.log("[drive create] memory log failed:", e.message); }
        return Response.json({
          reply: `Done — created folder "${data.name}"${parentFolderName ? ` inside ${parentFolderName}` : " in My Drive"}. Link: ${data.link}`,
        });
      }
      return Response.json({ reply: `I couldn't create that folder: ${data.error || "unknown error"}` });
    }

    // 7b1. DRIVE REVERT — "put it back" / "move it back". We don't track move
    // history, so ask for the destination explicitly rather than guess.
    if (isDriveRevert(msg)) {
      return Response.json({
        reply: "I don't track where files came from, so I can't put it back automatically. Which folder should I move it to?",
      });
    }

    // 7b2. DRIVE MOVE — extract source + target, look up source, call PATCH move.
    if (isDriveMove(msg)) {
      const extractRes = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Extract a Drive move command. The user wants to move a file or folder to a destination folder.
Return JSON: {"sourceName": "name of file/folder being moved", "targetFolderName": "destination folder name"}
Examples:
"move the Lisa Scott folder to Brad's project" -> {"sourceName": "Lisa Scott", "targetFolderName": "Brad's project"}
"move PO-0316 to invoices folder" -> {"sourceName": "PO-0316", "targetFolderName": "invoices"}
"take Lisa Scott Fair Oaks Ranch and move it to the folder I just created called Brads Personal Project" -> {"sourceName": "Lisa Scott Fair Oaks Ranch", "targetFolderName": "Brads Personal Project"}
"move the David Wheat PO into the SolarFix POs folder" -> {"sourceName": "David Wheat PO", "targetFolderName": "SolarFix POs"}
Strip filler like "the folder called", "the file named", "I just created". Return the bare names.`,
          },
          { role: "user", content: message },
        ],
      });
      const { sourceName, targetFolderName } = JSON.parse(
        extractRes.choices[0].message.content
      );
      console.log("[drive move] extracted:", { sourceName, targetFolderName });

      if (!sourceName || !targetFolderName) {
        return Response.json({
          reply: "I need both the source and the destination folder. What should I move and where?",
        });
      }

      // Find the source by name. Use ALL of /api/drive's name+fullText search.
      const sParams = new URLSearchParams({ search: sourceName, limit: "10" });
      const sRes = await fetch(`${BASE_URL}/api/drive?${sParams.toString()}`);
      const sData = await sRes.json();
      const candidates = (sData.files || []).filter((f) => f && f.id);

      if (candidates.length === 0) {
        return Response.json({
          reply: `I couldn't find "${sourceName}" in Drive. Try a different name.`,
        });
      }

      // Punctuation-insensitive exact-name match required. NEVER silently fall
      // back to the first search result — moving the wrong file is worse than
      // asking Brad to disambiguate.
      const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
      const source = candidates.find((f) => norm(f.name) === norm(sourceName));
      if (!source) {
        if (candidates.length === 1) {
          return Response.json({
            reply: `I found "${candidates[0].name}" but its name doesn't exactly match "${sourceName}". Reply with the exact file name to confirm — I won't move it until you do.`,
          });
        }
        const list = candidates.slice(0, 5).map((f) => `• ${f.name}`).join("\n");
        return Response.json({
          reply: `Multiple files match "${sourceName}". Which exact file should I move?\n\n${list}\n\nReply with the exact name and I'll move only that one.`,
        });
      }
      console.log(`[drive move] picked source: id=${source.id} name="${source.name}"`);

      console.log("=== CALLING DRIVE PATCH ===");
      const mRes = await fetch(`${BASE_URL}/api/drive`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "move",
          fileId: source.id,
          fileName: source.name,
          targetFolderName,
        }),
      });
      const mData = await mRes.json();
      console.log("Drive PATCH response:", JSON.stringify(mData));

      if (!mData.success) {
        return Response.json({
          reply: `I couldn't move the file: ${mData.error || "unknown error"}`,
        });
      }

      if (mData.method === "shortcut") {
        try {
          await insertMemoryWithCap(
            `[LOG] Created shortcut to "${source.name}" in "${targetFolderName}" on ${today}`
          );
        } catch (e) { console.log("[drive move] memory log failed:", e.message); }
        return Response.json({
          reply: `I added a shortcut to ${source.name} in the folder — it works just like the real file but since it's owned by a teammate I can't move the original.`,
        });
      }

      // Real move — verify by re-fetching the file inside the target folder.
      // /api/drive GET with both search and folder filters returns only files
      // matching the name AND parented under the resolved target folder ID.
      let verified = false;
      try {
        const vParams = new URLSearchParams({
          search: source.name,
          folder: targetFolderName,
          limit: "5",
        });
        const vRes = await fetch(`${BASE_URL}/api/drive?${vParams.toString()}`);
        const vData = await vRes.json();
        verified = (vData.files || []).some((f) => f.id === source.id);
        console.log("[drive move verify]", { fileId: source.id, verified, returned: vData.files?.length });
      } catch (e) {
        console.log("[drive move verify] failed:", e.message);
      }

      if (!verified) {
        return Response.json({
          reply: "The move API returned success but I can't verify it worked. Please check your Drive — if it's not there, this may be a permissions issue with that specific file.",
        });
      }

      try {
        await insertMemoryWithCap(
          `[LOG] Moved "${source.name}" to "${targetFolderName}" on ${today}`
        );
      } catch (e) { console.log("[drive move] memory log failed:", e.message); }
      return Response.json({
        reply: `Done — moved "${source.name}" into "${targetFolderName}". Check your Drive now.`,
      });
    }

    // 7b3. DRIVE DELETE APPROVAL — must come before isDriveDelete.
    // "yes delete it" is only honored when the previous assistant turn
    // contained a [delete:...] marker; the file ID is parsed out of that
    // marker so we delete exactly the file Brad confirmed.
    if (isDriveDeleteApproval(msg, history)) {
      const lastAssistant = history.filter((h) => h.role === "assistant").slice(-1)[0];
      const idMatch = lastAssistant?.content?.match(DELETE_MARKER_RE);
      const fileId = idMatch?.[1];
      if (!fileId) {
        return Response.json({
          reply: "I lost track of which file you confirmed. Tell me which file to delete and I'll ask again.",
        });
      }
      const nameMatch = lastAssistant.content.match(/delete\s+["']([^"']+)["']/i);
      const fileName = nameMatch?.[1] || "the file";

      console.log("=== CALLING DRIVE DELETE ===");
      const dRes = await fetch(`${BASE_URL}/api/drive`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId }),
      });
      const dData = await dRes.json();
      console.log("Drive DELETE response:", JSON.stringify(dData));

      if (!dData.success) {
        return Response.json({
          reply: `I couldn't delete that file: ${dData.error || "unknown error"}`,
        });
      }

      try {
        await insertMemoryWithCap(
          `[LOG] Deleted "${fileName}" (id ${fileId}) on ${today}`
        );
      } catch (e) { console.log("[drive delete] memory log failed:", e.message); }

      return Response.json({ reply: `Done — "${fileName}" moved to trash.` });
    }

    // 7b4. DRIVE DELETE — first turn. Find the file, show it to Brad,
    // ask for explicit confirmation. Embeds the file ID as a [delete:...]
    // marker so the approval handler can recover it. NO API call until
    // Brad responds with exactly "yes delete it".
    if (isDriveDelete(msg)) {
      const extractRes = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Extract the name of the Drive file or folder Brad wants to delete.
Return JSON: {"sourceName": "exact file or folder name"}
Examples:
"delete PO-0418" -> {"sourceName": "PO-0418"}
"trash the Lisa Scott folder" -> {"sourceName": "Lisa Scott"}
"remove the David Wheat contract" -> {"sourceName": "David Wheat contract"}
"delete the file called Brads Personal Project" -> {"sourceName": "Brads Personal Project"}
Strip filler like "the file called", "the folder named". Return the bare name.`,
          },
          { role: "user", content: message },
        ],
      });
      const { sourceName } = JSON.parse(extractRes.choices[0].message.content);
      console.log("[drive delete] extracted:", { sourceName });

      if (!sourceName) {
        return Response.json({ reply: "Which file or folder should I delete?" });
      }

      const sParams = new URLSearchParams({ search: sourceName, limit: "10" });
      const sRes = await fetch(`${BASE_URL}/api/drive?${sParams.toString()}`);
      const sData = await sRes.json();
      const candidates = (sData.files || []).filter((f) => f && f.id);

      if (candidates.length === 0) {
        return Response.json({
          reply: `I couldn't find "${sourceName}" in Drive. Try a different name.`,
        });
      }

      // Mandatory normalized exact match — never silently target a similar file.
      const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
      const source = candidates.find((f) => norm(f.name) === norm(sourceName));
      if (!source) {
        if (candidates.length === 1) {
          return Response.json({
            reply: `I found "${candidates[0].name}" but its name doesn't exactly match "${sourceName}". Reply with the exact file name to confirm — I won't delete anything until you do.`,
          });
        }
        const list = candidates.slice(0, 5).map((f) => `• ${f.name}`).join("\n");
        return Response.json({
          reply: `Multiple files match "${sourceName}". Which exact one should I delete?\n\n${list}\n\nReply with the exact name and I'll only target that one.`,
        });
      }

      console.log(`[drive delete] picked source: id=${source.id} name="${source.name}"`);
      return Response.json({
        reply: `Are you sure you want to delete "${source.name}"? Type 'yes delete it' to confirm.\n\n[delete:${source.id}]`,
      });
    }

    // 7c. DRIVE SHARE — extract source + recipient, look up source, call PATCH
    // share. Never hands off to Claude (which would invent "Done" without a
    // real API call).
    if (isDriveShare(msg)) {
      const extractRes = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Extract a Drive share command. Return JSON:
{"sourceName": "name of file/folder to share", "shareEmail": "recipient email or null", "shareRole": "reader|writer|commenter"}
Default shareRole to "reader" unless the user clearly asks for edit/comment access.
Examples:
"share PO-0316 with eric@solarfixaz.com" -> {"sourceName": "PO-0316", "shareEmail": "eric@solarfixaz.com", "shareRole": "reader"}
"share the David Wheat folder with phillip@solarfixaz.com as editor" -> {"sourceName": "David Wheat", "shareEmail": "phillip@solarfixaz.com", "shareRole": "writer"}
"send link to the contract to nicole@example.com" -> {"sourceName": "contract", "shareEmail": "nicole@example.com", "shareRole": "reader"}
"share Lisa Scott Producing" -> {"sourceName": "Lisa Scott Producing", "shareEmail": null, "shareRole": "reader"}
If the message has no email, set shareEmail to null.`,
          },
          { role: "user", content: message },
        ],
      });
      const { sourceName, shareEmail, shareRole } = JSON.parse(
        extractRes.choices[0].message.content
      );
      console.log("[drive share] extracted:", { sourceName, shareEmail, shareRole });

      if (!sourceName) {
        return Response.json({ reply: "Which file or folder should I share?" });
      }
      if (!shareEmail) {
        return Response.json({
          reply: `Who should I share "${sourceName}" with? Give me their email address.`,
        });
      }

      // Find source — same disambiguation rules as move.
      const sParams = new URLSearchParams({ search: sourceName, limit: "10" });
      const sRes = await fetch(`${BASE_URL}/api/drive?${sParams.toString()}`);
      const sData = await sRes.json();
      const candidates = (sData.files || []).filter((f) => f && f.id);

      if (candidates.length === 0) {
        return Response.json({
          reply: `I couldn't find "${sourceName}" in Drive. Try a different name.`,
        });
      }

      const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
      const source = candidates.find((f) => norm(f.name) === norm(sourceName));
      if (!source) {
        if (candidates.length === 1) {
          return Response.json({
            reply: `I found "${candidates[0].name}" but its name doesn't exactly match "${sourceName}". Reply with the exact file name to confirm — I won't share it until you do.`,
          });
        }
        const list = candidates.slice(0, 5).map((f) => `• ${f.name}`).join("\n");
        return Response.json({
          reply: `Multiple files match "${sourceName}". Which exact one should I share with ${shareEmail}?\n\n${list}`,
        });
      }

      console.log("=== CALLING DRIVE PATCH (share) ===");
      const shareRes = await fetch(`${BASE_URL}/api/drive`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "share",
          fileId: source.id,
          shareEmail,
          shareRole: shareRole || "reader",
        }),
      });
      const shareData = await shareRes.json();
      console.log("Drive share response:", JSON.stringify(shareData));

      if (!shareData.success) {
        return Response.json({
          reply: `I couldn't share that file: ${shareData.error || "unknown error"}`,
        });
      }

      try {
        await insertMemoryWithCap(
          `[LOG] Shared "${source.name}" with ${shareEmail} (${shareRole || "reader"}) on ${today}`
        );
      } catch (e) { console.log("[drive share] memory log failed:", e.message); }

      return Response.json({
        reply: `Done — shared "${source.name}" with ${shareEmail} as ${shareRole || "reader"}. They'll get a notification email.`,
      });
    }

    // 7d. DRIVE READ — same pattern as share: needs a file ID first.
    if (isDriveRead(msg)) {
      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 512,
        system:
          buildSystemPrompt(today, memoryText) +
          `\n\nTo read a file, you need its Drive ID. If a recent Drive search in this conversation surfaced the file (look for "[id:...]" markers in past assistant messages), use that ID. Otherwise ask Brad to search for the file first.`,
        messages: [
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: message },
        ],
      });
      return Response.json({ reply: cleanResponse(response.content[0].text) });
    }

    // 7e. EMAIL ATTACHMENT TO DRIVE — fetch the email, locate the attachment,
    // call /api/drive/email-to-drive directly. Never hands off to Claude.
    if (isEmailToDrive(msg)) {
      const extractRes = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Extract an email-to-drive command. Brad wants to save an email attachment to a Drive folder.
Return JSON: {"emailSearch": "search term to find the email — sender name or subject keyword", "targetFolderName": "Drive folder name", "fileName": "rename or null to keep original name"}
Examples:
"save the Thrifty attachment to my Receipts folder" -> {"emailSearch": "Thrifty", "targetFolderName": "Receipts", "fileName": null}
"upload the David Wheat invoice from email to David Wheat folder" -> {"emailSearch": "David Wheat invoice", "targetFolderName": "David Wheat", "fileName": null}
"put the PDF from Phillip's email into PO 2026 folder" -> {"emailSearch": "Phillip", "targetFolderName": "PO 2026", "fileName": null}
"save the WattMonk attachment as wattmonk-jan.pdf in Contracts folder" -> {"emailSearch": "WattMonk", "targetFolderName": "Contracts", "fileName": "wattmonk-jan.pdf"}`,
          },
          { role: "user", content: message },
        ],
      });
      const { emailSearch, targetFolderName, fileName: customName } = JSON.parse(
        extractRes.choices[0].message.content
      );
      console.log("[email-to-drive] extracted:", { emailSearch, targetFolderName, customName });

      if (!emailSearch || !targetFolderName) {
        return Response.json({
          reply: "I need both an email reference (sender or subject) and a Drive folder name. Try: \"save the Thrifty attachment to my Receipts folder\".",
        });
      }

      // Step 1: find the email
      console.log("[email-to-drive] fetching email with search:", emailSearch);
      const emailRes = await fetch(
        `${BASE_URL}/api/email?search=${encodeURIComponent(emailSearch)}&limit=10`
      );
      const emailData = await emailRes.json();
      const emails = (emailData.emails || []).filter((e) => e && e.id);
      console.log("[email-to-drive] emails found:", emails.length);

      if (emails.length === 0) {
        return Response.json({
          reply: `I couldn't find any email matching "${emailSearch}". Try a different sender or keyword.`,
        });
      }

      // Step 2: pick the first email that actually has attachments
      const emailWithAttachments = emails.find(
        (e) => Array.isArray(e.attachments) && e.attachments.length > 0
      );
      if (!emailWithAttachments) {
        return Response.json({
          reply: `I found ${emails.length} email(s) matching "${emailSearch}" but none of them have attachments.`,
        });
      }
      console.log("[email-to-drive] email with attachments:", {
        id: emailWithAttachments.id,
        subject: emailWithAttachments.subject,
        from: emailWithAttachments.fromEmail,
        attachmentCount: emailWithAttachments.attachments.length,
      });

      // Step 3: pick the first attachment. If multiple, save the first and
      // mention the rest so Brad knows.
      const attachment = emailWithAttachments.attachments[0];
      console.log("[email-to-drive] attachment:", attachment);

      // Step 4: call email-to-drive (which resolves folderName → folderId
      // server-side, so we don't need to look it up here).
      console.log("=== CALLING EMAIL-TO-DRIVE ===");
      const e2dRes = await fetch(`${BASE_URL}/api/drive/email-to-drive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emailId: emailWithAttachments.id,
          attachmentId: attachment.attachmentId,
          fileName: customName || attachment.filename,
          folderName: targetFolderName,
        }),
      });
      const result = await e2dRes.json();
      console.log("Email-to-Drive result:", JSON.stringify(result));

      if (!result.success) {
        return Response.json({
          reply: `I couldn't save that attachment: ${result.error || "unknown error"}`,
        });
      }

      try {
        await insertMemoryWithCap(
          `[LOG] Saved attachment "${result.name}" from email "${emailWithAttachments.subject}" to "${targetFolderName}" on ${today}`
        );
      } catch (e) { console.log("[email-to-drive] memory log failed:", e.message); }

      const noteOthers =
        emailWithAttachments.attachments.length > 1
          ? ` (this email had ${emailWithAttachments.attachments.length} attachments — I saved the first one. Tell me which other to save if needed.)`
          : "";

      return Response.json({
        reply: `Done — saved "${result.name}" to ${targetFolderName}.${noteOthers} Link: ${result.link || "(no link)"}`,
      });
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

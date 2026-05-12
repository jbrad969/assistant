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

// In-memory cache scoped to a single warm serverless instance. email_read
// populates this with every attachment-bearing email so the next-turn save
// can resolve specific references ("the May 1st one", "the Pershing one",
// "the older one") to the right attachmentId — not just whichever single
// item the SAVE marker happened to pin.
let cachedEmailAttachments = [];

/* ============================================================================
 * INTENT DETECTION — mutually exclusive, evaluated in declared order
 * ========================================================================== */

/* AI INTENT CLASSIFIER replaces the keyword-based predicates. One gpt-4o-mini
 * call per turn classifies the message + recent history into one of ~17
 * intents. Handlers still do their own per-handler GPT extraction; the
 * classifier exists purely for routing. Markers in prior assistant turns
 * (SAVE_MARKER_RE / DELETE_MARKER_RE / To:Subject: drafts) bias the
 * classifier toward the right approval intent.
 */

const EMAIL_APPROVAL_PHRASES = [
  "send it", "yes send", "yes send it", "send", "go", "go ahead",
  "do it", "looks good", "yes", "yep", "yeah", "ok send it", "okay send it",
];

// Still used inside the email_send handler to detect an approval vs a fresh
// send (kept as helper because the handler internals reference it).
function isEmailApprovalPhrase(msg) {
  const m = msg.toLowerCase().trim().replace(/[.!?]+$/, "");
  return EMAIL_APPROVAL_PHRASES.some((p) => m === p || m.startsWith(p + " "));
}

// Markers embedded in confirmation prompts so subsequent turns can recover
// the pinned IDs without session storage.
const DELETE_MARKER_RE = /\[delete:([A-Za-z0-9_\-]+)\]/;
// Email-to-drive marker: email_read emits this after finding an attachment;
// the next-turn email_to_drive reads emailId | attachmentId | filename out of
// it and saves without re-fetching Gmail or running any disambig.
const SAVE_MARKER_RE = /<!--SAVE:([^|]+)\|([^|]+)\|([^>]+?)-->/;

// Strict ID validation for every Google API response. Real Gmail/Drive IDs
// are 16+ chars of alphanumeric — anything shorter or containing "fake" is
// fabricated/test data and must never reach Claude. Applied uniformly across
// email_read, drive_search, drive_move, drive_share, drive_delete, and
// email_to_drive (parity per Brad's spec).
function hasValidGoogleId(item) {
  return (
    item &&
    typeof item.id === "string" &&
    item.id.length > 10 &&
    !item.id.includes("fake")
  );
}

async function classifyIntent(message, history) {
  const lastFewMessages = history
    .slice(-6)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Classify what Brad wants to do. Return JSON with ONE intent and extracted details.

Intents:
- "email_read" - read/search/find emails in inbox
- "email_send" - send or draft a NEW email
- "email_approve" - Brad is approving a draft email shown in the previous assistant message (e.g. "yes send it", "send", "yes" when the prior turn shows To:/Subject:/Body:)
- "email_to_drive" - save an email attachment to a Google Drive folder; this includes any "yes save to X" / folder-name reply when the previous assistant message contains a SAVE marker
- "calendar_read" - check schedule/calendar
- "calendar_write" - add/move/delete calendar events
- "drive_search" - find files in Google Drive
- "drive_create" - create a new folder in Drive
- "drive_move" - move a file/folder in Drive to a different folder
- "drive_share" - share a Drive file with someone
- "drive_delete" - delete/trash a Drive file, OR approve a delete with "yes delete it" when the previous assistant message contains a "[delete:" marker
- "drive_read" - read contents of a specific Drive file
- "drive_revert" - "put it back" / "move it back" — Brad wants to undo a previous move but we don't track move history
- "departure" - when to leave, drive time, traffic
- "reminder_set" - set a NEW reminder
- "reminder_check" - check existing reminders
- "reminder_delete" - delete all reminders
- "chat" - general conversation, none of the above

Return JSON:
{
  "intent": "one of the above",
  "confidence": 0-100,
  "details": {
    "searchTerm": "if searching",
    "folderName": "if drive folder involved",
    "fileName": "if specific file mentioned",
    "emailId": "if specific email referenced",
    "personName": "if person mentioned",
    "time": "if time mentioned",
    "message": "if reminder message"
  }
}

CRITICAL routing rules:
- Any "yes save to X" / "save it to X" / "put it in X" / bare folder name when prior assistant message contains "<!--SAVE:" → email_to_drive
- "yes delete it" when the prior assistant message contains "[delete:" → drive_delete
- "yes send it" / "send it" / "send" / "yes" when the prior assistant message contains a To: and Subject: draft → email_approve
- Without those markers/drafts, those short approval phrases default to "chat"
- "find" / "search" / "get" about inbox content → email_read; about files → drive_search
- "put it back" / "move it back" → drive_revert (NOT drive_move — we don't know where it came from)
- "move my meeting to Friday" → calendar_write (NOT drive_move — "meeting" is a calendar word)
- searchTerm extraction: when Brad says "T&K Roofing" or "TK Roofing", search for "tnkroofing" because that's the email domain. Extract the most likely Gmail search query, not just the name Brad said.

Context from recent conversation:
${lastFewMessages}`,
      },
      { role: "user", content: message },
    ],
  });

  return JSON.parse(result.choices[0].message.content);
}

/* ============================================================================
 * SYSTEM PROMPT
 * ========================================================================== */

const HALLUCINATION_GUARD = `
ABSOLUTE RULE: You cannot claim to have done something you haven't.
If an API call was not made, say "I was unable to complete that."
Never say "Done", "Submitted", "Sent", or "Saved" unless an API returned success:true.
If you are not sure if something worked, say "I'm not sure if that worked - please verify."
`;

function buildSystemPrompt(today, memoryText) {
  return `You are Jess, Brad's executive assistant.
Today: ${today}
Brad's home: ${HOME}
Brad's shop: ${SHOP}

Memory:
${memoryText || "No memories yet."}
${HALLUCINATION_GUARD}
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
12. When saving email attachments to Drive, ALWAYS show the filename first and confirm with Brad before saving. Never save attachments from emails Brad didn't specify.

DEPARTURE ORIGIN POLICY:
For departure times, use your best judgment on origin — never ask for confirmation unless genuinely ambiguous:
- If Brad mentions shop/office/work = use SHOP (${SHOP})
- If Brad mentions home/house = use HOME (${HOME})
- If unclear and it's a morning appointment, default to HOME
- If unclear and Brad is mid-workday, default to SHOP

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

// Stream an Anthropic messages.create call back to the client as SSE so the
// frontend can render token-by-token. Used only for conversational Claude
// responses (chat, email_read narration, calendar_read narration); structured
// handlers (quote, reminder, drive actions) keep returning Response.json so
// callers don't have to parse two transport formats.
//
// We don't run cleanResponse here — its regexes target multi-character XML/
// code-fence sequences that can split across deltas. Those patterns shouldn't
// appear in normal Claude output; if they ever do we'll strip client-side.
function streamAnthropicResponse(params, appendText = "") {
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        const stream = await anthropic.messages.create({ ...params, stream: true });
        for await (const chunk of stream) {
          if (chunk.type === "content_block_delta" && chunk.delta?.type === "text_delta") {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`)
            );
          }
        }
      } catch (e) {
        console.log("[stream] anthropic stream failed:", e.message);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: e.message })}\n\n`)
        );
      }
      if (appendText) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ text: appendText })}\n\n`)
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

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

// Deterministic company-name → Gmail-domain-stub overrides. Gmail's from:
// operator matches substrings of the address, so from:tnkroofing finds anything
// from @tnkroofing.com. Add entries here when GPT keeps missing a known sender.
const COMPANY_DOMAIN_OVERRIDES = {
  "t&k": "tnkroofing",
  "t&k roofing": "tnkroofing",
  "tk roofing": "tnkroofing",
  "t and k": "tnkroofing",
  "t and k roofing": "tnkroofing",
  "tnk": "tnkroofing",
};

async function buildEmailSearchQuery(personDescription, opts = {}) {
  const hasAttachment = opts.hasAttachment === true;
  const overrideKey = personDescription.toLowerCase().trim();
  const override = COMPANY_DOMAIN_OVERRIDES[overrideKey] || null;

  let queries = [];
  try {
    const result = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Build Gmail search queries for finding emails involving a person or company.
Return JSON: { "queries": ["query1", "query2", "query3"] }
Rules:
- Never include in:inbox, is:unread, label:, or any other Gmail filter operator that over-restricts results.
- For COMPANY names, include a from:<domain-stub> query where domain-stub is the company name lowercased with spaces, ampersands, hyphens, and punctuation stripped (Gmail's from: matches substrings of email addresses).
- For PERSONAL names, use from:/cc:/to: with the name plus a bare-name query.
Examples:
- "Eric Brandley" (personal) -> ["Eric Brandley", "from:Eric Brandley", "cc:Eric Brandley", "to:Eric Brandley"]
- "Nicole" (personal) -> ["Nicole", "from:Nicole", "cc:Nicole", "to:Nicole"]
- "T&K Roofing" (company) -> ["from:tnkroofing", "T&K Roofing", "from:T&K Roofing"]
- "WattMonk" (company) -> ["from:wattmonk", "WattMonk", "from:WattMonk"]
- "Green Tech Solar" (company) -> ["from:greentechsolar", "Green Tech Solar", "from:Green Tech"]
Generate 3-4 different query variations to maximize chances of finding the emails.`,
        },
        {
          role: "user",
          content: `Find emails involving: ${personDescription}`,
        },
      ],
    });
    const parsed = JSON.parse(result.choices[0].message.content);
    queries = Array.isArray(parsed?.queries) ? parsed.queries.filter(Boolean) : [];
  } catch (e) {
    console.log("[buildEmailSearchQuery] failed:", e.message);
  }

  // Promote the deterministic override to position 0 — Gmail returns the
  // tightest matches for an exact from: domain query.
  if (override) {
    queries = queries.filter((q) => q.toLowerCase() !== `from:${override}`);
    queries.unshift(`from:${override}`);
  }

  if (queries.length === 0) {
    queries = [`from:${personDescription} OR cc:${personDescription} OR to:${personDescription}`];
  }

  if (hasAttachment) {
    queries = queries.map((q) => `${q} has:attachment`);
  }

  console.log(
    `[buildEmailSearchQuery] "${personDescription}" hasAtt=${hasAttachment} override=${override || "none"} ->`,
    JSON.stringify(queries)
  );
  return queries;
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

  // Compute today + tomorrow in Phoenix time so the prompt is anchored to the
  // actual current Phoenix date, not a UTC ISO that GPT may misinterpret after
  // 5pm Phoenix when UTC has already rolled to the next day.
  const phoenixDate = (d) =>
    new Intl.DateTimeFormat("en-CA", {
      year: "numeric", month: "2-digit", day: "2-digit", timeZone: TIMEZONE,
    }).format(d);
  const todayPhoenix = phoenixDate(new Date());
  const tomorrowPhoenix = phoenixDate(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const todayLabel = new Date().toLocaleDateString("en-US", {
    timeZone: TIMEZONE, weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const tomorrowLabel = new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString("en-US", {
    timeZone: TIMEZONE, weekday: "long", month: "long", day: "numeric",
  });

  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Today is ${todayLabel}.
Phoenix AZ timezone is ALWAYS UTC-7, no daylight saving time, ever.
To convert Phoenix time to UTC: add exactly 7 hours.

Examples (using today's actual date):
- ${tomorrowLabel} at 10:30 AM Phoenix = ${tomorrowPhoenix}T17:30:00Z
- ${todayLabel} at 7:45 AM Phoenix = ${todayPhoenix}T14:45:00Z
- Phoenix 6 PM (18:00) plus 7 hours rolls the UTC date forward by 1 day (so "tonight 6 PM" on ${todayLabel} = ${tomorrowPhoenix}T01:00:00Z).

Return JSON: {"message": "what to remind Brad about (concise)", "time": "UTC ISO timestamp ending in Z"}

CRITICAL: Use the actual current date shown above. Never guess the date. Never reuse an example date verbatim — compute against today.

Write the reminder message in first person as an action, not as "Remind Brad to..." or "Brad needs to...".
Examples:
WRONG: "Remind Brad to leave the shop for BNI"
RIGHT: "Leave the shop for BNI"
WRONG: "Brad needs to call Nicole"
RIGHT: "Call Nicole"
WRONG: "Reminder for Brad to email Yvonne"
RIGHT: "Email Yvonne"

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

// Pick a specific email from cachedEmailAttachments when Brad's message
// references one ("May 1st", "the Pershing one", "the first one", "today's").
// Returns the matched email or null. Caller falls back to the SAVE marker.
//
// Tie-breaking: when multiple emails match a filter, the first one (most
// recent in the cache's newest-first ordering) wins — except for "first" /
// "older" / "earliest" which deliberately pick the oldest.
function pickSaveCandidate(message, cache) {
  if (!cache || cache.length === 0) return null;
  const m = message.toLowerCase();

  // "today's" / "this morning's" → most recent (cache is newest-first).
  if (/\b(?:today'?s?|this\s+morning'?s?|latest|newest|most\s+recent)\b/.test(m)) {
    return cache[0];
  }

  // "the first one" / "older" / "oldest" / "earliest" → oldest in the list.
  if (/\b(?:first\s+one|the\s+older(?:\s+one)?|oldest|earliest|earlier\s+one)\b/.test(m)) {
    return cache[cache.length - 1];
  }

  // Date filter: "May 1", "May 1st", "1 May".
  const MONTHS = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const monthDay = m.match(new RegExp(`\\b${MONTHS}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i"));
  const dayMonth = m.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTHS}\\b`, "i"));
  if (monthDay || dayMonth) {
    const monthAbbr = (monthDay?.[1] || dayMonth?.[2]).toLowerCase().slice(0, 3);
    const day = parseInt(monthDay?.[2] || dayMonth?.[1], 10);
    const filtered = cache.filter((e) => {
      const dt = (e.date || "").toLowerCase();
      return dt.includes(monthAbbr) && new RegExp(`\\b${day}\\b`).test(dt);
    });
    if (filtered.length > 0) return filtered[0];
  }

  // Subject filter: capitalized proper-noun-like tokens from the portion of
  // the message BEFORE "to"/"in"/"into" (so folder-name words like "Roof
  // Quotes" don't match against subjects).
  const STOP = new Set([
    "Save", "Move", "Drive", "Drop", "Put", "Pdf", "Folder", "The", "Both",
    "All", "And", "Or", "Brad", "Jess", "Yes", "Yep", "Ok", "Okay",
    "Attachment", "Attachments", "Email", "Emails", "File", "Files",
  ]);
  const leftOfFolder = message.split(/\b(?:to|in|into)\b/i)[0] || message;
  const candidates = (leftOfFolder.match(/\b[A-Z][a-zA-Z]{2,}\b/g) || []).filter(
    (w) => !STOP.has(w)
  );
  for (const word of candidates) {
    const wLower = word.toLowerCase();
    const filtered = cache.filter((e) =>
      (e.subject || "").toLowerCase().includes(wLower)
    );
    if (filtered.length > 0) return filtered[0];
  }

  return null;
}

// Recover the pinned save target from the previous assistant message.
// Marker format: <!--SAVE:emailId|attachmentId|filename-->
function parseSaveMarker(text) {
  if (!text) return null;
  const match = text.match(SAVE_MARKER_RE);
  if (!match) return null;
  const [, emailId, attachmentId, filename] = match;
  if (!emailId || !attachmentId) return null;
  return { emailId, attachmentId, filename };
}

// Pull a folder name out of Brad's approval message. Looks for "to/in/into X"
// or a bare folder-name reply. Returns null when nothing matches.
function extractFolderFromMessage(message) {
  if (!message) return null;
  const m = message.trim();
  const patterns = [
    /\b(?:to|in|into)\s+(?:the\s+)?["']([^"']+)["']\s+folder\b/i,
    /\b(?:to|in|into)\s+(?:the\s+)?([A-Z][\w &'\-]{0,40}?)\s+folder\b/,
    /\b(?:to|in|into)\s+["']([^"']+)["']/i,
    /\b(?:to|in|into)\s+([A-Z][\w &'\-]{0,40}?)[.!?]?\s*$/,
    /\bfolder\s+(?:called\s+)?["']([^"']+)["']/i,
    /^([A-Z][\w &'\-]{1,40})[.!?]?\s*$/,
  ];
  for (const re of patterns) {
    const match = m.match(re);
    if (match && match[1]) return match[1].trim();
  }
  return null;
}

/* ============================================================================
 * DEPARTURE HELPERS
 * ========================================================================== */

// Returns SHOP / HOME if the text explicitly names one of Brad's locations,
// otherwise null. Caller decides what default to apply.
function detectExplicitDepartureOrigin(text) {
  const m = (text || "").toLowerCase();
  // SHOP precedence — explicit SHOP refs and negated-HOME refs ("not from
  // home", "not leaving home", "not at home") both mean SHOP. Without this
  // "I'm not leaving from home, I'm leaving from the shop" would default to
  // HOME because the message contains "from home" as a substring.
  if (
    /\bfrom\s+(?:the\s+)?shop\b/.test(m) ||
    /\bleaving\s+(?:the\s+)?shop\b/.test(m) ||
    /\bat\s+the\s+shop\b/.test(m) ||
    /\bin\s+the\s+shop\b/.test(m) ||
    /\bnot\s+(?:leaving\s+)?(?:from\s+)?home\b/.test(m) ||
    /\bnot\s+at\s+home\b/.test(m)
  ) {
    return SHOP;
  }
  if (
    /\bfrom\s+home\b/.test(m) ||
    /\bfrom\s+my\s+house\b/.test(m) ||
    /\bat\s+home\b/.test(m) ||
    /\bleaving\s+home\b/.test(m)
  ) {
    return HOME;
  }
  return null;
}

// Resolve departure origin with a layered policy: explicit message marker →
// recent user-turn marker in history → time-of-day default. We never ask Brad
// to confirm — he can correct mid-conversation and the recent-history check
// picks up the correction next turn. Workday rhythm:
//   < 12:00 PM  → HOME (heading out for the day)
//   12:00-5 PM  → SHOP (mid-workday — most likely at the shop)
//   ≥ 5:00 PM  → HOME (back home, leaving from there)
function detectDepartureOrigin(message, history = []) {
  const fromMessage = detectExplicitDepartureOrigin(message);
  if (fromMessage) return fromMessage;

  for (let i = history.length - 1; i >= Math.max(0, history.length - 6); i--) {
    const turn = history[i];
    if (turn?.role !== "user") continue;
    const fromHistory = detectExplicitDepartureOrigin(turn.content);
    if (fromHistory) return fromHistory;
  }

  const phoenixHour = parseInt(
    new Date().toLocaleString("en-US", {
      hour: "numeric", hour12: false, timeZone: TIMEZONE,
    }),
    10
  );
  if (phoenixHour < 12) return HOME;
  if (phoenixHour < 17) return SHOP;
  return HOME;
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

    // Quote routing is a hard pre-check, not classifier-driven: the AI classifier
    // was over-triggering on stray mentions of "tile" / addresses. Require all three
    // signals literally in the message.
    const isQuoteRequest =
      /\bquote\b/i.test(message) &&
      /\b(tile|shingle|flat)\b/i.test(message) &&
      /\b\d+\s+[A-Za-z][A-Za-z0-9.\s]*?\b(street|st|avenue|ave|road|rd|drive|dr|place|pl|lane|ln|boulevard|blvd|court|ct|circle|cir|way|terrace|trail|highway|hwy|parkway|pkwy)\b\.?/i.test(message);

    // Email-to-drive routing: three cases force email_to_drive ahead of the
    // classifier so verbs like "move" don't drift to drive_move and bare
    // folder names don't drift to chat.
    //   (a) Prior assistant turn has a SAVE marker AND message has an
    //       approval verb.
    //   (b) cachedEmailAttachments is non-empty AND message resolves to a
    //       specific cached item ("save the May 1st one to X").
    //   (c) cachedEmailAttachments is non-empty AND message is a generic
    //       save/move directed at a folder ("save it to Roof Quotes",
    //       "put it in the folder") — we'll use the last cached attachment.
    const lastAssistantTurn = history.filter((h) => h.role === "assistant").slice(-1)[0];
    const savePending = parseSaveMarker(lastAssistantTurn?.content || "");
    const isAttachmentApproval =
      !!savePending &&
      /\b(?:yes|yep|yeah|ok|okay|sure|save|put|to|in|into|drop|move)\b/i.test(message);
    const isCacheReferenceSave =
      cachedEmailAttachments.length > 0 &&
      /\b(?:save|move|put|upload|drop|stick)\b/i.test(message) &&
      !!pickSaveCandidate(message, cachedEmailAttachments);
    const isGenericCacheSave =
      cachedEmailAttachments.length > 0 &&
      /\b(?:save|move|put|upload|drop|stick)\s+(?:it|that|this|the\s+(?:attachment|file|pdf))\b/i.test(message);

    let intent;
    if (isQuoteRequest) {
      intent = { intent: "quote", confidence: 100 };
    } else if (isAttachmentApproval || isCacheReferenceSave || isGenericCacheSave) {
      intent = { intent: "email_to_drive", confidence: 100 };
    } else {
      intent = await classifyIntent(message, history);
    }
    console.log("Intent classified:", intent.intent, "confidence:", intent.confidence);

    switch (intent.intent) {
    // DELETE REMINDERS
    case "reminder_delete": {
      const result = await deleteAllReminders();
      if (result.success) return Response.json({ reply: "Done — all reminders deleted." });
      return Response.json({ reply: "I had trouble deleting reminders: " + (result.error || "unknown") });
    }

    // CHECK REMINDERS
    case "reminder_check": {
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

    // SET REMINDER
    case "reminder_set": {
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

    // EMAIL READ
    case "email_read": {
      const lower = msg.toLowerCase();

      // Detect "with attachments" / "that has attachments" / etc. so the Gmail
      // query gets the has:attachment operator. Gmail's has:attachment is
      // built-in and reliable — far better than fetching everything and
      // filtering client-side.
      const wantsAttachments =
        /\b(?:with|having)\s+(?:an?\s+)?attachments?\b/i.test(msg) ||
        /\bthat\s+(?:has|have)\s+attachments?\b/i.test(msg) ||
        /\bhas\s+attachments?\b/i.test(msg);

      // Person extraction. Captures multi-word names (e.g. "Eric Brandley") by
      // grabbing everything from the trigger word until punctuation or EOL,
      // then trimming filler words off the tail.
      const STOP = ["i", "you", "we", "they", "he", "she", "me", "us", "someone", "anyone", "the", "a", "an"];
      const TAIL_FILLER = /\s+(?:please|today|now|recently|lately|ever|yesterday|this week|last week|with\s+(?:an?\s+)?attachments?|that\s+(?:has|have)\s+attachments?|having\s+attachments?|has\s+attachments?)\.?$/i;
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

      // Build queries. Use GPT (+ deterministic overrides) to expand the
      // person/company description into 3-4 Gmail query variations and run
      // them in parallel. If Brad mentioned attachments, every variation
      // gets has:attachment appended.
      let queries = null;
      if (searchedName) {
        queries = await buildEmailSearchQuery(searchedName, { hasAttachment: wantsAttachments });
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

      // STAGE 1 — hard block on zero results. Claude is NEVER invoked when
      // the API returned an empty list; the fixed reply below is the only
      // thing Brad sees, so the model cannot fabricate email content.
      const emails = rawEmails || [];
      if (emails.length === 0) {
        return Response.json({
          reply: "I searched your inbox and found nothing matching that. Try a different search term.",
        });
      }

      // STAGE 2 — ID validation. Every email must carry a real Gmail
      // message id (>10 chars, no "fake" substring). Anything weaker is
      // garbage/fabricated upstream and must never reach Claude. We
      // distinguish this case from the empty-result case so a malformed
      // upstream response doesn't masquerade as "no matches".
      const realEmails = emails.filter(
        (e) =>
          e &&
          typeof e.id === "string" &&
          e.id.length > 10 &&
          !e.id.includes("fake")
      );
      const dropped = emails.length - realEmails.length;
      if (dropped > 0) {
        console.log(`[email read] DROPPED ${dropped} email(s) failing ID validation`);
      }
      if (realEmails.length === 0) {
        return Response.json({
          reply: "The search returned results but none had valid email IDs. Try again.",
        });
      }

      // ONLY reach Claude when we have REAL email data (every entry has a
      // verified Gmail id).
      const emailContext = realEmails
        .map(
          (e, i) =>
            `${i + 1}. ID:${e.id} From:${e.from} (${e.fromEmail}) Subject:${e.subject} Date:${e.date} Body:${e.body?.slice(0, 200) || ""}`
        )
        .join("\n\n");

      const groupingHint = searchedName
        ? `\n\nThe results above were the union of multiple Gmail searches (${queries.join(" | ")}), already deduped and sorted newest-first. List EVERY email shown above, grouped by date (most recent date first), with subject + sender. Do not omit any.`
        : "";

      const emailGuardrail =
        "\n\nEMAIL SUMMARY GUARDRAIL:\nThese are the ONLY emails that exist. Do not mention any email not in this list. If asked about a specific sender not in this list, say you found nothing from them. Never invent subjects, dates, or content. If the list above is empty, say you found nothing.";

      // Cache every attachment-bearing email so a follow-up like "save the
      // May 1st one" or "save the Pershing one" can find the right
      // attachmentId even though the SAVE marker only pins the FIRST item.
      // Only replace the cache when this search actually returned attachments
      // — a zero-attachment search shouldn't wipe context Brad still relies on.
      const freshAttachmentEmails = realEmails
        .filter((e) => Array.isArray(e.attachments) && e.attachments.length > 0)
        .map((e) => ({
          emailId: e.id,
          from: e.fromEmail,
          subject: e.subject,
          date: e.date,
          internalDate: e.internalDate,
          attachments: e.attachments,
        }));
      if (freshAttachmentEmails.length > 0) {
        cachedEmailAttachments = freshAttachmentEmails;
        console.log("[email read] cache replaced with", cachedEmailAttachments.length, "attachment-bearing email(s)");
      } else {
        console.log("[email read] no attachments in results; keeping existing cache of", cachedEmailAttachments.length);
      }

      // If any result has an attachment, pin the FIRST one in a SAVE marker
      // and offer to save it. Brad's next turn ("yes save to Roof Quotes" /
      // bare folder name) gets routed straight to email_to_drive, which reads
      // emailId/attachmentId/filename out of the marker.
      const emailWithAttachment = realEmails.find(
        (e) => Array.isArray(e.attachments) && e.attachments.length > 0
      );
      let saveSuffix = "";
      if (emailWithAttachment) {
        const att = emailWithAttachment.attachments[0];
        const safeFilename = (att.filename || "attachment").replace(/[|>]/g, "_");
        saveSuffix = `\n\nI found "${att.filename}" attached. Want me to save it to Drive? If so, which folder?\n<!--SAVE:${emailWithAttachment.id}|${att.attachmentId}|${safeFilename}-->`;
        console.log("[email read] pinned attachment for save:", att.filename);
      }

      return streamAnthropicResponse(
        {
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
        },
        saveSuffix
      );
    }

    // EMAIL SEND (covers both fresh sends and approval of a prior draft;
    // the handler body uses isEmailApprovalPhrase + lookedLikeEmailDraft
    // to decide which path internally).
    case "email_send":
    case "email_approve": {
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

    // QUOTE
    case "quote": {
      const extracted = await extractQuoteDetails(message);
      console.log("[quote] extracted:", JSON.stringify(extracted));

      if (!extracted.customerName || !extracted.customerAddress || !extracted.roofMaterial) {
        return Response.json({
          reply: "I need the customer name, address, and roof material (Tile, Shingle, or Flat) to submit the quote.",
        });
      }

      console.log("SUBMITTING QUOTE for:", extracted.customerName);
      const res = await fetch(`${BASE_URL}/api/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(extracted),
      });
      const data = await res.json();
      console.log("QUOTE RESULT:", JSON.stringify(data));

      if (data.success) {
        try {
          await insertMemoryWithCap(
            `[LOG] Submitted T&K quote for ${extracted.customerName} at ${extracted.customerAddress} (${extracted.roofMaterial}) on ${today}`
          );
        } catch (e) { console.log("[quote] memory log failed:", e.message); }
        return Response.json({
          reply: `Quote submitted to T&K Roofing for ${extracted.customerName} at ${extracted.customerAddress}. Roof: ${extracted.roofMaterial}. They respond in 15-30 minutes.`,
        });
      }
      return Response.json({ reply: "Quote submission failed: " + (data.error || "unknown") });
    }

    // DRIVE SEARCH
    case "drive_search": {
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

      // ID validation: drop anything failing the strict Google ID check
      // (length > 10 + no "fake" substring). Parity with email_read.
      const validFiles = (driveData.files || []).filter(hasValidGoogleId);

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

    // DRIVE CREATE FOLDER
    case "drive_create": {
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

    // DRIVE REVERT — "put it back" / "move it back". We don't track move
    // history, so ask for the destination explicitly rather than guess.
    case "drive_revert": {
      return Response.json({
        reply: "I don't track where files came from, so I can't put it back automatically. Which folder should I move it to?",
      });
    }
    // DRIVE MOVE — extract source + target, look up source, call PATCH move.
    case "drive_move": {
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
      const candidates = (sData.files || []).filter(hasValidGoogleId);

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

    // DRIVE DELETE — handles both fresh delete requests and "yes delete it"
    // approvals of a prior confirmation prompt. Approval is detected via
    // [delete:...] marker in the previous assistant turn.
    case "drive_delete": {
      const lastAssistantForDel = history.filter((h) => h.role === "assistant").slice(-1)[0];
      const trimmedDelMsg = msg.trim().replace(/[.!?]+$/, "");
      const isDelApproval =
        trimmedDelMsg === "yes delete it" &&
        DELETE_MARKER_RE.test(lastAssistantForDel?.content || "");

      if (isDelApproval) {
        const idMatch = lastAssistantForDel.content.match(DELETE_MARKER_RE);
        const fileId = idMatch?.[1];
        if (!fileId) {
          return Response.json({
            reply: "I lost track of which file you confirmed. Tell me which file to delete and I'll ask again.",
          });
        }
        const nameMatch = lastAssistantForDel.content.match(/delete\s+["']([^"']+)["']/i);
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

      // Fresh delete request — find the file, show it, ask for confirmation.
      // Embeds the file ID as a [delete:...] marker so the approval branch
      // above can recover it. NO API call until Brad responds with "yes delete it".
      {
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
      const candidates = (sData.files || []).filter(hasValidGoogleId);

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

    }
    // DRIVE SHARE — extract source + recipient, look up source, call PATCH
    // share. Never hands off to Claude.
    case "drive_share": {
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
      const candidates = (sData.files || []).filter(hasValidGoogleId);

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

    // DRIVE READ — same pattern as share: needs a file ID first.
    case "drive_read": {
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

    // EMAIL-TO-DRIVE — strict two-turn flow.
    //   Turn 1 (email_read): pinned the first attachment in a SAVE marker
    //   AND cached every attachment-bearing email in cachedEmailAttachments.
    //   Turn 2 (here): pickSaveCandidate first — if Brad referenced a
    //   specific item ("the May 1st one", "the Pershing one", "today's"),
    //   use THAT email's attachment instead of the default-pinned one. If no
    //   match, fall back to the SAVE marker. Then extract folder and save.
    case "email_to_drive": {
      const lastAssistant = history.filter((h) => h.role === "assistant").slice(-1)[0];
      const pinned = parseSaveMarker(lastAssistant?.content || "");
      const picked = pickSaveCandidate(message, cachedEmailAttachments);

      let target = null;
      if (picked) {
        const att = picked.attachments[0];
        if (att?.attachmentId) {
          target = {
            emailId: picked.emailId,
            attachmentId: att.attachmentId,
            filename: att.filename,
          };
          console.log("[email-to-drive] cache pick overrides marker:", {
            emailId: target.emailId,
            filename: target.filename,
            subject: picked.subject,
            date: picked.date,
          });
        }
      }
      if (!target && pinned) {
        target = pinned;
        console.log("[email-to-drive] using SAVE marker (default pinned)");
      }
      // Final fallback: bare "save it" / "put it in the folder" with no
      // specific reference AND no marker in history — use the most recently
      // cached attachment-bearing email.
      if (!target && cachedEmailAttachments.length > 0) {
        const last = cachedEmailAttachments[0];
        const att = last.attachments[0];
        if (att?.attachmentId) {
          target = {
            emailId: last.emailId,
            attachmentId: att.attachmentId,
            filename: att.filename,
          };
          console.log("[email-to-drive] using last cached attachment:", target.filename);
        }
      }

      if (!target) {
        return Response.json({
          reply: "I don't have an attachment pinned to save. Find the email first and I'll offer to save it.",
        });
      }

      const folderName = extractFolderFromMessage(message);
      if (!folderName) {
        return Response.json({
          reply: `Which folder should I save "${target.filename}" to?`,
        });
      }

      console.log("[email-to-drive] saving:", { ...target, folderName });

      let result;
      try {
        const res = await fetch(`${BASE_URL}/api/drive/email-to-drive`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            emailId: target.emailId,
            attachmentId: target.attachmentId,
            filename: target.filename,
            folderName,
          }),
        });
        result = await res.json();
      } catch (e) {
        return Response.json({ reply: `Upload failed: ${e.message}` });
      }
      console.log("[email-to-drive] result:", JSON.stringify(result));

      if (result.success !== true || !result.fileId || !result.link) {
        return Response.json({
          reply: `I couldn't save "${target.filename}". Error: ${result.error || "unknown error"}`,
        });
      }

      try {
        await insertMemoryWithCap(
          result.folderCreated
            ? `[LOG] Created Drive folder "${folderName}" and saved "${result.name}" on ${today}`
            : `[LOG] Saved attachment "${result.name}" to "${folderName}" on ${today}`
        );
      } catch (e) { console.log("[email-to-drive] memory log failed:", e.message); }

      return Response.json({
        reply: result.folderCreated
          ? `Created "${folderName}" folder and saved "${result.name}" to it. Link: ${result.link}`
          : `Saved "${result.name}" to ${folderName}. Link: ${result.link}`,
      });
    }

    // CALENDAR WRITE
    case "calendar_write": {
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

    // CALENDAR READ
    case "calendar_read": {
      // If the day Brad's asking about was already retrieved earlier in the conversation,
      // skip the fetch — Claude can answer from history. Only re-fetch when Brad explicitly
      // asks ("check my calendar again", "refresh", "any new events", etc.).
      if (calendarAlreadyInHistory(message, history) && !isExplicitCalendarRefresh(message)) {
        console.log("[calendar read] using cached calendar data from history; no fetch");
        return streamAnthropicResponse({
          model: CLAUDE_MODEL,
          max_tokens: 1024,
          system: buildSystemPrompt(today, memoryText),
          messages: [
            ...history.map((m) => ({ role: m.role, content: m.content })),
            { role: "user", content: message },
          ],
        });
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

      return streamAnthropicResponse({
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
    }

    // DEPARTURE
    case "departure": {
      // STRUCTURED RESPONSE — never streams. The reply is a single template
      // string built from Maps drive time + computed departure/reminder times,
      // returned in one Response.json call. Same rule applies to quote,
      // reminder_*, drive_*, and email_send: only chat, calendar_read, and
      // email_read use streamAnthropicResponse. Mixing streaming into a
      // structured reply produces garbled interleaved output.
      const origin = detectDepartureOrigin(message, history);
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

    // NORMAL CHAT — classifier returned "chat" or an unhandled intent.
    default: {
      return streamAnthropicResponse({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: buildSystemPrompt(today, memoryText),
        messages: [
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: message },
        ],
      });
    }
    }  // end switch
  } catch (error) {
    console.log("[chat] POST threw:", error.message);
    return Response.json({ reply: "Jess had an issue: " + error.message });
  }
}

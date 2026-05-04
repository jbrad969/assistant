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
10. Chain actions automatically`;
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
        content: `Extract reminder details. Today is ${todayIso}. Phoenix timezone is UTC-7 with no DST.
Return JSON: { "message": "what to remind", "time": "ISO timestamp in UTC" }
If day mentioned without year, use 2026. Convert Phoenix time to UTC by adding 7 hours.
If the conversation already establishes time/topic for the reminder, reuse them.`,
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
      if (!extracted.time || !extracted.message) {
        return Response.json({ reply: "What time and what should I remind you about?" });
      }
      const result = await saveReminder(extracted.message, extracted.time);
      if (result.error) {
        return Response.json({ reply: "I had trouble saving that reminder: " + result.error });
      }
      const displayTime = new Date(extracted.time).toLocaleString("en-US", {
        weekday: "long", hour: "numeric", minute: "2-digit", timeZone: TIMEZONE,
      });
      return Response.json({ reply: `Done — I'll remind you ${displayTime}: ${extracted.message}` });
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
          `${i + 1}. From: ${e.from}\nSubject: ${e.subject}\nDate: ${e.date}\nBody: ${(e.body || "").slice(0, 300)}`
        )
        .join("\n\n");

      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: buildSystemPrompt(today, memoryText),
        messages: [{ role: "user", content: `Summarize these emails for Brad:\n\n${emailContext}` }],
      });
      return Response.json({ reply: cleanResponse(response.content[0].text) });
    }

    // 5. EMAIL SEND
    if (isEmailSend(msg)) {
      const lastAssistantMsg = history.filter((m) => m.role === "assistant").slice(-1)[0];
      const isDraftApproval =
        msg.includes("send it") || msg.includes("yes send") || msg.includes("looks good");

      if (isDraftApproval && lastAssistantMsg?.content?.includes("To:")) {
        // Parse To/Subject/Body from the prior draft and send.
        const draftMatch = lastAssistantMsg.content.match(
          /To:\s*([^\n]+)\nSubject:\s*([^\n]+)\n\n([\s\S]+?)(?:\n---|\n\nShall|\n\nSend it\?|$)/
        );
        if (draftMatch) {
          const [, to, subject, body] = draftMatch;
          const result = await sendEmail(to.trim(), subject.trim(), body.trim());
          if (result.success) {
            return Response.json({ reply: `Email sent to ${to.trim()}.` });
          }
          return Response.json({
            reply: "I had trouble sending that email: " + (result.error || "unknown"),
          });
        }
      }

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
          {
            role: "user",
            content: `Brad asked: "${message}"\n\nCalendar data:\n${calendarContext}\n\nNarrate this naturally and briefly.`,
          },
        ],
      });
      return Response.json({ reply: cleanResponse(response.content[0].text) });
    }

    // 9. DEPARTURE
    if (isDeparture(msg)) {
      const origin = msg.includes("shop") || msg.includes("office") ? SHOP : HOME;
      const dates = getDetectedDates(message);
      const schedule = await getCalendar(dates[0]);
      const events = schedule.events || [];
      const eventWithLocation = events.find((e) => e.location && e.location.length > 0);

      if (!eventWithLocation) {
        return Response.json({
          reply: "I can see your calendar but none of the upcoming events have a location listed. What address are you heading to?",
        });
      }

      const maps = await getDriveTime(origin, eventWithLocation.location);
      if (!maps) {
        return Response.json({
          reply: "I'm having trouble reaching Google Maps right now. Try again in a moment.",
        });
      }

      const driveMinutes = maps.driveTimeMinutes;
      const eventTime = new Date(eventWithLocation.start);
      const departureTime = new Date(eventTime.getTime() - (driveMinutes + 10) * 60000);
      const departureStr = departureTime.toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", timeZone: TIMEZONE,
      });

      return Response.json({
        reply: `Leave ${origin === HOME ? "home" : "the shop"} by ${departureStr} to make your ${eventWithLocation.time} ${eventWithLocation.title} at ${eventWithLocation.location}. That's a ${driveMinutes}-minute drive with a 10-minute buffer.`,
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

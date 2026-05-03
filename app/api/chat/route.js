import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TIME_ZONE = "America/Phoenix";

/* ---------------- MEMORY ---------------- */

async function getMemory() {
  const { data } = await supabase
    .from("memory")
    .select("id, content")
    .order("created_at", { ascending: true });
  return data || [];
}

async function saveOrUpdateMemory(message, currentMemory) {
  const memoryText =
    currentMemory.length > 0
      ? currentMemory.map((m) => `ID: ${m.id} | ${m.content}`).join("\n")
      : "No memory yet.";

  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `
You manage Jess's long-term memory for Brad.

Existing memory:
${memoryText}

Return JSON only:
{
  "action": "none" | "insert" | "update",
  "id": "existing id or null",
  "content": "memory fact or null"
}

Rules:
- Save personal facts, preferences, names, important details.
- Do not save questions.
- Do not duplicate.
- Update if changed.
        `,
      },
      { role: "user", content: message },
    ],
  });

  const action = JSON.parse(result.choices[0].message.content);

  if (action.action === "insert" && action.content) {
    await supabase.from("memory").insert([{ content: action.content }]);
  }

  if (action.action === "update" && action.id && action.content) {
    await supabase
      .from("memory")
      .update({ content: action.content })
      .eq("id", action.id);
  }
}

/* ---------------- DATE LOGIC ---------------- */

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

  const days = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };

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

/* ---------------- CALENDAR WRITE ---------------- */

function isCalendarWrite(message) {
  const msg = message.toLowerCase();
  const writeVerb =
    /\b(add|schedule|create|book|cancel|delete|remove|move|reschedule|push)\b/.test(msg) ||
    msg.includes("set up");
  const calendarHint =
    /\b(meeting|appointment|event|call|lunch|dinner|breakfast|coffee|standup|interview|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(msg) ||
    /\d\s*(am|pm)/.test(msg) ||
    /\bat \d/.test(msg);
  return writeVerb && calendarHint;
}

async function extractEventDetails(message) {
  const todayLabel = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: TIME_ZONE,
  });

  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You convert natural-language calendar commands into JSON.

Today is ${todayLabel} (America/Phoenix timezone).

Return JSON:
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
      },
      { role: "user", content: message },
    ],
  });

  return JSON.parse(result.choices[0].message.content);
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
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: TIME_ZONE,
  }).formatToParts(new Date(iso));
  const hh = parts.find((p) => p.type === "hour")?.value || "00";
  const mm = parts.find((p) => p.type === "minute")?.value || "00";
  return `${hh}:${mm}`;
}

function getPhoenixDate(iso) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: TIME_ZONE,
  }).format(new Date(iso));
}

function addMinutesToDateTime({ date, time }, minutes) {
  const [hh, mm] = time.split(":").map(Number);
  let total = hh * 60 + mm + minutes;
  let dayOffset = 0;
  while (total >= 24 * 60) {
    total -= 24 * 60;
    dayOffset += 1;
  }
  while (total < 0) {
    total += 24 * 60;
    dayOffset -= 1;
  }
  let newDate = date;
  if (dayOffset !== 0) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + dayOffset);
    newDate = d.toISOString().slice(0, 10);
  }
  const newH = Math.floor(total / 60);
  const newM = total % 60;
  return {
    date: newDate,
    time: `${String(newH).padStart(2, "0")}:${String(newM).padStart(2, "0")}`,
  };
}

async function findEventByCriteria({ date, time, title }) {
  if (!date && !title) return [];
  const dateObj = date ? new Date(`${date}T12:00:00`) : new Date();
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_BASE_URL}/api/calendar/today?date=${encodeURIComponent(dateObj.toISOString())}`
  );
  const data = await res.json();
  const events = data.events || [];

  return events.filter((event) => {
    if (time) {
      const eventTime = getPhoenixHHMM(event.start);
      if (eventTime !== time) return false;
    }
    if (title) {
      const eventTitle = (event.title || "").toLowerCase();
      if (!eventTitle.includes(title.toLowerCase())) return false;
    }
    return true;
  });
}

/* ---------------- DEPARTURE ---------------- */

function isDepartureQuestion(message) {
  const msg = message.toLowerCase();
  const phrases = [
    "when do i need to leave",
    "when should i leave",
    "when do i leave",
    "should i leave",
    "time to leave",
    "leave now",
    "leave for",
    "how long will it take",
    "how long would it take",
    "how long does it take",
    "how long to get",
    "how long to drive",
    "drive time",
    "travel time",
    "how far is",
    "how far away",
    "distance to",
    "how's traffic",
    "hows traffic",
    "how is traffic",
    "what's traffic",
    "whats traffic",
  ];
  if (phrases.some((p) => msg.includes(p))) return true;

  if (
    msg.includes("traffic") &&
    /\b(appointment|next|meeting|job|event|drive|driving|destination)\b/.test(msg)
  ) {
    return true;
  }

  return false;
}

/* ---------------- CALENDAR ---------------- */

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

async function getCalendarForDate(date) {
  const iso = date.toISOString();
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_BASE_URL}/api/calendar/today?date=${encodeURIComponent(iso)}`
  );
  const data = await res.json();

  if (!data.events || data.events.length === 0) {
    return { label: formatDateLabel(date), text: "No events scheduled." };
  }

  const text = data.events
    .map((event) => {
      const location = event.location ? ` — ${event.location}` : "";
      return `${event.time} — ${event.title}${location}`;
    })
    .join("\n");

  return { label: formatDateLabel(date), text };
}

/* ---------------- EMAIL ---------------- */

function isEmailQuestion(message) {
  const msg = message.toLowerCase();
  return (
    msg.includes("email") ||
    msg.includes("eamil") ||
    msg.includes("gmail") ||
    msg.includes("inbox") ||
    msg.includes("unread") ||
    msg.includes("messages") ||
    msg.includes("did i get") ||
    msg.includes("any mail") ||
    msg.includes("check mail") ||
    msg.includes("read my")
  );
}

async function getEmails(all = false) {
  const limit = all ? "50" : "5";
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_BASE_URL}/api/email?limit=${limit}&all=${all}`
  );
  const data = await res.json();
  return data.emails || [];
}

/* ---------------- QUOTE ---------------- */

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

/* ---------------- MAIN ---------------- */

export async function POST(req) {
  try {
    const { message, history = [] } = await req.json();

    // MEMORY UPDATE
    const currentMemory = await getMemory();
    await saveOrUpdateMemory(message, currentMemory);

    const updatedMemory = await getMemory();
    const memoryText =
      updatedMemory.length > 0
        ? updatedMemory.map((m) => `- ${m.content}`).join("\n")
        : "";

    // QUOTE REQUEST
    if (isQuoteRequest(message)) {
      const extracted = await extractQuoteDetails(message);

      if (!extracted.customerName || !extracted.customerAddress || !extracted.roofMaterial) {
        return Response.json({
          reply: "I need a few more details for that quote. Can you give me the customer's full name, address, and roof material (Tile, Shingle, or Flat)?",
        });
      }

      const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(extracted),
      });

      const data = await res.json();

      if (data.success) {
        return Response.json({
          reply: `Done — quote request sent to T&K Roofing for ${extracted.customerName} at ${extracted.customerAddress}. They usually respond in 15-30 minutes. I'll keep an eye on your inbox.`,
        });
      } else {
        return Response.json({
          reply: `Something went wrong submitting the quote: ${data.error}`,
        });
      }
    }

    // EMAIL
    if (isEmailQuestion(message)) {
      const all = message.toLowerCase().includes("all");
      const emails = await getEmails(all);

      if (emails.length === 0) {
        return Response.json({ reply: "No unread emails right now." });
      }

      const emailContext = emails
        .map((e, i) => `${i + 1}. From: ${e.from}\nSubject: ${e.subject}\nPreview: ${e.body.slice(0, 200)}`)
        .join("\n\n");

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are Jess, Brad's executive assistant. 
Summarize these unread emails naturally and conversationally.
For each one mention who it's from and what it's about in plain English.
Flag anything urgent or from tnkroofing.com as a quote response.
No markdown. Be concise.`,
          },
          {
            role: "user",
            content: `Here are Brad's unread emails:\n\n${emailContext}`,
          },
        ],
      });

      return Response.json({
        reply: completion.choices[0].message.content,
      });
    }

    // CALENDAR WRITE
    if (isCalendarWrite(message)) {
      const details = await extractEventDetails(message);

      if (details.action === "add") {
        if (!details.title || !details.date || !details.time) {
          return Response.json({
            reply: "I need a title, date, and time to add that. Can you give me all three?",
          });
        }

        const start = { date: details.date, time: details.time };
        const durationMinutes = details.durationMinutes || 60;

        const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/calendar/today`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: details.title,
            start,
            durationMinutes,
            location: details.location,
          }),
        });
        const data = await res.json();

        if (!data.success) {
          return Response.json({ reply: `Couldn't add that event: ${data.error}` });
        }

        const dayLabel = formatDateLabel(new Date(`${details.date}T12:00:00`));
        const timeLabel = format12Hour(details.time);
        return Response.json({
          reply: `Done — added "${details.title}" on ${dayLabel} at ${timeLabel}.`,
        });
      }

      if (details.action === "delete") {
        const matches = await findEventByCriteria({
          date: details.date,
          time: details.time,
          title: details.title,
        });

        if (matches.length === 0) {
          return Response.json({
            reply: "Couldn't find an event matching that. Can you be more specific?",
          });
        }
        if (matches.length > 1) {
          const summary = matches.map((event) => `${event.time} ${event.title}`).join(", ");
          return Response.json({
            reply: `Found multiple matches: ${summary}. Which one should I delete?`,
          });
        }

        const event = matches[0];
        const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/calendar/today`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventId: event.id }),
        });
        const data = await res.json();

        if (!data.success) {
          return Response.json({ reply: `Couldn't delete that event: ${data.error}` });
        }

        const dayLabel = formatDateLabel(new Date(event.start));
        return Response.json({
          reply: `Done — deleted "${event.title}" on ${dayLabel} at ${event.time}.`,
        });
      }

      if (details.action === "move") {
        const matches = await findEventByCriteria({
          date: details.date,
          time: details.time,
          title: details.title,
        });

        if (matches.length === 0) {
          return Response.json({
            reply: "Couldn't find an event matching that. Can you be more specific?",
          });
        }
        if (matches.length > 1) {
          const summary = matches.map((event) => `${event.time} ${event.title}`).join(", ");
          return Response.json({
            reply: `Found multiple matches: ${summary}. Which one should I move?`,
          });
        }

        const event = matches[0];
        const startMs = new Date(event.start).getTime();
        const endMs = new Date(event.end).getTime();
        const durationMinutes = Math.max(15, Math.round((endMs - startMs) / 60000));

        const newDate = details.newDate || details.date || getPhoenixDate(event.start);
        const newTime = details.newTime || getPhoenixHHMM(event.start);

        if (!newDate || !newTime) {
          return Response.json({ reply: "I need a new date or time to move it to." });
        }

        const newStart = { date: newDate, time: newTime };
        const newEnd = addMinutesToDateTime(newStart, durationMinutes);

        const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/calendar/today`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            eventId: event.id,
            start: newStart,
            end: newEnd,
          }),
        });
        const data = await res.json();

        if (!data.success) {
          return Response.json({ reply: `Couldn't move that event: ${data.error}` });
        }

        const oldTimeLabel = event.time;
        const newTimeLabel = format12Hour(newTime);
        const dayLabel = formatDateLabel(new Date(`${newDate}T12:00:00`));

        return Response.json({
          reply: `Done — moved "${event.title}" to ${newTimeLabel} on ${dayLabel} (was ${oldTimeLabel}).`,
        });
      }

      // action === "none" — fall through to read/normal-chat handling
    }

    // DEPARTURE
    if (isDepartureQuestion(message)) {
      console.log("[chat] departure detected for message:", message);
      let data;
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/departure`);
        data = await res.json();
        console.log("[chat] departure response:", JSON.stringify(data));
        if (!res.ok && !data?.error) {
          data = { error: `departure API returned status ${res.status}` };
        }
      } catch (fetchErr) {
        console.log("[chat] departure fetch threw:", fetchErr.message);
        return Response.json({
          reply: `I couldn't reach the maps service: ${fetchErr.message}`,
        });
      }

      if (data.noEvent) {
        return Response.json({
          reply: "You don't have an upcoming event with a location in the next 24 hours.",
        });
      }
      if (data.error) {
        return Response.json({
          reply: `I couldn't check the drive time: ${data.error}`,
        });
      }

      const eventTimeLabel = new Date(data.event.start).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: TIME_ZONE,
      });

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are Jess, Brad's executive assistant.
Narrate departure timing naturally — like a real assistant briefing him.
USE THESE EXACT NUMBERS — do not estimate, recompute, or do math. Use the values verbatim.

Rules:
- Lead with WHEN to leave, using "Friendly departure time" verbatim (e.g., "right now", "in 12 minutes", "tomorrow at 8:35 AM").
- State the drive time in minutes. State the traffic delay only if it is 5 minutes or more.
- Mention the destination by event title and/or location.
- One or two sentences. No markdown. No bullet lists.`,
          },
          {
            role: "user",
            content: `Departure data:
- Next event: "${data.event.title}" at ${eventTimeLabel} at ${data.event.location}
- Friendly departure time: ${data.friendlyDepartureTime}
- Drive time with current traffic: ${data.driveTimeMinutes} minutes
- Traffic delay vs normal: ${data.trafficDelayMinutes} minutes
- Distance: ${data.distance || "unknown"}
- Origin: ${data.origin}

Brad asked: "${message}"`,
          },
        ],
      });

      return Response.json({ reply: completion.choices[0].message.content });
    }

    // CALENDAR
    if (isCalendarQuestion(message)) {
      const dates = getDetectedDates(message);
      const schedules = await Promise.all(dates.map(getCalendarForDate));

      const calendarContext = schedules
        .map((s) => `${s.label}:\n${s.text}`)
        .join("\n\n");

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are Jess, Brad's executive assistant.
Rules:
- Be direct and conversational, like a real assistant briefing their boss
- Summarize the schedule naturally, don't just list it robotically
- Mention the time and title of each event
- If there's a location, mention it naturally
- No markdown formatting
- Keep it tight — Brad is busy`,
          },
          {
            role: "user",
            content: `Here is Brad's calendar data:\n\n${calendarContext}\n\nHis question was: "${message}"`,
          },
        ],
      });

      return Response.json({
        reply: completion.choices[0].message.content,
      });
    }

    // NORMAL CHAT
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are Jess, Brad's executive assistant.

Memory:
${memoryText}

Rules:
- Use memory for personal questions
- Be direct and concise
- No fluff
- No markdown formatting
- Act like a real assistant`,
        },
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: message },
      ],
    });

    return Response.json({
      reply: completion.choices[0].message.content,
    });
  } catch (error) {
    return Response.json({
      reply: "Jess had an issue: " + error.message,
    });
  }
}

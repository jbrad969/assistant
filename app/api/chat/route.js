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

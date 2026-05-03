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

Examples:
"my dogs name is frank" -> insert
"my favorite color is blue" -> insert
"my favorite color is red now" -> update
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
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };

  for (const day in days) {
    if (msg.includes(day)) {
      dates.push(getNextDay(days[day]));
    }
  }

  if (dates.length === 0) dates.push(today);

  return dates;
}

function formatDateLabel(date) {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: TIME_ZONE,
  });
}

/* ---------------- CALENDAR ---------------- */

function isCalendarQuestion(message) {
  const msg = message.toLowerCase();

  return (
    msg.includes("schedule") ||
    msg.includes("calendar") ||
    msg.includes("today") ||
    msg.includes("tomorrow") ||
    msg.includes("monday") ||
    msg.includes("tuesday") ||
    msg.includes("wednesday") ||
    msg.includes("thursday") ||
    msg.includes("friday") ||
    msg.includes("saturday") ||
    msg.includes("sunday") ||
    msg.includes("what do i have")
  );
}

async function getCalendarForDate(date) {
  const iso = date.toISOString();

  const res = await fetch(
    `${process.env.NEXT_PUBLIC_BASE_URL}/api/calendar/today?date=${encodeURIComponent(iso)}`
  );

  const data = await res.json();

  if (!data.events || data.events.length === 0) {
    return {
      label: formatDateLabel(date),
      text: "No events scheduled.",
    };
  }

  const text = data.events
    .map((event) => {
      const location = event.location ? ` — ${event.location}` : "";
      return `${event.time} — ${event.title}${location}`;
    })
    .join("\n");

  return {
    label: formatDateLabel(date),
    text,
  };
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

    // CALENDAR (NO AI — DIRECT RESPONSE)
    if (isCalendarQuestion(message)) {
      const dates = getDetectedDates(message);
      const schedules = await Promise.all(dates.map(getCalendarForDate));

      const reply = schedules
        .map((s) => `${s.label}\n\n${s.text}`)
        .join("\n\n");

      return Response.json({ reply });
    }

    // NORMAL CHAT (USES MEMORY + HISTORY)
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are Jess, Brad's executive assistant.

Memory:
${memoryText}

Rules:
- Use memory for personal questions
- Be direct and concise
- No fluff
- No markdown formatting
- Act like a real assistant
          `,
        },
        ...history.map((m) => ({
          role: m.role,
          content: m.content,
        })),
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

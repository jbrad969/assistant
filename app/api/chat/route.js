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

async function getMemory() {
  const { data } = await supabase
    .from("memory")
    .select("id, content")
    .order("created_at", { ascending: true });

  if (!data) return [];
  return data;
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
- Save personal facts, preferences, business facts, names, important details.
- Do not save random questions.
- Do not duplicate existing facts.
- If Brad changes something, update the old memory.
- Be forgiving with spelling.

Examples:
"my dogs name is frank" -> insert "Brad's dog's name is Frank"
"my favorite color is blue" -> insert "Brad's favorite color is Blue"
"my favorite color is red now" -> update old favorite color memory
        `,
      },
      { role: "user", content: message },
    ],
  });

  const memoryAction = JSON.parse(result.choices[0].message.content);

  if (memoryAction.action === "insert" && memoryAction.content) {
    await supabase.from("memory").insert([{ content: memoryAction.content }]);
  }

  if (memoryAction.action === "update" && memoryAction.id && memoryAction.content) {
    await supabase
      .from("memory")
      .update({ content: memoryAction.content })
      .eq("id", memoryAction.id);
  }
}

function getNextDay(dayIndex) {
  const today = new Date();
  const result = new Date(today);
  const diff = (dayIndex + 7 - today.getDay()) % 7 || 7;
  result.setDate(today.getDate() + diff);
  return result;
}

function detectDate(message) {
  const msg = message.toLowerCase();
  const today = new Date();

  if (msg.includes("tomorrow")) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return d;
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
    if (msg.includes(day)) return getNextDay(days[day]);
  }

  return today;
}

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
    msg.includes("morning") ||
    msg.includes("afternoon") ||
    msg.includes("evening") ||
    msg.includes("what do i have") ||
    msg.includes("next appointment") ||
    msg.includes("next meeting")
  );
}

async function getCalendarForDate(date) {
  const iso = date.toISOString();

  const res = await fetch(
    `${process.env.NEXT_PUBLIC_BASE_URL}/api/calendar/today?date=${encodeURIComponent(
      iso
    )}`
  );

  const data = await res.json();

  if (!data.events || data.events.length === 0) {
    return "No events scheduled.";
  }

  return data.events
    .map((e) => {
      const location = e.location ? ` — ${e.location}` : "";
      return `${e.time} — ${e.title}${location}`;
    })
    .join("\n");
}

async function getTodayCalendar() {
  return await getCalendarForDate(new Date());
}

export async function POST(req) {
  try {
    const { message } = await req.json();

    const currentMemory = await getMemory();

    await saveOrUpdateMemory(message, currentMemory);

    const updatedMemory = await getMemory();
    const memoryText =
      updatedMemory.length > 0
        ? updatedMemory.map((m) => `- ${m.content}`).join("\n")
        : "No saved memory yet.";

    let calendarContext = "";

    if (isCalendarQuestion(message)) {
      const date = detectDate(message);
      calendarContext = await getCalendarForDate(date);
    } else {
      calendarContext = await getTodayCalendar();
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are Jess, Brad's executive assistant.

You have access to:

MEMORY:
${memoryText}

CALENDAR:
${calendarContext}

Rules:

1. If the user asks about their schedule:
- DO NOT rewrite or reformat the schedule
- DO NOT add markdown (no **, no bullets)
- DO NOT summarize unless asked
- JUST return the schedule exactly as provided
- Optionally add a short title like:
  "Tomorrow" or "Monday"

2. If the user asks a personal question:
- Use MEMORY
- Answer directly

3. Be concise:
- No filler
- No “your schedule includes”
- No explanations unless asked

4. Tone:
- Professional
- Direct
- Like a real assistant, not an AI
`

MEMORY:
${memoryText}

TODAY / REQUESTED CALENDAR:
${calendarContext}

Rules:
- Use memory for personal facts.
- Use calendar for schedule questions.
- If Brad asks about his day, summarize clearly.
- If there is a next event, mention it when helpful.
- Never say you don't have calendar access if calendar data is provided.
- Be direct, practical, and concise.
- Think ahead like an executive assistant.
- Suggest next steps only when useful.
          `,
        },
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

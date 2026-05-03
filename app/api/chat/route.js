import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const TIME_ZONE = "America/Phoenix";

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
    if (msg.includes(day)) {
      return getNextDay(days[day]);
    }
  }

  return today;
}

function formatDateLabel(date) {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: TIME_ZONE,
  });
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
    msg.includes("evening")
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

  if (data.error) {
    return {
      label: formatDateLabel(date),
      text: `Calendar error: ${data.error}`,
    };
  }

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

export async function POST(req) {
  try {
    const { message } = await req.json();

    if (isCalendarQuestion(message)) {
      const date = detectDate(message);
      const schedule = await getCalendarForDate(date);

      return Response.json({
        reply: `${schedule.label} Schedule\n\n${schedule.text}`,
      });
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are Jess, Brad's AI assistant. Be direct, concise, practical, and helpful.",
        },
        {
          role: "user",
          content: message,
        },
      ],
    });

    return Response.json({
      reply: completion.choices[0].message.content,
    });
  } catch (error) {
    return Response.json({
      reply: "Jess had an issue.",
      error: error.message,
    });
  }
}

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

function getNextDay(dayIndex) {
  const today = new Date();
  const result = new Date();

  const diff = (dayIndex + 7 - today.getDay()) % 7 || 7;
  result.setDate(today.getDate() + diff);

  return result;
}

async function getCalendarForDate(date) {
  const iso = date.toISOString();

  const res = await fetch(
    `${process.env.NEXT_PUBLIC_BASE_URL}/api/calendar/today?date=${iso}`
  );

  const data = await res.json();

  if (!data.events || data.events.length === 0) {
    return "No events scheduled.";
  }

  return data.events
    .map((e) => {
      const time = new Date(e.start).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Phoenix",
      });

      return `${time} — ${e.title}`;
    })
    .join("\n");
}

export async function POST(req) {
  try {
    const { message } = await req.json();

    const date = detectDate(message);
    const calendarData = await getCalendarForDate(date);

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are Jess, Brad's assistant.

Always use the provided schedule to answer questions about dates.

Schedule:
${calendarData}
          `,
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

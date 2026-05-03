import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function getTodayCalendar() {
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_BASE_URL}/api/calendar/today`
    );

    const data = await res.json();

    if (!data.events || data.events.length === 0) {
      return "You have no events scheduled today.";
    }

    const formatted = data.events
      .map((e) => {
        if (!e.start) return e.title;

        const date = new Date(e.start);

        const time = date.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: "America/Phoenix", // 🔥 FIXED TIMEZONE
        });

        return `${time} — ${e.title}`;
      })
      .join("\n");

    return `Today's schedule:\n${formatted}`;
  } catch (err) {
    return "Could not retrieve calendar.";
  }
}

export async function POST(req) {
  try {
    const { message } = await req.json();

    let calendarContext = "";

    if (
      message.toLowerCase().includes("schedule") ||
      message.toLowerCase().includes("calendar") ||
      message.toLowerCase().includes("today")
    ) {
      calendarContext = await getTodayCalendar();
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are Jess, Brad's AI assistant.

When given a schedule, list events clearly with correct times.

Calendar:
${calendarContext}
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

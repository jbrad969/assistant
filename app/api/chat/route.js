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
        const time = e.start
          ? new Date(e.start).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })
          : "All day";

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

If calendar data is provided, use it to answer clearly.

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

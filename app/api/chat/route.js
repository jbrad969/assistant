import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

let lastCalendarData = "";

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
          timeZone: "America/Phoenix",
        });

        return `${time} — ${e.title}`;
      })
      .join("\n");

    lastCalendarData = formatted;

    return `Today's schedule:\n${formatted}`;
  } catch (err) {
    return "Could not retrieve calendar.";
  }
}

function shouldUseCalendar(message) {
  const msg = message.toLowerCase();

  return (
    msg.includes("schedule") ||
    msg.includes("calendar") ||
    msg.includes("today") ||
    msg.includes("morning") ||
    msg.includes("afternoon") ||
    msg.includes("evening") ||
    msg.includes("tonight") ||
    msg.includes("later") ||
    msg.includes("earlier")
  );
}

export async function POST(req) {
  try {
    const { message } = await req.json();

    let calendarContext = "";

    if (shouldUseCalendar(message)) {
      calendarContext = await getTodayCalendar();
    } else if (lastCalendarData) {
      calendarContext = `Today's schedule:\n${lastCalendarData}`;
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are Jess, Brad's AI assistant.

You have access to today's calendar.

If asked follow-up questions like "this morning", "later", or "what about earlier",
you MUST use the calendar data provided.

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

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

let conversationMemory = [];

export async function POST(req) {
  const { message } = await req.json();

  conversationMemory.push({
    role: "user",
    content: message,
  });

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
You are Jess, Brad's personal AI assistant.

You help Brad manage his day, business, schedule, leads, reminders, and decisions.

Be:
- direct
- practical
- concise
- proactive

Brad values speed, clarity, and useful next steps.

Remember the conversation context when replying.
        `,
      },
      ...conversationMemory,
    ],
  });

  const reply = completion.choices[0].message.content;

  conversationMemory.push({
    role: "assistant",
    content: reply,
  });

  conversationMemory = conversationMemory.slice(-20);

  return Response.json({
    reply,
  });
}

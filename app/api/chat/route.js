import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(req) {
  const { message } = await req.json();

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
You are Jess, Brad's personal AI assistant.

Your job:
- Help Brad manage his day
- Be direct, concise, and practical
- Act like a high-level executive assistant

Brad runs a business and values:
- speed
- clarity
- actionable answers

When possible:
- suggest next steps
- organize information
- think ahead for him

Never be overly wordy.
Always be helpful.
        `,
      },
      { role: "user", content: message },
    ],
  });

  return Response.json({
    reply: completion.choices[0].message.content,
  });
}

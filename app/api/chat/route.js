import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(req) {
  const { message } = await req.json();

  // 🔹 Get previous messages (memory)
  const historyRes = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/messages?select=role,content&order=created_at.asc`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );

  const history = await historyRes.json();

  // 🔹 Build conversation
  const messages = [
    {
      role: "system",
      content:
        "You are Jess, Brad's AI assistant. You remember everything the user tells you and use past messages when answering.",
    },
    ...history,
    { role: "user", content: message },
  ];

  // 🔹 Call OpenAI
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
  });

  const reply = completion.choices[0].message.content;

  // 🔹 Save user message
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      role: "user",
      content: message,
    }),
  });

  // 🔹 Save assistant reply
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      role: "assistant",
      content: reply,
    }),
  });

  return Response.json({ reply });
}

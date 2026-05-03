import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function POST(req) {
  const { message } = await req.json();

  await supabase.from("messages").insert({
    role: "user",
    content: message,
  });

  const { data: previousMessages } = await supabase
    .from("messages")
    .select("role, content")
    .order("created_at", { ascending: false })
    .limit(20);

  const memory = (previousMessages || []).reverse();

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are Jess, Brad's personal AI assistant. Be direct, practical, concise, and proactive. Help Brad with his day, business, schedule, leads, reminders, and decisions.",
      },
      ...memory,
    ],
  });

  const reply = completion.choices[0].message.content;

  await supabase.from("messages").insert({
    role: "assistant",
    content: reply,
  });

  return Response.json({ reply });
}

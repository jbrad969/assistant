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
  try {
    const { message } = await req.json();

    // 1. Get past memory
    const { data: memories } = await supabase
      .from("memory")
      .select("content")
      .order("created_at", { ascending: true });

    const memoryText = memories?.map((m) => m.content).join("\n") || "";

    // 2. Ask OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are Jess, Brad's AI assistant.

You have access to stored memory about Brad.

IMPORTANT RULES:
- Treat stored memory as FACT.
- Do NOT ask for confirmation if the answer exists in memory.
- Answer confidently using memory when possible.
- Only say you don't know if memory truly does not contain the answer.

Memory:
${memoryText}
          `,
        },
        {
          role: "user",
          content: message,
        },
      ],
    });

    const reply = completion.choices[0].message.content;

    // 3. Save new memory (simple version)
    await supabase.from("memory").insert([
      { content: `User: ${message}` },
      { content: `Jess: ${reply}` },
    ]);

    return Response.json({ reply });
  } catch (err) {
    console.error(err);
    return Response.json(
      { reply: "Jess had an issue." },
      { status: 500 }
    );
  }
}

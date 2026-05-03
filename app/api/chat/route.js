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

    const factCheck = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
Extract a clear personal fact from the user's message.

Examples:
"my dogs name is frank" -> "Brad's dog's name is Frank"
"my dog's name is frank" -> "Brad's dog's name is Frank"
"my favorite color is blue" -> "Brad's favorite color is Blue"

If no fact exists, return EXACTLY: NONE
          `,
        },
        { role: "user", content: message },
      ],
    });

    const fact = factCheck.choices[0].message.content.trim();

    if (fact !== "NONE") {
      await supabase.from("memory").insert([{ content: fact }]);
    }

    const { data: memories } = await supabase
      .from("memory")
      .select("content")
      .order("created_at", { ascending: true });

    const memoryText =
      memories?.map((m) => `- ${m.content}`).join("\n") || "No stored facts yet.";

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are Jess, Brad's AI assistant.

You have stored facts about Brad.

Stored facts:
${memoryText}

Rules:
- Use the stored facts above as truth.
- If Brad asks about his dog, use any stored fact about "Brad's dog's name".
- "dog", "dogs", and "dog's" mean the same thing.
- Answer directly when a stored fact answers the question.
- Do not say you don't know when the answer is in stored facts.
- Never invent facts not listed above.
          `,
        },
        { role: "user", content: message },
      ],
    });

    const reply = completion.choices[0].message.content;

    return Response.json({ reply });
  } catch (err) {
    return Response.json(
      { reply: "Jess had an issue: " + err.message },
      { status: 500 }
    );
  }
}

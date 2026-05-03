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
"my dogs name is frank" -> "Dog name: Frank"
"my dog's name is frank" -> "Dog name: Frank"
"my favorite color is blue" -> "Favorite color: Blue"

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
      .select("content");

    const memoryText =
      memories?.map((m) => `- ${m.content}`).join("\n") || "";

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are Jess, Brad's AI assistant.

Use stored facts as truth.
Never guess.
If a fact exists in memory, answer directly.

Facts:
${memoryText}
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

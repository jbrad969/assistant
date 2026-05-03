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

    // 1. Get memory (facts only)
    const { data: memories } = await supabase
      .from("memory")
      .select("content");

    const memoryText =
      memories?.map((m) => `- ${m.content}`).join("\n") || "";

    // 2. Ask AI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are Jess, Brad's AI assistant.

You have stored facts about Brad.

RULES:
- Facts are ALWAYS correct.
- NEVER guess.
- If the answer is not in memory, say you don't know.
- Do NOT invent answers.

Facts:
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

    // 3. Extract fact from user message
    const factCheck = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
Extract a clear fact from the user's message if it contains one.

Examples:
"my dog's name is frank" → "Dog name: Frank"
"my favorite color is blue" → "Favorite color: Blue"

If no fact, return "NONE"
          `,
        },
        {
          role: "user",
          content: message,
        },
      ],
    });

    const fact = factCheck.choices[0].message.content;

    // 4. Save ONLY real facts
    if (fact && fact !== "NONE") {
      await supabase.from("memory").insert([
        { content: fact },
      ]);
    }

    return Response.json({ reply });
  } catch (err) {
    console.error(err);
    return Response.json(
      { reply: "Jess had an issue." },
      { status: 500 }
    );
  }
}

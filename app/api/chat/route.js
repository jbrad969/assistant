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

    if (!message) {
      return Response.json({ reply: "Please type a message." });
    }

    // 1. Pull current memory from Supabase
    const { data: memories, error: readError } = await supabase
      .from("memory")
      .select("content")
      .order("created_at", { ascending: true });

    if (readError) {
      return Response.json({
        reply: "Supabase read error: " + readError.message,
      });
    }

    const memoryText =
      memories && memories.length > 0
        ? memories.map((m) => `- ${m.content}`).join("\n")
        : "No saved facts yet.";

    // 2. Extract a clean fact from Brad's message
    const factCheck = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You extract personal facts about Brad from messy user messages.

Return ONE clean fact if the message contains a fact.
Return EXACTLY NONE if there is no fact.

Examples:
"my dogs name is frank" -> "Brad's dog's name is Frank"
"my dog's name is frank" -> "Brad's dog's name is Frank"
"my dog name is frank" -> "Brad's dog's name is Frank"
"dog is frank" -> "Brad's dog's name is Frank"
"i have a dog named frank" -> "Brad's dog's name is Frank"
"my favorite color is blue" -> "Brad's favorite color is Blue"
"my fav color is blue" -> "Brad's favorite color is Blue"
"i live in phoenix" -> "Brad lives in Phoenix"

Rules:
- Be forgiving with grammar and spelling.
- Capitalize names and values.
- Do not answer the user.
- Only return the fact text or NONE.
          `,
        },
        { role: "user", content: message },
      ],
    });

    const fact = factCheck.choices[0].message.content.trim();

    // 3. Save the fact BEFORE answering
    if (fact && fact.toUpperCase() !== "NONE") {
      const { error: insertError } = await supabase
        .from("memory")
        .insert([{ content: fact }]);

      if (insertError) {
        return Response.json({
          reply: "Supabase insert error: " + insertError.message,
        });
      }
    }

    // 4. Pull memory again so the new fact is included immediately
    const { data: updatedMemories, error: secondReadError } = await supabase
      .from("memory")
      .select("content")
      .order("created_at", { ascending: true });

    if (secondReadError) {
      return Response.json({
        reply: "Supabase second read error: " + secondReadError.message,
      });
    }

    const updatedMemoryText =
      updatedMemories && updatedMemories.length > 0
        ? updatedMemories.map((m) => `- ${m.content}`).join("\n")
        : "No saved facts yet.";

    // 5. Ask Jess with memory
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are Jess, Brad's AI assistant.

You have stored facts about Brad.

Stored facts:
${updatedMemoryText}

Rules:
- Treat stored facts as true.
- Use stored facts to answer directly.
- "dog", "dogs", and "dog's" mean the same thing.
- If Brad asks about his dog, look for Brad's dog's name in stored facts.
- If Brad asks about his favorite color, look for Brad's favorite color in stored facts.
- Do not say you don't know if the answer is in stored facts.
- Never invent facts that are not in stored facts.
- Be concise and helpful.
          `,
        },
        { role: "user", content: message },
      ],
    });

    const reply = completion.choices[0].message.content;

    return Response.json({ reply });
  } catch (err) {
    return Response.json(
      { reply: "Server error: " + err.message },
      { status: 500 }
    );
  }
}

"use client";

import { useState } from "react";

export default function Page() {
  const [messages, setMessages] = useState([
    { role: "assistant", content: "Hey Brad — I’m Jess. What do you need?" },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function sendMessage() {
    if (!input.trim() || loading) return;

    const userText = input;
    setMessages((prev) => [...prev, { role: "user", content: userText }]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userText }),
      });

      const data = await res.json();

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.reply || data.error || "Jess had an issue.",
        },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Browser error: " + error.message },
      ]);
    }

    setLoading(false);
  }

  return (
    <main style={{ maxWidth: 800, margin: "0 auto", padding: 24 }}>
      <h1>Jess AI 🚀</h1>

      {messages.map((msg, index) => (
        <div
          key={index}
          style={{
            marginBottom: 12,
            padding: 14,
            borderRadius: 10,
            background: msg.role === "user" ? "#dff0ff" : "#f2f2f2",
          }}
        >
          <strong>{msg.role === "user" ? "Brad" : "Jess"}:</strong>{" "}
          {msg.content}
        </div>
      ))}

      {loading && <p>Jess is thinking...</p>}

      <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendMessage();
          }}
          placeholder="Ask Jess something..."
          style={{ flex: 1, padding: 12, fontSize: 16 }}
        />

        <button onClick={sendMessage} disabled={loading}>
          Send
        </button>
      </div>
    </main>
  );
}

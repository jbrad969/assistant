"use client";
import { useState } from "react";

export default function Page() {
  const [message, setMessage] = useState("");
  const [response, setResponse] = useState("");

  async function sendMessage() {
    const res = await fetch("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
    });

    const data = await res.json();
    setResponse(data.reply);
  }

  return (
    <div style={{ padding: 20 }}>
      <h1>Jess AI 🚀</h1>

      <input
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Ask Jess something..."
      />

      <button onClick={sendMessage}>Send</button>

      <p>{response}</p>
    </div>
  );
}

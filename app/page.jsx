"use client";

import { useEffect, useRef, useState } from "react";

export default function Page() {
  const [messages, setMessages] = useState([
    { role: "assistant", content: "Hey Brad — I’m Jess. What do you need?" },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const [showMemory, setShowMemory] = useState(false);
  const [memories, setMemories] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [editingText, setEditingText] = useState("");

  const bottomRef = useRef(null);

  async function loadMemory() {
    const res = await fetch("/api/memory");
    const data = await res.json();
    setMemories(data.memories || []);
  }

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
        { role: "assistant", content: data.reply || "Jess had an issue." },
      ]);

      loadMemory();
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Browser error: " + error.message },
      ]);
    }

    setLoading(false);
  }

  async function deleteMemory(id) {
    await fetch("/api/memory/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });

    loadMemory();
  }

  async function updateMemory(id) {
    await fetch("/api/memory/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, content: editingText }),
    });

    setEditingId(null);
    setEditingText("");
    loadMemory();
  }

  useEffect(() => {
    loadMemory();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f7f7f8",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        color: "#111",
      }}
    >
      <div
        style={{
          maxWidth: 900,
          margin: "0 auto",
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* HEADER */}
        <header
          style={{
            position: "sticky",
            top: 0,
            zIndex: 10,
            background: "rgba(247,247,248,0.95)",
            backdropFilter: "blur(10px)",
            borderBottom: "1px solid #e5e5e5",
            padding: "14px 16px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: 24 }}>Jess AI 🚀</h1>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: "#666" }}>
              Brad’s assistant
            </p>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() =>
                setMessages([
                  {
                    role: "assistant",
                    content: "Hey Brad — I’m Jess. What do you need?",
                  },
                ])
              }
              style={btnStyle("#fff", "#111")}
            >
              Clear
            </button>

            <button
              onClick={() => setShowMemory(!showMemory)}
              style={btnStyle(showMemory ? "#111" : "#fff", showMemory ? "#fff" : "#111")}
            >
              {showMemory ? "Hide Memory" : "Memory"}
            </button>
          </div>
        </header>

        {/* MEMORY PANEL */}
        {showMemory && (
          <section
            style={{
              margin: 16,
              padding: 16,
              borderRadius: 16,
              background: "#fff",
              border: "1px solid #ddd",
            }}
          >
            <h2>Jess Memory 🧠</h2>

            {memories.length === 0 && <p>No memories yet.</p>}

            {memories.map((memory) => (
              <div key={memory.id} style={{ marginBottom: 10 }}>
                {editingId === memory.id ? (
                  <>
                    <input
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      style={{ width: "100%", padding: 10 }}
                    />
                    <button onClick={() => updateMemory(memory.id)}>Save</button>
                  </>
                ) : (
                  <>
                    <p>{memory.content}</p>
                    <button
                      onClick={() => {
                        setEditingId(memory.id);
                        setEditingText(memory.content);
                      }}
                    >
                      Edit
                    </button>
                    <button onClick={() => deleteMemory(memory.id)}>
                      Delete
                    </button>
                  </>
                )}
              </div>
            ))}
          </section>
        )}

        {/* CHAT */}
        <section style={{ flex: 1, padding: 16 }}>
          {messages.map((msg, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <b>{msg.role === "user" ? "Brad" : "Jess"}:</b> {msg.content}
            </div>
          ))}

          {loading && <p>Jess is thinking…</p>}
          <div ref={bottomRef} />
        </section>

        {/* INPUT */}
        <div style={{ padding: 16, borderTop: "1px solid #ddd" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask Jess..."
              style={{ flex: 1, padding: 12 }}
            />
            <button onClick={sendMessage}>Send</button>
          </div>
        </div>
      </div>
    </main>
  );
}

function btnStyle(bg, color) {
  return {
    background: bg,
    color: color,
    border: "1px solid #ccc",
    padding: "8px 12px",
    borderRadius: 999,
    cursor: "pointer",
    fontWeight: 600,
  };
}

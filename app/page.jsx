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
            gap: 12,
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: 24, lineHeight: 1 }}>
              Jess AI 🚀
            </h1>
            <p style={{ margin: "6px 0 0", fontSize: 13, color: "#666" }}>
              Brad’s personal assistant
            </p>
          </div>

          <button
            onClick={() => setShowMemory(!showMemory)}
            style={{
              border: "1px solid #d0d0d0",
              background: showMemory ? "#111" : "#fff",
              color: showMemory ? "#fff" : "#111",
              borderRadius: 999,
              padding: "10px 14px",
              fontWeight: 600,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {showMemory ? "Hide Memory" : "Memory"}
          </button>
        </header>

        {showMemory && (
          <section
            style={{
              margin: 16,
              padding: 16,
              borderRadius: 18,
              background: "#fff",
              border: "1px solid #e4e4e7",
              boxShadow: "0 8px 24px rgba(0,0,0,0.04)",
            }}
          >
            <h2 style={{ marginTop: 0, fontSize: 20 }}>Jess Memory 🧠</h2>

            {memories.length === 0 && (
              <p style={{ color: "#666" }}>No memories saved yet.</p>
            )}

            {memories.map((memory) => (
              <div
                key={memory.id}
                style={{
                  padding: 12,
                  marginBottom: 10,
                  borderRadius: 14,
                  background: "#f4f4f5",
                  border: "1px solid #e7e7e7",
                }}
              >
                {editingId === memory.id ? (
                  <>
                    <input
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        padding: 12,
                        borderRadius: 10,
                        border: "1px solid #ccc",
                        fontSize: 15,
                        marginBottom: 10,
                      }}
                    />

                    <button
                      onClick={() => updateMemory(memory.id)}
                      style={buttonStyle("#111", "#fff")}
                    >
                      Save
                    </button>

                    <button
                      onClick={() => setEditingId(null)}
                      style={{ ...buttonStyle("#fff", "#111"), marginLeft: 8 }}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <p style={{ margin: "0 0 10px", lineHeight: 1.4 }}>
                      {memory.content}
                    </p>

                    <button
                      onClick={() => {
                        setEditingId(memory.id);
                        setEditingText(memory.content);
                      }}
                      style={buttonStyle("#fff", "#111")}
                    >
                      Edit
                    </button>

                    <button
                      onClick={() => deleteMemory(memory.id)}
                      style={{
                        ...buttonStyle("#fff", "#b00020"),
                        marginLeft: 8,
                        borderColor: "#f0b5bf",
                      }}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            ))}
          </section>
        )}

        <section
          style={{
            flex: 1,
            padding: "16px",
            paddingBottom: 110,
          }}
        >
          {messages.map((msg, index) => (
            <div
              key={index}
              style={{
                display: "flex",
                justifyContent:
                  msg.role === "user" ? "flex-end" : "flex-start",
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  maxWidth: "82%",
                  padding: "13px 15px",
                  borderRadius:
                    msg.role === "user"
                      ? "18px 18px 4px 18px"
                      : "18px 18px 18px 4px",
                  background: msg.role === "user" ? "#007aff" : "#fff",
                  color: msg.role === "user" ? "#fff" : "#111",
                  boxShadow: "0 3px 12px rgba(0,0,0,0.06)",
                  lineHeight: 1.45,
                  whiteSpace: "pre-wrap",
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    opacity: 0.75,
                    marginBottom: 4,
                    fontWeight: 700,
                  }}
                >
                  {msg.role === "user" ? "Brad" : "Jess"}
                </div>
                {msg.content}
              </div>
            </div>
          ))}

          {loading && (
            <div style={{ display: "flex", justifyContent: "flex-start" }}>
              <div
                style={{
                  padding: "13px 15px",
                  borderRadius: "18px 18px 18px 4px",
                  background: "#fff",
                  boxShadow: "0 3px 12px rgba(0,0,0,0.06)",
                  color: "#666",
                }}
              >
                Jess is thinking…
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </section>

        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(247,247,248,0.96)",
            backdropFilter: "blur(10px)",
            borderTop: "1px solid #e5e5e5",
            padding: "12px 14px",
          }}
        >
          <div
            style={{
              maxWidth: 900,
              margin: "0 auto",
              display: "flex",
              gap: 8,
              alignItems: "center",
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") sendMessage();
              }}
              placeholder="Ask Jess something..."
              style={{
                flex: 1,
                padding: "14px 16px",
                borderRadius: 999,
                border: "1px solid #d0d0d0",
                fontSize: 16,
                outline: "none",
                background: "#fff",
              }}
            />

            <button
              onClick={sendMessage}
              disabled={loading}
              style={{
                border: "none",
                borderRadius: 999,
                padding: "14px 18px",
                background: loading ? "#999" : "#111",
                color: "#fff",
                fontSize: 16,
                fontWeight: 700,
                cursor: loading ? "not-allowed" : "pointer",
              }}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

function buttonStyle(background, color) {
  return {
    border: "1px solid #d0d0d0",
    background,
    color,
    borderRadius: 999,
    padding: "8px 12px",
    fontWeight: 600,
    cursor: "pointer",
  };
}

"use client";

import { useEffect, useState } from "react";

export default function MemoryPage() {
  const [memories, setMemories] = useState([]);

  useEffect(() => {
    async function loadMemory() {
      const res = await fetch("/api/memory");
      const data = await res.json();
      setMemories(data.memories || []);
    }

    loadMemory();
  }, []);

  return (
    <main style={{ maxWidth: 800, margin: "0 auto", padding: 24 }}>
      <h1>Jess Memory 🧠</h1>

      {memories.length === 0 && <p>No memories saved yet.</p>}

      {memories.map((memory) => (
        <div
          key={memory.id}
          style={{
            padding: 14,
            marginBottom: 12,
            borderRadius: 10,
            background: "#f2f2f2",
          }}
        >
          {memory.content}
        </div>
      ))}
    </main>
  );
}

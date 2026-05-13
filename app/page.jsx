"use client";

import { useEffect, useRef, useState } from "react";

const styles = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500;600&display=swap');

  * { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --accent: #6366f1;
    --accent-hover: #4f46e5;
    --accent-light: #818cf8;
    --accent-dim: rgba(99, 102, 241, 0.18);
    --accent-glow: rgba(99, 102, 241, 0.35);
    --bg-base: #0a0a0f;
    --bg-elev: #14141f;
    --bg-elev-2: #1a1a2e;
    --border-soft: #1f1f2e;
    --border-mid: #2a2a3a;
    --text-primary: #f0f0f5;
    --text-secondary: #a8a8c0;
    --text-tertiary: #6b6b85;
    --text-quaternary: #4a4a60;
    --danger: #ef4444;
  }

  body {
    background: #1a1a2e;
    color: var(--text-primary);
    font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
    font-size: 15px;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* Subtle indigo glow at the top of the viewport */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    pointer-events: none;
    background:
      radial-gradient(ellipse 900px 420px at 50% -120px, rgba(99, 102, 241, 0.12), transparent 70%),
      radial-gradient(ellipse 600px 300px at 90% 0%, rgba(99, 102, 241, 0.06), transparent 70%);
    z-index: 0;
  }

  .app {
    max-width: 820px;
    margin: 0 auto;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    position: relative;
    z-index: 1;
  }

  /* HEADER */
  .header {
    position: sticky;
    top: 0;
    z-index: 10;
    background: #12122a;
    border-bottom: 1px solid #3a3a5a;
    padding: 14px 22px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .header-brand { display: flex; flex-direction: column; gap: 2px; }

  .header-title {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.3px;
    background: linear-gradient(135deg, #ffffff 0%, #c8c8e8 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .header-title-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 10px var(--accent-glow);
    flex-shrink: 0;
  }

  .header-sub {
    font-size: 10px;
    color: var(--text-quaternary);
    font-family: 'DM Mono', monospace;
    letter-spacing: 1px;
    text-transform: uppercase;
    padding-left: 15px;
  }

  .header-actions { display: flex; gap: 8px; }

  .btn {
    background: transparent;
    color: #c8c8e8;
    border: 1px solid #4a4a6a;
    padding: 7px 14px;
    border-radius: 9px;
    cursor: pointer;
    font-size: 13px;
    font-family: 'DM Sans', sans-serif;
    font-weight: 500;
    transition: all 0.18s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .btn:hover {
    background: #2d2d4e;
    color: #ffffff;
    border-color: var(--accent);
    transform: translateY(-1px);
  }

  .btn.active {
    background: #6366f1;
    color: #ffffff;
    border-color: #6366f1;
    box-shadow: 0 4px 14px rgba(99, 102, 241, 0.4);
  }

  /* MEMORY PANEL */
  .memory-panel {
    margin: 14px 18px 0;
    padding: 22px;
    border-radius: 16px;
    background: #22223a;
    border: 1px solid #3a3a5a;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
  }

  .memory-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--accent-light);
    text-transform: uppercase;
    letter-spacing: 1.5px;
    font-family: 'DM Mono', monospace;
    margin-bottom: 14px;
  }

  .memory-item {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 11px 0;
    border-bottom: 1px solid var(--border-soft);
  }

  .memory-item:last-child { border-bottom: none; }

  .memory-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    margin-top: 7px;
    flex-shrink: 0;
    box-shadow: 0 0 6px var(--accent-glow);
  }

  .memory-content {
    flex: 1;
    font-size: 14px;
    color: var(--text-primary);
    line-height: 1.55;
  }

  .memory-actions { display: flex; gap: 6px; flex-shrink: 0; }

  .memory-btn {
    background: transparent;
    border: 1px solid var(--border-mid);
    color: var(--text-tertiary);
    padding: 4px 11px;
    border-radius: 7px;
    font-size: 12px;
    cursor: pointer;
    font-family: 'DM Sans', sans-serif;
    transition: all 0.15s ease;
  }

  .memory-btn:hover {
    background: rgba(99, 102, 241, 0.08);
    color: var(--text-primary);
    border-color: var(--accent-dim);
  }

  .memory-btn.delete:hover {
    border-color: var(--danger);
    color: var(--danger);
    background: rgba(239, 68, 68, 0.08);
  }

  .memory-input {
    width: 100%;
    background: #2d2d4e;
    border: 1px solid #4a4a6a;
    color: #ffffff;
    padding: 9px 13px;
    border-radius: 9px;
    font-size: 14px;
    font-family: 'DM Sans', sans-serif;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .memory-input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
  }

  .memory-empty {
    font-size: 13px;
    color: var(--text-quaternary);
    font-style: italic;
  }

  /* CHAT */
  .chat {
    flex: 1;
    padding: 24px 18px 8px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  @keyframes messageIn {
    from { opacity: 0; transform: translateY(10px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .message-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    animation: messageIn 0.32s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .message-row.user { align-items: flex-end; }
  .message-row.assistant { align-items: flex-start; }

  .message-label {
    font-size: 11px;
    font-family: 'DM Mono', monospace;
    letter-spacing: 1.2px;
    font-weight: 600;
    padding: 0 8px;
  }
  .message-label.label-jess { color: #818cf8; }
  .message-label.label-brad { color: #94a3b8; }

  .bubble {
    max-width: 78%;
    padding: 14px 18px;
    border-radius: 18px;
    font-size: 15px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-wrap: break-word;
  }

  .bubble.user {
    background: #ffffff;
    color: #0d0d1a;
    border-radius: 20px;
    border-bottom-right-radius: 6px;
    font-weight: 400;
    box-shadow:
      0 4px 18px rgba(255, 255, 255, 0.08),
      0 1px 3px rgba(0, 0, 0, 0.4);
  }

  .bubble.assistant {
    background: #2d2d4e;
    color: #ffffff;
    border: 1px solid #3a3a5a;
    border-left: 3px solid #6366f1;
    border-radius: 18px;
    border-bottom-left-radius: 6px;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3);
  }

  /* Calendar / reminder event rows inside an assistant bubble */
  .event-day {
    font-family: 'DM Mono', monospace;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    color: var(--accent-light);
    font-weight: 600;
    margin-top: 10px;
    margin-bottom: 2px;
  }
  .event-day:first-child { margin-top: 0; }

  .event-intro {
    color: #ffffff;
    margin-bottom: 4px;
  }

  .event-row {
    display: flex;
    gap: 14px;
    padding: 10px 0;
    border-bottom: 1px solid rgba(129, 140, 248, 0.25);
    align-items: baseline;
  }
  .event-row:last-child { border-bottom: none; padding-bottom: 2px; }

  .event-time {
    font-weight: 600;
    color: #818cf8;
    font-family: 'DM Mono', monospace;
    font-size: 13px;
    letter-spacing: 0.3px;
    white-space: nowrap;
    flex-shrink: 0;
    min-width: 78px;
  }

  .event-text {
    color: #ffffff;
    font-size: 15px;
    line-height: 1.5;
    flex: 1;
    white-space: normal;
  }

  /* Drive / Docs URLs rendered as inline buttons */
  .drive-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: rgba(99, 102, 241, 0.18);
    color: #818cf8;
    text-decoration: none;
    padding: 2px 10px;
    border-radius: 999px;
    border: 1px solid rgba(99, 102, 241, 0.4);
    font-size: 13px;
    font-weight: 500;
    font-family: 'DM Sans', sans-serif;
    transition: all 0.15s ease;
    white-space: nowrap;
    margin: 0 2px;
  }

  .drive-link:hover {
    background: #6366f1;
    color: #ffffff;
    border-color: #6366f1;
  }

  /* Thinking indicator */
  .thinking {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 18px;
    background: #2d2d4e;
    border: 1px solid #3a3a5a;
    border-left: 3px solid #6366f1;
    border-radius: 18px;
    border-bottom-left-radius: 6px;
    width: fit-content;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3);
  }

  .thinking-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #818cf8;
    animation: thinkingPulse 1.4s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }
  .thinking-dot:nth-child(2) { animation-delay: 0.18s; }
  .thinking-dot:nth-child(3) { animation-delay: 0.36s; }

  @keyframes thinkingPulse {
    0%, 100% { opacity: 0.25; transform: scale(0.85); }
    50%      { opacity: 1;    transform: scale(1.05); }
  }

  /* INPUT BAR */
  .input-bar {
    padding: 16px 18px 22px;
    background: linear-gradient(180deg, transparent 0%, rgba(26, 26, 46, 0.9) 35%, #1a1a2e 100%);
    position: sticky;
    bottom: 0;
  }

  .input-wrap {
    display: flex;
    gap: 10px;
    align-items: center;
    background: #2d2d4e;
    border: 1px solid #6366f1;
    border-radius: 999px;
    padding: 6px 6px 6px 22px;
    transition: border-color 0.18s, box-shadow 0.18s;
  }

  .input-wrap:focus-within {
    box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.25);
  }

  .input-field {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: #ffffff;
    font-size: 15px;
    font-family: 'DM Sans', sans-serif;
    padding: 8px 0;
  }

  .input-field::placeholder { color: #9999bb; }

  .send-btn {
    background: #6366f1;
    color: #ffffff;
    border: none;
    border-radius: 999px;
    padding: 10px 22px;
    font-size: 14px;
    font-weight: 600;
    font-family: 'DM Sans', sans-serif;
    cursor: pointer;
    transition: all 0.18s cubic-bezier(0.4, 0, 0.2, 1);
    flex-shrink: 0;
    box-shadow: 0 4px 16px rgba(99, 102, 241, 0.5);
  }

  .send-btn:hover {
    background: #4f46e5;
    box-shadow: 0 6px 22px rgba(99, 102, 241, 0.65);
    transform: translateY(-1px);
  }

  .send-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
    box-shadow: none;
    transform: none;
  }

  .mic-btn {
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: #3a3a5a;
    border: 1px solid #4a4a6a;
    color: #c8c8e8;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.18s;
    flex-shrink: 0;
    padding: 0;
  }

  .mic-btn:hover {
    background: #4a4a6a;
    color: #ffffff;
    border-color: #6366f1;
  }

  .mic-btn svg { width: 18px; height: 18px; }

  .mic-btn.listening {
    background: var(--danger);
    color: #fff;
    border-color: var(--danger);
    box-shadow: 0 0 24px rgba(239, 68, 68, 0.6);
    animation: micPulse 1.4s ease-in-out infinite;
  }

  @keyframes micPulse {
    0%, 100% {
      box-shadow: 0 0 22px rgba(239, 68, 68, 0.55), 0 0 0 0 rgba(239, 68, 68, 0.7);
      transform: scale(1);
    }
    50% {
      box-shadow: 0 0 30px rgba(239, 68, 68, 0.7), 0 0 0 12px rgba(239, 68, 68, 0);
      transform: scale(1.06);
    }
  }

  .voice-bar {
    display: flex;
    justify-content: center;
    margin-bottom: 12px;
  }

  .stop-btn {
    background: var(--danger);
    color: #fff;
    border: none;
    border-radius: 999px;
    padding: 10px 22px 10px 18px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    transition: background 0.15s;
    font-family: 'DM Sans', sans-serif;
    animation: stopPulse 1.4s ease-in-out infinite;
  }

  .stop-btn:hover { background: #dc2626; }

  .stop-btn::before {
    content: "";
    width: 11px;
    height: 11px;
    background: #fff;
    border-radius: 2px;
    display: inline-block;
  }

  @keyframes stopPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5); }
    50%      { box-shadow: 0 0 0 10px rgba(239, 68, 68, 0); }
  }

  .reply-choice { display: flex; gap: 10px; }

  .reply-choice-btn {
    background: #2d2d4e;
    color: #ffffff;
    border: 1px solid #4a4a6a;
    border-radius: 999px;
    padding: 9px 18px;
    font-size: 13px;
    font-family: 'DM Sans', sans-serif;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.18s;
  }

  .reply-choice-btn:hover {
    background: #3a3a6a;
    border-color: #6366f1;
    color: #ffffff;
  }
`;

export default function Page() {
  const [messages, setMessages] = useState([
    { role: "assistant", content: "Hey Brad — I'm Jess. What do you need?" },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [memories, setMemories] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [editingText, setEditingText] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [showReplyChoice, setShowReplyChoice] = useState(false);
  // Server may return a `pendingAction` (e.g. confirm a calendar move). We echo it
  // back on the next request; the server consumes it on approve/deny and returns
  // null in response, which clears the state below.
  const [pendingAction, setPendingAction] = useState(null);
  const bottomRef = useRef(null);
  const recognitionRef = useRef(null);
  const voiceRef = useRef(null);
  const inputRef = useRef(null);
  const isListeningRef = useRef(false);
  const micStreamRef = useRef(null);
  const shownRemindersRef = useRef(new Set());

  async function loadMemory() {
    const res = await fetch("/api/memory");
    const data = await res.json();
    setMemories(data.memories || []);
  }

  function stopListening() {
    if (!isListeningRef.current && !isListening) return;
    isListeningRef.current = false;
    try { recognitionRef.current?.stop(); } catch (e) {}
    setIsListening(false);
  }

  function formatMessage(text) {
    if (!text) return text;
    // If the assistant already produced a bulleted list (e.g. the reminders / calendar
    // handlers return "• 7:45 AM — ...") leave it alone — we don't want to add a second bullet.
    if (/^[•\-*]\s/m.test(text)) return text;
    const timeRegex = /\b(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm))\b/g;
    const matches = [...text.matchAll(timeRegex)];
    if (matches.length < 2) return text;

    const firstIdx = matches[0].index;
    const intro = text.slice(0, firstIdx).trim();

    const bullets = matches.map((m, i) => {
      const start = m.index;
      const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
      const segment = text.slice(start, end).trim().replace(/[,;]\s*$/, "");
      return `• ${segment}`;
    });

    return intro ? `${intro}\n\n${bullets.join("\n")}` : bullets.join("\n");
  }

  // Replace Google Drive / Docs URLs in a string with clickable "Open in Drive →"
  // buttons. Returns either the plain string (no links) or an array of mixed
  // strings + JSX nodes that React renders as inline content.
  function linkifyDriveUrls(text, keyBase) {
    if (!text || typeof text !== "string") return text;
    const driveUrlRe = /https:\/\/(?:drive|docs)\.google\.com\/[^\s)]+/g;
    if (!driveUrlRe.test(text)) return text;

    driveUrlRe.lastIndex = 0;
    const parts = [];
    let lastIdx = 0;
    let match;
    let i = 0;
    while ((match = driveUrlRe.exec(text)) !== null) {
      if (match.index > lastIdx) parts.push(text.slice(lastIdx, match.index));
      parts.push(
        <a
          key={`${keyBase}-link-${i++}`}
          href={match[0]}
          target="_blank"
          rel="noopener noreferrer"
          className="drive-link"
        >
          Open in Drive →
        </a>
      );
      lastIdx = match.index + match[0].length;
    }
    if (lastIdx < text.length) parts.push(text.slice(lastIdx));
    return parts;
  }

  // Render assistant text. If the formatted text contains "• <time> — <rest>"
  // bullet lines (calendar/reminder lists), promote each to a styled event row;
  // otherwise return the plain string and let the bubble's pre-wrap render it.
  // Drive/Docs URLs are turned into "Open in Drive →" buttons in either path.
  function renderAssistantContent(text) {
    const formatted = formatMessage(text);
    if (!formatted) return formatted;

    const lines = formatted.split("\n");
    const eventRe = /^•\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm))\s*[—\-]\s*(.+)$/;
    const hasEvents = lines.some((line) => eventRe.test(line));
    if (!hasEvents) return linkifyDriveUrls(formatted, "msg");

    const elements = [];
    lines.forEach((line, idx) => {
      const m = line.match(eventRe);
      if (m) {
        elements.push(
          <div key={`e${idx}`} className="event-row">
            <span className="event-time">{m[1]}</span>
            <span className="event-text">{linkifyDriveUrls(m[2], `e${idx}`)}</span>
          </div>
        );
      } else if (line.trim()) {
        const isDayLabel = /:\s*$/.test(line);
        elements.push(
          <div key={`t${idx}`} className={isDayLabel ? "event-day" : "event-intro"}>
            {linkifyDriveUrls(line, `t${idx}`)}
          </div>
        );
      }
    });
    return <>{elements}</>;
  }

  async function sendMessage() {
    if (!input.trim() || loading) return;

    stopListening();

    const userText = input;
    setMessages((prev) => [...prev, { role: "user", content: userText }]);
    setInput("");
    setLoading(true);
    setShowReplyChoice(false);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userText, history: messages, pendingAction }),
      });

      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("text/event-stream")) {
        // Streaming response: append a placeholder on the first delta, then
        // grow it as more deltas arrive. The thinking indicator stays visible
        // until the first delta so an empty bubble never flashes.
        // Streamed replies are conversational and never carry a pendingAction,
        // so clear any stale one to keep the client and server in sync.
        setPendingAction(null);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = "";
        let buffer = "";
        let messageStarted = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6);
            if (payload === "[DONE]") continue;
            try {
              const data = JSON.parse(payload);
              if (data.text) {
                fullText += data.text;
                if (!messageStarted) {
                  messageStarted = true;
                  setLoading(false);
                  setMessages((prev) => [
                    ...prev,
                    { role: "assistant", content: fullText },
                  ]);
                } else {
                  setMessages((prev) => {
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                      role: "assistant",
                      content: fullText,
                    };
                    return updated;
                  });
                }
              } else if (data.error) {
                fullText += `\n[stream error: ${data.error}]`;
              }
            } catch (e) {
              // ignore malformed SSE line
            }
          }
        }

        if (!messageStarted) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: "Jess had no response." },
          ]);
        }
        speak(fullText || "Jess had no response.");
      } else {
        const data = await response.json();
        const reply = data.reply || "Jess had an issue.";
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: reply },
        ]);
        // The server is the source of truth for pendingAction. Whatever it
        // returns (including null/undefined) becomes the new client-side value,
        // so stale confirmations can't linger across unrelated turns.
        setPendingAction(data.pendingAction || null);
        speak(reply);
      }


      setShowReplyChoice(true);
      loadMemory();
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Browser error: " + error.message },
      ]);
    }

    setLoading(false);
  }

  async function checkReminders() {
    try {
      const res = await fetch("/api/reminders/check");
      const data = await res.json();
      const due = data.reminders || [];
      for (const reminder of due) {
        if (shownRemindersRef.current.has(reminder.id)) continue;
        shownRemindersRef.current.add(reminder.id);

        // remind_at is stored as UTC ISO in Supabase — format it in Phoenix
        // time so Brad sees when the reminder was supposed to fire (helps
        // distinguish "fired on time" from "fired late after page reopen").
        const phoenixTime = new Date(reminder.remind_at).toLocaleString("en-US", {
          timeZone: "America/Phoenix",
          weekday: "long",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
        const text = `⏰ Reminder (${phoenixTime}): ${reminder.message}`;
        setMessages((prev) => [...prev, { role: "assistant", content: text }]);
        speak(`Reminder. ${reminder.message}`);

        try {
          await fetch("/api/reminders", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: reminder.id }),
          });
        } catch (patchErr) {
          // ignore — local de-dup prevents repeats this session
        }
      }
    } catch (e) {
      // network blip — swallow so the chat UI keeps working
    }
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

  useEffect(() => { loadMemory(); }, []);

  useEffect(() => {
    checkReminders();
    const interval = setInterval(checkReminders, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    if (navigator.mediaDevices?.getUserMedia && !micStreamRef.current) {
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          micStreamRef.current = stream;
        })
        .catch(() => {
          // user denied or unavailable; voice input will fail gracefully when invoked
        });
    }

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";

      recognition.onresult = (event) => {
        let transcript = "";
        for (let i = 0; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        setInput(transcript);
      };
      recognition.onend = () => {
        if (isListeningRef.current) {
          try {
            recognition.start();
          } catch (e) {
            isListeningRef.current = false;
            setIsListening(false);
          }
        } else {
          setIsListening(false);
        }
      };
      recognition.onerror = (event) => {
        if (event.error === "no-speech" || event.error === "aborted") {
          // let onend decide whether to restart
          return;
        }
        isListeningRef.current = false;
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    }

    function pickVoice() {
      const voices = window.speechSynthesis?.getVoices() || [];
      if (!voices.length) return;
      const preferred = [
        "Google US English",
        "Samantha",
        "Microsoft Aria Online (Natural) - English (United States)",
        "Microsoft Jenny Online (Natural) - English (United States)",
        "Microsoft Zira - English (United States)",
        "Microsoft Zira Desktop - English (United States)",
      ];
      let voice = voices.find((v) => preferred.includes(v.name));
      if (!voice) voice = voices.find((v) => /female|samantha|zira|aria|jenny/i.test(v.name));
      if (!voice) voice = voices.find((v) => v.lang?.startsWith("en"));
      voiceRef.current = voice || voices[0];
    }
    pickVoice();
    if (window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = pickVoice;
    }

    return () => {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((t) => t.stop());
        micStreamRef.current = null;
      }
    };
  }, []);

  function speak(text) {
    if (typeof window === "undefined" || !window.speechSynthesis || !text) return;
    // Drop PENDING_ATTACHMENT and other HTML comments before TTS — Brad
    // shouldn't hear "less-than-exclamation-dash-dash" read aloud.
    const cleaned = String(text).replace(/<!--[\s\S]*?-->/g, "").trim();
    if (!cleaned) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(cleaned);
    if (voiceRef.current) utterance.voice = voiceRef.current;
    utterance.rate = 1;
    utterance.pitch = 1.05;
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utterance);
  }

  function stopSpeaking() {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
  }

  function chooseVoiceReply() {
    setShowReplyChoice(false);
    if (!isListening) toggleListening();
  }

  function chooseTextReply() {
    setShowReplyChoice(false);
    inputRef.current?.focus();
  }

  function toggleListening() {
    if (!recognitionRef.current) {
      alert("Voice input isn't supported in this browser. Try Chrome or Edge.");
      return;
    }
    if (isListening) {
      isListeningRef.current = false;
      try { recognitionRef.current.stop(); } catch (e) {}
      setIsListening(false);
      return;
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setInput("");
    isListeningRef.current = true;
    try {
      recognitionRef.current.start();
      setIsListening(true);
    } catch (e) {
      isListeningRef.current = false;
      setIsListening(false);
    }
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  return (
    <>
      <style>{styles}</style>
      <main className="app">

        {/* HEADER */}
        <header className="header">
          <div className="header-brand">
            <div className="header-title">
              <span className="header-title-dot" />
              Jess AI
            </div>
            <div className="header-sub">Brad's assistant</div>
          </div>
          <div className="header-actions">
            <button
              className="btn"
              onClick={() => {
                stopSpeaking();
                setShowReplyChoice(false);
                setPendingAction(null);
                setMessages([{ role: "assistant", content: "Hey Brad — I'm Jess. What do you need?" }]);
              }}
            >
              Clear
            </button>
            <button
              className={`btn ${showMemory ? "active" : ""}`}
              onClick={() => setShowMemory(!showMemory)}
            >
              Memory
            </button>
          </div>
        </header>

        {/* MEMORY PANEL */}
        {showMemory && (
          <section className="memory-panel">
            <div className="memory-title">Memory</div>

            {memories.length === 0 && (
              <p className="memory-empty">No memories yet.</p>
            )}

            {memories.map((memory) => (
              <div key={memory.id} className="memory-item">
                <div className="memory-dot" />
                <div className="memory-content">
                  {editingId === memory.id ? (
                    <input
                      className="memory-input"
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && updateMemory(memory.id)}
                      autoFocus
                    />
                  ) : (
                    memory.content
                  )}
                </div>
                <div className="memory-actions">
                  {editingId === memory.id ? (
                    <button className="memory-btn" onClick={() => updateMemory(memory.id)}>
                      Save
                    </button>
                  ) : (
                    <>
                      <button
                        className="memory-btn"
                        onClick={() => { setEditingId(memory.id); setEditingText(memory.content); }}
                      >
                        Edit
                      </button>
                      <button
                        className="memory-btn delete"
                        onClick={() => deleteMemory(memory.id)}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </section>
        )}

        {/* CHAT */}
        <section className="chat">
          {messages.map((msg, i) => (
            <div key={i} className={`message-row ${msg.role}`}>
              <div className={`message-label ${msg.role === "user" ? "label-brad" : "label-jess"}`}>
                {msg.role === "user" ? "BRAD" : "JESS"}
              </div>
              <div className={`bubble ${msg.role}`}>
                {msg.role === "assistant" ? renderAssistantContent(msg.content) : msg.content}
              </div>
            </div>
          ))}

          {loading && (
            <div className="message-row assistant">
              <div className="message-label label-jess">JESS</div>
              <div className="thinking">
                <div className="thinking-dot" />
                <div className="thinking-dot" />
                <div className="thinking-dot" />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </section>

        {/* INPUT */}
        <div className="input-bar">
          {isSpeaking && (
            <div className="voice-bar">
              <button className="stop-btn" onClick={stopSpeaking}>
                Stop Jess
              </button>
            </div>
          )}
          {showReplyChoice && !isSpeaking && !isListening && !loading && !input.trim() && (
            <div className="voice-bar">
              <div className="reply-choice">
                <button className="reply-choice-btn" onClick={chooseVoiceReply}>
                  Reply by Voice
                </button>
                <button className="reply-choice-btn" onClick={chooseTextReply}>
                  Reply by Text
                </button>
              </div>
            </div>
          )}
          <div className="input-wrap">
            <input
              ref={inputRef}
              className="input-field"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              placeholder={isListening ? "Listening..." : "Ask Jess..."}
            />
            <button
              type="button"
              className={`mic-btn ${isListening ? "listening" : ""}`}
              onClick={toggleListening}
              aria-label={isListening ? "Stop listening" : "Start voice input"}
              title={isListening ? "Stop listening" : "Start voice input"}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            </button>
            <button
              className="send-btn"
              onClick={sendMessage}
              disabled={loading || !input.trim()}
            >
              Send
            </button>
          </div>
        </div>

      </main>
    </>
  );
}

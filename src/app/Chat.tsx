import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";


type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  selectedModel?: LocalModel | null | undefined;
};

type LocalModel = {
  id: string;
  detail?: string;
};

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function Chat() {
  const models: LocalModel[] = useMemo(
    () => [
      { id: "gemma-2-2b", detail: "Local" },
      { id: "llama-3-2-3b", detail: "Local" },
      { id: "qwen2-5-1-5b", detail: "Local" },
    ],
    []
  );

  const [selectedModelId, setSelectedModelId] = useState(models[0]?.id ?? "");
  const selectedModel = models.find((m) => m.id === selectedModelId);

  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: createId(),
      role: "assistant",
      content:
        "Hello! I am your local AI assistant. How can I help you today?",
      createdAt: Date.now(),
    },
  ]);

  const [draft, setDraft] = useState("");
  const [isThinking, setIsThinking] = useState(false);

  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, isThinking]);

  async function sendMessage() {
    const text = draft.trim();
    if (!text || isThinking) return;

    const userMessage: ChatMessage = {
      id: createId(),
      role: "user",
      content: text,
      createdAt: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setDraft("");
    setIsThinking(true);

    // Placeholder: aqui entra a integração com seu runner local (Gemma, etc.).
    // Ex.: invoke("chat", { model: selectedModelId, messages: ... })

    await new Promise((r) => setTimeout(r, 450));

    const assistantMessage: ChatMessage = {
      id: createId(),
      role: "assistant",
      selectedModel: selectedModel,
      content: `I haven't connected the local runtime yet — but the UI is ready to plug in the backend.`,
      createdAt: Date.now(),
    };
    setMessages((prev) => [...prev, assistantMessage]);
    setIsThinking(false);
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-400/30 border border-gray-400 shadow-lg">
            <span className="text-[11px] text-white/60">Model</span>
            <span className="text-[11px] font-semibold text-white/90">
              {selectedModel?.id ?? "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto rounded-2xl bg-gray-400/20 cerebro-scrollbar"
      >
        <div className="p-2 space-y-3">
          {messages.length === 0 ? (
            <div className="text-sm text-white/70">No messages yet.</div>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${
                  m.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={
                    m.role === "user"
                      ? "max-w-[85%] rounded-2xl rounded-tr-md bg-black/50 text-white border border-gray-400 px-3 pt-1 pb-2"
                      : "max-w-[85%] rounded-2xl rounded-tl-md bg-white/20 text-white border border-gray-400 px-3 pt-1 pb-2"
                  }
                >
                  <div className="text-[10px] uppercase tracking-wider opacity-80">
                    {m.role === "user" ? "You" : m.selectedModel?.id ?? "AI"}
                  </div>
                  <div className="tracking-tight text-sm text-white">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {m.content}
                    </ReactMarkdown>
                  </div>
                </div>
              </div>
            ))
          )}

          {isThinking ? (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-tl-md bg-white/30 text-white shadow-2xl border border-gray-400 px-4 py-3">
                <div className="text-[11px] uppercase tracking-wider opacity-60 mb-1">
                  AI
                </div>
                <div className="text-sm text-white/70">Thinking...</div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Composer */}
      <div className="mt-3">
        <div className="rounded-2xl bg-gray-400/20 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1 bg-gray-400/30 border-b border-gray-400">
            <label className="text-[11px] font-semibold text-white/80">
              Model
            </label>
            <select
              value={selectedModelId}
              onChange={(e) => setSelectedModelId(e.target.value)}
              className="flex-1 min-w-0 text-xs rounded-xl bg-white/30 text-white px-3 py-2 shadow-lg border border-gray-400 focus:outline-none"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-end gap-1.5 p-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              rows={3}
              placeholder="Write your message here... (Enter to send, Shift+Enter to break line)"
              className="flex-1 resize-none rounded-2xl bg-white/20 px-4 py-3 text-xs text-white border border-gray-400 focus:outline-none"
            />

            <button
              type="button"
              onClick={sendMessage}
              disabled={isThinking || !draft.trim()}
              className={
                "shrink-0 rounded-2xl px-4 py-3 text-sm font-semibold transition-all shadow-xl " +
                (isThinking || !draft.trim()
                  ? "bg-gray-400/30 text-white/50 cursor-not-allowed"
                  : "bg-white text-black hover:bg-gray-100/80")
              }
            >
              Send
            </button>
          </div>
        </div>

        <p className="mt-1 text-center text-[9px] text-white/50">
          Contribute to this open-source project on{" "}
          <a
            className="underline"
            href="https://github.com/lucasmengarda/cerebro"
          >
            GitHub
          </a>
          .
        </p>
      </div>
    </div>
  );
}

export default Chat;

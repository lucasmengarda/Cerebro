import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  INSTALLED_MODELS_STORAGE_KEY,
  MODELS,
} from "./modelCatalog";

type DownloadStartedPayload = {
  download_id: string;
  local_dir: string;
};

function safeReadInstalled(): string[] {
  try {
    const raw = localStorage.getItem(INSTALLED_MODELS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function safeWriteInstalled(ids: string[]) {
  try {
    localStorage.setItem(INSTALLED_MODELS_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // ignore
  }
}

const HF_TOKEN_KEY = "com.genoalabs.cerebro.huggingface.token.v1";

function Models() {
  const [installedIds, setInstalledIds] = useState<string[]>(() => safeReadInstalled());
  const [downloadingIds, setDownloadingIds] = useState<string[]>([]);
  const [downloadProgressPct, setDownloadProgressPct] = useState<
    Record<string, number | null>
  >({});
  const downloadingRef = useRef<Record<string, string>>({});
  const [huggingFaceToken, setHuggingFaceToken] = useState<string>(() => {
    return localStorage.getItem(HF_TOKEN_KEY) || ""
  })

  useEffect(() => {
    safeWriteInstalled(installedIds);
  }, [installedIds]);

  useEffect(() => {
    localStorage.setItem(HF_TOKEN_KEY, huggingFaceToken);
  }, [huggingFaceToken]);

  const installedSet = useMemo(() => new Set(installedIds), [installedIds]);
  const downloadingSet = useMemo(
    () => new Set(downloadingIds),
    [downloadingIds]
  );

  useEffect(() => {
    let unlistenDone: null | (() => void) = null;
    let unlistenError: null | (() => void) = null;
    let unlistenProgress: null | (() => void) = null;

    (async () => {
      unlistenDone = await listen<{
        download_id: string;
        repo_id: string;
        path: string;
      }>("cerebro:model_download_done", (event) => {
        const repoId = event.payload?.repo_id;
        if (!repoId) return;

        // Mark installed by matching repo_id back to model id.
        const model = MODELS.find((m) => m.huggingfaceId === repoId);
        if (!model) return;

        setDownloadingIds((prev) => prev.filter((x) => x !== model.id));
        setDownloadProgressPct((prev) => ({ ...prev, [model.id]: null }));
        setInstalledIds((prev) => (prev.includes(model.id) ? prev : [model.id, ...prev]));
      });

      unlistenProgress = await listen<{
        download_id: string;
        repo_id?: string | null;
        n: number;
        total: number | null;
        desc?: string | null;
      }>("cerebro:model_download_progress", (event) => {
        const downloadId = event.payload?.download_id;
        if (!downloadId) return;

        // Prefer mapping by download_id -> model id (most reliable).
        let modelId = downloadingRef.current[downloadId];

        // Fallback: map by repo_id (helps when progress arrives before we store download_id).
        if (!modelId) {
          const repoId = event.payload?.repo_id ?? null;
          if (repoId) {
            const model = MODELS.find((m) => m.huggingfaceId === repoId);
            if (model) modelId = model.id;
          }
        }

        if (!modelId) return;

        const n = Number(event.payload?.n ?? 0);
        const totalRaw = event.payload?.total;
        const total = totalRaw == null ? null : Number(totalRaw);

        if (!Number.isFinite(n) || n < 0) return;
        if (total == null || !Number.isFinite(total) || total <= 0) {
          setDownloadProgressPct((prev) => ({ ...prev, [modelId]: null }));
          return;
        }

        const pct = Math.max(0, Math.min(100, (n / total) * 100));
        setDownloadProgressPct((prev) => ({ ...prev, [modelId]: pct }));
      });

      unlistenError = await listen<{
        download_id: string | null;
        repo_id: string | null;
        message: string;
      }>("cerebro:model_download_error", (event) => {
        const repoId = event.payload?.repo_id;
        if (!repoId) return;
        const model = MODELS.find((m) => m.huggingfaceId === repoId);
        if (!model) return;
        setDownloadingIds((prev) => prev.filter((x) => x !== model.id));
        setDownloadProgressPct((prev) => ({ ...prev, [model.id]: null }));
      });
    })();

    return () => {
      if (unlistenDone) unlistenDone();
      if (unlistenProgress) unlistenProgress();
      if (unlistenError) unlistenError();
    };
  }, []);

  async function installModel(id: string) {

    const model = MODELS.find((m) => m.id === id);
    if (!model) return;
    if (downloadingSet.has(id)) return;

    setDownloadingIds((prev) => (prev.includes(id) ? prev : [id, ...prev]));
    try {
      const started = await invoke<DownloadStartedPayload>("model_download_start", {
        payload: {
          repo_id: model.huggingfaceId,
          token: huggingFaceToken.trim(),
        },
      });
      downloadingRef.current[started.download_id] = id;
    } catch {
      setDownloadingIds((prev) => prev.filter((x) => x !== id));
    }
  }

  function removeModel(id: string) {
    setInstalledIds((prev) => prev.filter((x) => x !== id));
  }

  return (
    <div className="h-full flex flex-col shrink-0 w-full transition-transform ease-in-out duration-300">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-3">
        
      </div>

      {/* Hugging Face Token */}
      <div className="mb-4 px-3 py-2 bg-white/30 border border-gray-400 rounded-2xl text-xs text-white/80">
        To download models, please insert your <b>Hugging Face</b> token below: <p className="text-[9px]">(We do not store or transmit your token anywhere else.)</p>
        <input
          type="password"
          className="mt-2 w-full rounded-md bg-black/50 border border-gray-400 px-3 py-1 text-white/90 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Hugging Face Token"
          onChange={(e) => {
            const token = e.target.value.trim();
            setHuggingFaceToken(token);
          }}
          value={huggingFaceToken}
        />
      </div>

      {/* List */}
      <div className={"flex-1 overflow-y-auto rounded-2xl bg-gray-400/20 cerebro-scrollbar " + (huggingFaceToken.trim() === "" ? "hidden" : "")}>
        <div className="p-2 space-y-4">
          {MODELS.map((m) => {
            const isInstalled = installedSet.has(m.id);
            const isDownloading = downloadingSet.has(m.id);
            const pct = downloadProgressPct[m.id];
            return (
              <div
                key={m.id}
                className="rounded-2xl bg-gray-400/30 border border-gray-400 overflow-hidden"
              >
                <div className="px-3 py-2 bg-gray-400/30 border-b border-gray-400 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-white/90 truncate">
                      {m.name}
                    </div>
                    <div className="text-[11px] text-white/60 truncate">
                      {m.id} • {m.approxSize}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span
                      className={
                        "text-[10px] font-bold tracking-tight px-2 py-0.5 rounded-full border " +
                        (isInstalled
                          ? "bg-white/30 border-gray-400 text-white"
                          : downloadingSet.has(m.id)
                          ? "bg-white/30 border-gray-400 text-white"
                          : "bg-white/30 border-gray-400 text-black/80")
                      }
                    >
                      {isInstalled
                        ? "Installed"
                        : isDownloading
                        ? typeof pct === "number"
                          ? `Downloading ${pct.toFixed(1)}%`
                          : "Downloading"
                        : "Not installed"}
                    </span>
                  </div>
                </div>

                <div className="p-3">
                  <div className="text-xs text-white/80">{m.summary}</div>

                  <div className="mt-3 flex items-center justify-end gap-2">
                    {isInstalled ? (
                      <button
                        type="button"
                        onClick={() => removeModel(m.id)}
                        className="rounded-2xl px-4 py-2 text-xs font-semibold shadow-xl border border-gray-400 bg-black/70 text-white hover:bg-gray-500/80"
                      >
                        Remove
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => installModel(m.id)}
                        disabled={isDownloading}
                        className="rounded-2xl px-4 py-2 text-xs font-semibold border border-gray-400 bg-black/70 text-white hover:bg-gray-400/80"
                      >
                        {isDownloading
                          ? "Downloading..."
                          : "Download"}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default Models;

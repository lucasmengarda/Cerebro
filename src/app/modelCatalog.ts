export type LocalModel = {
  id: string;
  name: string;
  dateref: string;
  summary: string;
  approxSize: string;
  huggingfaceId: string;
};

// Fixed list for now (no discovery).
export const MODELS: LocalModel[] = [
  {
    id: "gemma-3-27b-it",
    name: "Gemma 3 (27B)",
    dateref: "",
    summary:
      "Gemma is a family of lightweight, state-of-the-art open models from Google, built from the same research and technology used to create the Gemini models.",
    approxSize: "~55 GB",
    huggingfaceId: "google/gemma-3-27b-it",
  },
  {
    id: "gemma-3-4b-it",
    name: "Gemma 3 (4B)",
    dateref: "",
    summary:
      "Gemma is a family of lightweight, state-of-the-art open models from Google, built from the same research and technology used to create the Gemini models.",
    approxSize: "~9 GB",
    huggingfaceId: "google/gemma-3-4b-it",
  },
  {
    id: "gemma-3-1b-it",
    name: "Gemma 3 (1B)",
    dateref: "",
    summary:
      "Gemma is a family of lightweight, state-of-the-art open models from Google, built from the same research and technology used to create the Gemini models.",
    approxSize: "~2 GB",
    huggingfaceId: "google/gemma-3-1b-it",
  },
  {
    id: "qwen3-4B-Instruct-2507",
    name: "Qwen 3 (4B)",
    dateref: "",
    summary:
      "Qwen3 is the latest generation of large language models in Qwen series, offering a comprehensive suite of dense and mixture-of-experts (MoE) models.",
    approxSize: "~8 GB",
    huggingfaceId: "Qwen/Qwen3-4B-Instruct-2507",
  },
];

export const INSTALLED_MODELS_STORAGE_KEY =
  "com.genoalabs.cerebro.models.installed.v1";

export function safeReadInstalledModelIds(): string[] {
  try {
    const raw = localStorage.getItem(INSTALLED_MODELS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x) => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

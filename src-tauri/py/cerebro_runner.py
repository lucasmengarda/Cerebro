#!/usr/bin/env python3
import json
import os
import sys
import threading
import time
import requests
from typing import Any, Dict, Optional, List


def _send(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()

def _import_hf_hub():
    try:
        from huggingface_hub import HfApi, hf_hub_download, hf_hub_url
    except Exception as e:
        raise RuntimeError(
            "Missing Python deps. Install: pip install huggingface_hub"
        ) from e
    return HfApi, hf_hub_download, hf_hub_url


def _file_expected_size_from_model_info(info, filename: str) -> Optional[int]:
    try:
        for s in getattr(info, "siblings", []) or []:
            if getattr(s, "rfilename", None) != filename:
                continue
            # huggingface_hub may provide size directly, and/or an LFS blob size.
            size = getattr(s, "size", None)
            if isinstance(size, int) and size > 0:
                return size
            lfs = getattr(s, "lfs", None)
            lfs_size = getattr(lfs, "size", None) if lfs is not None else None
            if isinstance(lfs_size, int) and lfs_size > 0:
                return lfs_size
    except Exception:
        pass
    return None


def _ensure_parent_dir(path: str) -> None:
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)


def _download_streaming(
    *,
    url: str,
    dest_path: str,
    token: Optional[str],
    expected_size: Optional[int],
    cancel_event: threading.Event,
    on_progress,
    overall_base: int,
) -> int:
    """Download a single file with streaming + resume.

    Returns bytes written for this file (including any resumed bytes already on disk).
    """

    _ensure_parent_dir(dest_path)

    existing = 0
    if os.path.exists(dest_path):
        try:
            existing = int(os.path.getsize(dest_path))
        except Exception:
            existing = 0

        # If we already have the full file, skip.
        if expected_size is not None and existing == expected_size:
            return existing

        # If local file is larger than expected, restart.
        if expected_size is not None and existing > expected_size:
            try:
                os.remove(dest_path)
            except Exception:
                pass
            existing = 0

    headers = {
        # Avoid transparent decompression changing byte counts
        "Accept-Encoding": "identity",
        "User-Agent": "cerebro/0.1 (tauri; python)",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    mode = "ab" if existing > 0 else "wb"
    if existing > 0:
        headers["Range"] = f"bytes={existing}-"

    try:
        chunk_size = 1024 * 1024  # 1MB
        written = existing
        last_emit_t = 0.0
        last_emit_bytes = existing

        def _request(stream_headers: Dict[str, str]):
            return requests.get(
                url,
                headers=stream_headers,
                stream=True,
                timeout=60,
                allow_redirects=True,
            )

        resp = _request(headers)

        # If server ignored Range, restart from scratch
        if existing > 0 and resp.status_code != 206:
            resp.close()
            existing = 0
            written = 0
            mode = "wb"
            headers.pop("Range", None)
            resp = _request(headers)

        if resp.status_code >= 400:
            msg = f"HTTP {resp.status_code}"
            try:
                msg = f"HTTP {resp.status_code}: {resp.text[:200]}"
            except Exception:
                pass
            raise RuntimeError(f"HTTP error downloading file: {msg}")

        with open(dest_path, mode) as f:
            for chunk in resp.iter_content(chunk_size=chunk_size):
                if cancel_event.is_set():
                    raise RuntimeError("Download cancelled")
                if not chunk:
                    continue
                f.write(chunk)
                written += len(chunk)

                now = time.time()
                if (written - last_emit_bytes) >= (1024 * 1024) or (now - last_emit_t) >= 0.25:
                    last_emit_t = now
                    last_emit_bytes = written
                    on_progress(overall_base + written)

        resp.close()
        on_progress(overall_base + written)
        return written
    except requests.RequestException as e:
        raise RuntimeError(f"Network error downloading file: {e}") from e


class Runner:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._loaded: Dict[str, Dict[str, Any]] = {}
        self._messages: Dict[str, List[Any]] = {}
        self._cancel: Dict[str, threading.Event] = {}
        self._download_cancel: Dict[str, threading.Event] = {}

    def cancel(self, generation_id: str) -> None:
        with self._lock:
            ev = self._cancel.get(generation_id)
        if ev is not None:
            ev.set()

    def cancel_download(self, download_id: str) -> None:
        with self._lock:
            ev = self._download_cancel.get(download_id)
        if ev is not None:
            ev.set()

    def download_model(
        self,
        download_id: str,
        repo_id: str,
        revision: Optional[str],
        local_dir: Optional[str],
        token: Optional[str],
    ) -> None:
        
        print(f"Starting download: {download_id} for repo: {repo_id}", file=sys.stderr)
        
        cancel_event = threading.Event()
        with self._lock:
            self._download_cancel[download_id] = cancel_event

        try:
            HfApi, hf_hub_download, hf_hub_url = _import_hf_hub()

            _send(
                {
                    "type": "download_started",
                    "download_id": download_id,
                    "repo_id": repo_id,
                }
            )

            api = HfApi()

            # Byte-based progress: fetch file metadata (sizes) once.
            info = api.model_info(repo_id, revision=revision, files_metadata=True, token=token)

            files = [getattr(s, "rfilename", None) for s in getattr(info, "siblings", []) or []]
            files = [f for f in files if isinstance(f, str) and f]
            if not files:
                raise RuntimeError("No files found in repo")

            # Precompute total bytes.
            per_file_size: Dict[str, Optional[int]] = {}
            total_bytes = 0
            unknown = False
            for filename in files:
                sz = _file_expected_size_from_model_info(info, filename)
                per_file_size[filename] = sz
                if isinstance(sz, int) and sz > 0:
                    total_bytes += sz
                else:
                    unknown = True

            # If some sizes are unknown, we still emit progress, but total may be None.
            total_for_ui = None if unknown or total_bytes <= 0 else int(total_bytes)

            # Emit an initial progress tick.
            _send(
                {
                    "type": "download_progress",
                    "download_id": download_id,
                    "repo_id": repo_id,
                    "n": 0,
                    "total": total_for_ui,
                    "desc": "Starting download",
                }
            )

            downloaded_bytes = 0

            def emit_progress(n_bytes: int, desc: Optional[str] = None) -> None:
                payload = {
                    "type": "download_progress",
                    "download_id": download_id,
                    "repo_id": repo_id,
                    "n": int(n_bytes),
                    "total": total_for_ui,
                    "desc": desc,
                }
                _send(payload)

            for filename in files:
                if cancel_event.is_set():
                    raise RuntimeError("Download cancelled")

                emit_progress(downloaded_bytes, filename)

                # Determine destination path inside local_dir
                if not local_dir:
                    raise RuntimeError("Missing local_dir")
                dest_path = os.path.join(local_dir, filename)

                expected_size = per_file_size.get(filename)

                # Build URL and stream download. This yields frequent progress updates even
                # for a single multi-GB safetensors shard.
                url = hf_hub_url(repo_id=repo_id, filename=filename, revision=revision, repo_type="model")

                before = downloaded_bytes

                def on_progress(n_total_for_this_file: int) -> None:
                    # n_total_for_this_file includes already-present bytes for this file
                    # overall_base was 'before'.
                    emit_progress(n_total_for_this_file, filename)

                written = _download_streaming(
                    url=url,
                    dest_path=dest_path,
                    token=token,
                    expected_size=expected_size,
                    cancel_event=cancel_event,
                    on_progress=on_progress,
                    overall_base=before,
                )

                # Advance overall counter by the file's expected size if known, else by written.
                if isinstance(expected_size, int) and expected_size > 0:
                    downloaded_bytes = before + expected_size
                else:
                    downloaded_bytes = before + int(written)

                emit_progress(downloaded_bytes, filename)

            path = local_dir or ""
            
            print(f"Download done: {download_id} for repo: {repo_id}", file=sys.stderr)

            _send(
                {
                    "type": "download_done",
                    "download_id": download_id,
                    "repo_id": repo_id,
                    "path": path,
                }
            )
        except Exception as e:
            print(f"Download error: {download_id} for repo: {repo_id}: {e}", file=sys.stderr)
            _send(
                {
                    "type": "download_error",
                    "download_id": download_id,
                    "repo_id": repo_id,
                    "message": str(e),
                }
            )
        finally:
            with self._lock:
                self._download_cancel.pop(download_id, None)

    def generate(
        self,
        generation_id: str,
        model_name: str,
        prompt: str,
        max_new_tokens: int,
        temperature: float,
    ) -> None:
        try: 
            
            print(f"Starting generation: {generation_id} with model: {model_name}", file=sys.stderr)
            
            cancel_event = threading.Event()
            with self._lock:
                self._cancel[generation_id] = cancel_event
        
            
            import torch
            from transformers import (
                AutoProcessor,
                AutoModelForCausalLM,
                TextIteratorStreamer,
                AutoTokenizer,
                StoppingCriteria,
                StoppingCriteriaList,
            )

            processor = None
            model = None
            messages = None
            as_processor_tokenizer = False
            
            model_id_norm = model_name.split("/")[-1].lower().replace("-", "_").replace(" ", "_")
            
            def select_device():
                if torch.cuda.is_available():
                    return "cuda"
                elif torch.backends.mps.is_available():
                    return "mps"
                else:
                    return "cpu"

            if self._loaded.get(model_id_norm) == None:
                
                # Unload other models to free up memory
                with self._lock:
                    self._loaded = {}

                # Quantization
                # quant_config = HqqConfig(nbits=8, group_size=64) -> Use quant just for NVIDIA GPU
                
                try:
                    if "qwen" in model_id_norm.lower():
                        raise RuntimeError("Qwen models do not support AutoProcessor")
                    
                    processor = AutoProcessor.from_pretrained(model_name, device_map=select_device(), local_files_only=True)
                    as_processor_tokenizer = True
                except Exception as e:
                    # processor as tokenizer
                    processor = AutoTokenizer.from_pretrained(model_name, local_files_only=True)
                    as_processor_tokenizer = False
                    
                    
                model = AutoModelForCausalLM.from_pretrained(
                    model_name,
                    local_files_only=True,
                    dtype=torch.bfloat16,
                    device_map=select_device(), 
                    # quantization_config=quant_config,
                )
                
                print(f"Using device: {select_device()}", file=sys.stderr)
                
                self._loaded[model_id_norm] = {
                    "processor": processor,
                    "model": model
                }
                
            else:
                processor = self._loaded[model_id_norm]["processor"]
                model = self._loaded[model_id_norm]["model"]

            if self._messages.get("messages") == None:
                messages = [
                    {
                        "role": "system",
                        "content": [
                            {
                            "type": "text",
                            "text": "You are a helpful, concise, and direct assistant."
                            },
                            {
                            "type": "text",
                            "text": "Always respond exclusively in the same language used by the user. Do not translate, explain, or repeat the answer in any other language. Do not add translations in parentheses."
                            },
                            {
                            "type": "text",
                            "text": "If you are unsure about an answer, clearly say that you do not know instead of guessing."
                            },
                            {
                            "type": "text",
                            "text": "You were developed by Lucas Mengarda as an open-source local AI project. Never claim a different origin."
                            },
                            {
                            "type": "text",
                            "text": "You are running locally on the user's machine."
                            }
                        ]
                        }
                ]
                self._messages["messages"] = messages
            else:
                messages = self._messages["messages"]
            
            # Add user prompt to messages
            messages.append({
                "role": "user",
                "content": [{"type": "text", "text": prompt}],
            })
            
            
            # Adapt messages if model is Qwen, which do not accept list on content
            updated_messages = []
            
            if "qwen" in model_id_norm.lower():
                for msg in messages:
                    if isinstance(msg["content"], list):
                        combined_text = " ".join([part["text"] for part in msg["content"] if part.get("type") == "text"])
                        updated_messages.append({
                            "role": msg["role"],
                            "content": combined_text
                        })
                    else:
                        updated_messages.append(msg)
                updated_messages
            else:
                updated_messages = messages

            # Aplica o chat template
            inputs = processor.apply_chat_template(
                updated_messages,
                add_generation_prompt=True,
                tokenize=True,
                return_dict=True,
                return_tensors="pt",
            )
            
            if as_processor_tokenizer:
                inputs = inputs.to(model.device, dtype=torch.bfloat16)
            else:
                if "qwen" in model_id_norm:
                    inputs = inputs.to(model.device)
                else:
                    inputs = inputs.to(model.device).to(torch.bfloat16)
                

            # Stream token-by-token to the Rust sidecar bridge.
            # Rust expects runner messages: {type: "token", generation_id, token}
            # and a final {type: "done", generation_id}.

            do_sample = float(temperature) > 0.0 and not select_device() == "mps"
            
            tokenizer = processor.tokenizer if as_processor_tokenizer else processor
            
            streamer = TextIteratorStreamer(tokenizer, skip_special_tokens=True, skip_prompt=True)

            generation_kwargs = {
                **inputs,
                "max_new_tokens": max_new_tokens,
                "temperature": float(temperature),
                "do_sample": do_sample,
                "use_cache": True,
                "streamer": streamer,
            }

            # This exists to allow stopping criteria to access the cancel_event

            class _CancelStop(StoppingCriteria):
                def __call__(self, *args, **kwargs):
                    return cancel_event.is_set()

            generation_kwargs["stopping_criteria"] = StoppingCriteriaList([_CancelStop()])

            # Gera em thread separada
            thread = threading.Thread(target=model.generate, kwargs=generation_kwargs)
            thread.start()

            full_response = ""
            for new_text in streamer:
                
                full_response += new_text
                _send({"type": "chat_token", "generation_id": generation_id, "token": new_text})
                
                # Condição customizada para parar
                # if len(full_response) > 500:
                #     break
                
                if (cancel_event.is_set()):
                    print(f"Generation cancelled: {generation_id}", file=sys.stderr)
                    thread.join(timeout=1.0)
                    break

            thread.join()
            _send({"type": "done", "generation_id": generation_id})
            
            messages.append({
                "role": "assistant",
                "content": [{"type": "text", "text": full_response}],
            })
            
            self._messages["messages"] = messages
            
        except Exception as e:
            print(f"Erro na geração: {e}", file=sys.stderr)
            _send({"type": "error", "generation_id": generation_id, "message": str(e)})
        finally:
            with self._lock:
                self._cancel.pop(generation_id, None)
        pass


def main() -> None:
    runner = Runner()
    _send({"type": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            _send({"type": "error", "generation_id": None, "message": "Invalid JSON"})
            continue

        msg_type = msg.get("type")

        if msg_type == "shutdown":
            _send({"type": "shutdown"})
            return

        if msg_type == "cancel":
            generation_id = msg.get("generation_id")
            if isinstance(generation_id, str):
                runner.cancel(generation_id)
            continue

        if msg_type == "download_cancel":
            download_id = msg.get("download_id")
            if isinstance(download_id, str):
                runner.cancel_download(download_id)
            continue

        if msg_type == "download":
            download_id = msg.get("download_id")
            repo_id = msg.get("repo_id")
            revision = msg.get("revision")
            local_dir = msg.get("local_dir")
            token = msg.get("token")

            if not isinstance(download_id, str) or not download_id:
                _send(
                    {
                        "type": "download_error",
                        "download_id": None,
                        "repo_id": repo_id if isinstance(repo_id, str) else None,
                        "message": "Missing download_id",
                    }
                )
                continue
            if not isinstance(repo_id, str) or not repo_id:
                _send(
                    {
                        "type": "download_error",
                        "download_id": download_id,
                        "repo_id": None,
                        "message": "Missing repo_id",
                    }
                )
                continue
            if revision is not None and not isinstance(revision, str):
                revision = None
            if local_dir is not None and not isinstance(local_dir, str):
                local_dir = None
            if token is not None and not isinstance(token, str):
                token = None

            threading.Thread(
                target=runner.download_model,
                args=(download_id, repo_id, revision, local_dir, token),
                daemon=True,
            ).start()
            continue
        
        if msg_type == "generate":
            
            print("Processing generate request...", file=sys.stderr)
            print(f"Message: {msg}", file=sys.stderr)

            generation_id = msg.get("generation_id")
            model_name = msg.get("model")
            prompt = msg.get("prompt")
            max_new_tokens = msg.get("max_new_tokens", 256)
            temperature = msg.get("temperature", 0.7)

            if not isinstance(generation_id, str):
                print("Missing generation_id", file=sys.stderr)
                _send({"type": "error", "generation_id": None, "message": "Missing generation_id"})
                continue
            if not isinstance(model_name, str) or not model_name:
                print("Missing model", file=sys.stderr)
                _send({"type": "error", "generation_id": generation_id, "message": "Missing model"})
                continue
            if not isinstance(prompt, str):
                print("Missing prompt", file=sys.stderr)
                _send({"type": "error", "generation_id": generation_id, "message": "Missing prompt"})
                continue

            threading.Thread(
                target=runner.generate,
                args=(generation_id, model_name, prompt, int(max_new_tokens), float(temperature)),
                daemon=True,
            ).start()
            continue

        _send({"type": "error", "generation_id": None, "message": f"Unknown type: {msg_type}"})


if __name__ == "__main__":
    main()

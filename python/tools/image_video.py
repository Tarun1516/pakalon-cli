"""
image_video.py — Image and video analysis tools for Pakalon agents.
T100: ImageAnalysisTool and VideoAnalysisTool using vision model via OpenRouter.
"""
from __future__ import annotations

import base64
import os
import pathlib
import subprocess
import tempfile
from typing import Any

import httpx

VISION_MODEL = os.environ.get("PAKALON_VISION_MODEL", "google/gemini-flash-1.5-8b")
OPENROUTER_BASE = "https://openrouter.ai/api/v1"


def _vision_call(
    b64_images: list[str],
    prompt: str,
    api_key: str,
    model: str = VISION_MODEL,
    max_tokens: int = 1024,
) -> str:
    """Shared OpenRouter vision call helper."""
    if not api_key:
        return "[No OPENROUTER_API_KEY set]"

    content: list[dict[str, Any]] = [
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}
        for b64 in b64_images
    ]
    content.append({"type": "text", "text": prompt})

    try:
        with httpx.Client(timeout=60) as client:
            resp = client.post(
                f"{OPENROUTER_BASE}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": content}],
                    "max_tokens": max_tokens,
                },
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]
    except Exception as e:
        return f"[Vision error: {e}]"


class ImageAnalysisTool:
    """
    Analyze images using a vision model.
    Returns description, detected text, and UI elements.
    """

    def __init__(self, api_key: str | None = None) -> None:
        self._api_key = api_key or os.environ.get("OPENROUTER_API_KEY", "")

    def analyze(self, path: str) -> dict[str, Any]:
        """
        Analyze an image file.
        Returns {description, detected_text, ui_elements, colors, resolution}.
        """
        img_path = pathlib.Path(path)
        if not img_path.exists():
            return {"error": f"File not found: {path}"}

        # Read + encode image
        raw_bytes = img_path.read_bytes()
        b64 = base64.b64encode(raw_bytes).decode()

        # Resolution
        resolution = self._get_resolution(raw_bytes)

        prompt = (
            "Analyze this image and return JSON with: "
            "1) description: one paragraph description, "
            "2) detected_text: any text visible in the image, "
            "3) ui_elements: list of UI components visible (buttons, inputs, etc.), "
            "4) colors: dominant color palette as hex codes. "
            "Return ONLY valid JSON."
        )
        raw = _vision_call([b64], prompt, self._api_key)

        # Parse JSON
        try:
            import json, re
            match = re.search(r"\{.*\}", raw, re.DOTALL)
            if match:
                result = json.loads(match.group())
                result["resolution"] = resolution
                result["path"] = path
                return result
        except Exception:
            pass

        return {
            "description": raw[:500],
            "detected_text": "",
            "ui_elements": [],
            "colors": [],
            "resolution": resolution,
            "path": path,
        }

    def analyze_ui_screenshot(self, path: str) -> dict[str, Any]:
        """
        Specialized analysis for UI screenshots — for TDD comparisons.
        Returns {has_navbar, has_footer, has_sidebar, sections, forms, interactive_elements}.
        """
        img_path = pathlib.Path(path)
        if not img_path.exists():
            return {"error": f"File not found: {path}"}

        b64 = base64.b64encode(img_path.read_bytes()).decode()
        prompt = (
            "Inspect this UI screenshot and return JSON with: "
            "has_navbar (bool), has_footer (bool), has_sidebar (bool), "
            "sections (list of section names/labels), "
            "forms (list of form names), "
            "interactive_elements (list of buttons/links/inputs visible). "
            "Return ONLY valid JSON."
        )
        raw = _vision_call([b64], prompt, self._api_key)
        try:
            import json, re
            match = re.search(r"\{.*\}", raw, re.DOTALL)
            if match:
                return json.loads(match.group())
        except Exception:
            pass
        return {"error": raw[:200]}

    @staticmethod
    def _get_resolution(raw_bytes: bytes) -> str:
        """Get image resolution as 'WxH' string."""
        try:
            from PIL import Image  # type: ignore
            import io
            img = Image.open(io.BytesIO(raw_bytes))
            return f"{img.width}x{img.height}"
        except Exception:
            return "unknown"


class VideoAnalysisTool:
    """
    Extract frames from a video and analyze them with a vision model.
    Uses ffmpeg for frame extraction.
    """

    def __init__(self, api_key: str | None = None) -> None:
        self._api_key = api_key or os.environ.get("OPENROUTER_API_KEY", "")

    def extract_and_analyze(
        self,
        path: str,
        fps: int = 1,
        max_frames: int = 10,
    ) -> list[dict[str, Any]]:
        """
        Extract frames at `fps` rate and analyze each with vision model.
        Returns list of frame analysis dicts with timestamps.
        """
        video_path = pathlib.Path(path)
        if not video_path.exists():
            return [{"error": f"File not found: {path}"}]

        frame_paths = self._extract_frames(str(video_path), fps, max_frames)
        if not frame_paths:
            return [{"error": "Could not extract frames — is ffmpeg installed?"}]

        results = []
        image_tool = ImageAnalysisTool(api_key=self._api_key)
        for i, frame_path in enumerate(frame_paths):
            timestamp_s = i / fps
            analysis = image_tool.analyze(frame_path)
            analysis["frame_index"] = i
            analysis["timestamp_seconds"] = timestamp_s
            analysis["timestamp_label"] = f"{int(timestamp_s // 60):02d}:{int(timestamp_s % 60):02d}"
            results.append(analysis)

        # Cleanup temp frames
        for fp in frame_paths:
            try:
                pathlib.Path(fp).unlink(missing_ok=True)
            except Exception:
                pass

        return results

    def get_summary(self, path: str, fps: int = 1, max_frames: int = 5) -> str:
        """
        Quick summary of a video for agent context.
        Returns formatted text summary.
        """
        frames = self.extract_and_analyze(path, fps=fps, max_frames=max_frames)
        if not frames:
            return "No frames could be extracted."
        lines = [f"Video analysis: {path}", f"Analyzed {len(frames)} frames:"]
        for f in frames:
            ts = f.get("timestamp_label", "?")
            desc = f.get("description", f.get("error", "no description"))[:200]
            lines.append(f"  [{ts}] {desc}")
        return "\n".join(lines)

    @staticmethod
    def _extract_frames(
        video_path: str,
        fps: int,
        max_frames: int,
    ) -> list[str]:
        """Extract frames using ffmpeg. Returns list of temp file paths."""
        try:
            tmp_dir = tempfile.mkdtemp(prefix="pakalon_frames_")
            output_pattern = f"{tmp_dir}/frame_%04d.png"
            cmd = [
                "ffmpeg",
                "-i", video_path,
                "-vf", f"fps={fps}",
                "-vframes", str(max_frames),
                "-y",
                output_pattern,
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            if result.returncode != 0:
                return []

            tmp_path = pathlib.Path(tmp_dir)
            frames = sorted(tmp_path.glob("frame_*.png"))
            return [str(f) for f in frames[:max_frames]]
        except Exception:
            return []


# ===========================================================================
# Image Generation (Pro-only) — T-CLI-P8
# ===========================================================================

IMAGE_GEN_PROVIDER_PRIORITY = [
    "fal",          # fal.ai — Flux.1, SDXL
    "openai",       # DALL-E 3
    "stability",    # Stability AI
    "replicate",    # Flux via Replicate
]


class ImageGenerationTool:
    """
    Pro-only AI image generation tool.
    Supports Flux.1 (fal.ai), DALL-E 3 (OpenAI), Stability AI, and Replicate.
    Falls back through providers until one succeeds.
    """

    def __init__(
        self,
        api_key: str | None = None,
        provider: str | None = None,
    ) -> None:
        self._openrouter_key = api_key or os.environ.get("OPENROUTER_API_KEY", "")
        self._fal_key = os.environ.get("FAL_KEY", "")
        self._openai_key = os.environ.get("OPENAI_API_KEY", "")
        self._stability_key = os.environ.get("STABILITY_API_KEY", "")
        self._replicate_key = os.environ.get("REPLICATE_API_TOKEN", "")
        self._provider = provider  # force specific provider or None for auto

    def generate(
        self,
        prompt: str,
        output_path: str | None = None,
        model: str = "flux",
        width: int = 1024,
        height: int = 1024,
        steps: int = 28,
        guidance: float = 3.5,
    ) -> dict[str, Any]:
        """
        Generate an image from a text prompt.
        Returns: {success, image_path, b64, provider, model, error}
        """
        providers = [self._provider] if self._provider else IMAGE_GEN_PROVIDER_PRIORITY

        for provider in providers:
            if provider == "fal" and self._fal_key:
                result = self._gen_fal(prompt, output_path, model, width, height, steps, guidance)
            elif provider == "openai" and self._openai_key:
                result = self._gen_openai(prompt, output_path, width, height)
            elif provider == "stability" and self._stability_key:
                result = self._gen_stability(prompt, output_path, width, height, steps)
            elif provider == "replicate" and self._replicate_key:
                result = self._gen_replicate(prompt, output_path, model, width, height, steps)
            else:
                continue
            if result.get("success"):
                return result

        return {
            "success": False,
            "error": (
                "No image generation provider available. "
                "Set FAL_KEY (fal.ai), OPENAI_API_KEY, STABILITY_API_KEY, or REPLICATE_API_TOKEN."
            ),
        }

    # ---- fal.ai (Flux.1 Dev / Schnell / SDXL) ----

    def _gen_fal(
        self,
        prompt: str,
        output_path: str | None,
        model: str,
        width: int,
        height: int,
        steps: int,
        guidance: float,
    ) -> dict:
        model_id_map = {
            "flux": "fal-ai/flux/dev",
            "flux-schnell": "fal-ai/flux/schnell",
            "flux-pro": "fal-ai/flux-pro",
            "sdxl": "fal-ai/stable-diffusion-xl",
        }
        fal_model = model_id_map.get(model.lower(), "fal-ai/flux/dev")

        try:
            resp = httpx.post(
                f"https://fal.run/{fal_model}",
                headers={"Authorization": f"Key {self._fal_key}",
                         "Content-Type": "application/json"},
                json={"prompt": prompt, "image_size": {"width": width, "height": height},
                      "num_inference_steps": steps, "guidance_scale": guidance},
                timeout=120,
            )
            resp.raise_for_status()
            data = resp.json()
            img_url = data.get("images", [{}])[0].get("url", "")
            if not img_url:
                return {"success": False, "error": f"fal.ai: no image URL in response"}

            # Download image
            img_bytes = httpx.get(img_url, timeout=60).content
            b64 = base64.b64encode(img_bytes).decode()
            fpath = self._save_image(img_bytes, output_path, "png")
            return {"success": True, "image_path": fpath, "b64": b64,
                    "provider": "fal.ai", "model": fal_model, "error": None}
        except Exception as e:
            return {"success": False, "error": f"fal.ai error: {e}"}

    # ---- OpenAI DALL-E 3 ----

    def _gen_openai(
        self,
        prompt: str,
        output_path: str | None,
        width: int,
        height: int,
    ) -> dict:
        # DALL-E 3 supports 1024x1024, 1024x1792, 1792x1024
        size = "1024x1024"
        if width == 1024 and height == 1792:
            size = "1024x1792"
        elif width == 1792 and height == 1024:
            size = "1792x1024"

        try:
            resp = httpx.post(
                "https://api.openai.com/v1/images/generations",
                headers={"Authorization": f"Bearer {self._openai_key}",
                         "Content-Type": "application/json"},
                json={"model": "dall-e-3", "prompt": prompt, "n": 1,
                      "size": size, "response_format": "b64_json"},
                timeout=120,
            )
            resp.raise_for_status()
            b64 = resp.json()["data"][0]["b64_json"]
            img_bytes = base64.b64decode(b64)
            fpath = self._save_image(img_bytes, output_path, "png")
            return {"success": True, "image_path": fpath, "b64": b64,
                    "provider": "openai", "model": "dall-e-3", "error": None}
        except Exception as e:
            return {"success": False, "error": f"OpenAI DALL-E 3 error: {e}"}

    # ---- Stability AI ----

    def _gen_stability(
        self,
        prompt: str,
        output_path: str | None,
        width: int,
        height: int,
        steps: int,
    ) -> dict:
        try:
            resp = httpx.post(
                "https://api.stability.ai/v2beta/stable-image/generate/sd3",
                headers={"Authorization": f"Bearer {self._stability_key}",
                         "Accept": "application/json"},
                data={"prompt": prompt, "output_format": "png",
                      "aspect_ratio": f"{width}:{height}" if width != height else "1:1"},
                timeout=120,
            )
            resp.raise_for_status()
            b64 = resp.json().get("image", "")
            if not b64:
                return {"success": False, "error": "Stability AI: empty image response"}
            img_bytes = base64.b64decode(b64)
            fpath = self._save_image(img_bytes, output_path, "png")
            return {"success": True, "image_path": fpath, "b64": b64,
                    "provider": "stability", "model": "sd3", "error": None}
        except Exception as e:
            return {"success": False, "error": f"Stability AI error: {e}"}

    # ---- Replicate (Flux via Replicate API) ----

    def _gen_replicate(
        self,
        prompt: str,
        output_path: str | None,
        model: str,
        width: int,
        height: int,
        steps: int,
    ) -> dict:
        model_id = "black-forest-labs/flux-dev" if "schnell" not in model else "black-forest-labs/flux-schnell"
        try:
            # Start prediction
            resp = httpx.post(
                f"https://api.replicate.com/v1/models/{model_id}/predictions",
                headers={"Authorization": f"Bearer {self._replicate_key}",
                         "Content-Type": "application/json"},
                json={"input": {"prompt": prompt, "width": width, "height": height,
                                "num_inference_steps": steps}},
                timeout=30,
            )
            resp.raise_for_status()
            prediction_id = resp.json()["id"]

            # Poll until done (max 90s)
            import time as _time
            for _ in range(18):
                _time.sleep(5)
                poll = httpx.get(
                    f"https://api.replicate.com/v1/predictions/{prediction_id}",
                    headers={"Authorization": f"Bearer {self._replicate_key}"},
                    timeout=15,
                )
                data = poll.json()
                if data["status"] == "succeeded":
                    img_url = data["output"][0] if isinstance(data["output"], list) else data["output"]
                    img_bytes = httpx.get(img_url, timeout=60).content
                    b64 = base64.b64encode(img_bytes).decode()
                    fpath = self._save_image(img_bytes, output_path, "png")
                    return {"success": True, "image_path": fpath, "b64": b64,
                            "provider": "replicate", "model": model_id, "error": None}
                elif data["status"] in ("failed", "canceled"):
                    return {"success": False, "error": f"Replicate prediction {data['status']}"}

            return {"success": False, "error": "Replicate prediction timed out"}
        except Exception as e:
            return {"success": False, "error": f"Replicate error: {e}"}

    @staticmethod
    def _save_image(img_bytes: bytes, output_path: str | None, ext: str) -> str:
        if output_path:
            pathlib.Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            pathlib.Path(output_path).write_bytes(img_bytes)
            return output_path
        with tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False) as f:
            f.write(img_bytes)
            return f.name


# ===========================================================================
# Video Generation (Pro-only) — T-CLI-P8
# ===========================================================================


class VideoGenerationTool:
    """
    Pro-only AI video generation tool.
    Supports Runway Gen-3 Alpha and Replicate (MiniMax, Stable Video Diffusion).
    """

    def __init__(self, api_key: str | None = None) -> None:
        self._runway_key = os.environ.get("RUNWAYML_API_SECRET", "")
        self._replicate_key = os.environ.get("REPLICATE_API_TOKEN", "")
        self._fal_key = os.environ.get("FAL_KEY", "")

    def generate(
        self,
        prompt: str,
        image_path: str | None = None,
        output_path: str | None = None,
        model: str = "minimax",
        duration: int = 5,
    ) -> dict[str, Any]:
        """
        Generate a video from a text prompt (and optional image).
        Returns: {success, video_path, provider, model, error}
        """
        if self._fal_key and model in ("minimax", "wan", "fal"):
            result = self._gen_fal_video(prompt, image_path, output_path, model, duration)
            if result.get("success"):
                return result

        if self._replicate_key:
            result = self._gen_replicate_video(prompt, image_path, output_path, model, duration)
            if result.get("success"):
                return result

        if self._runway_key:
            result = self._gen_runway(prompt, image_path, output_path, duration)
            if result.get("success"):
                return result

        return {
            "success": False,
            "error": (
                "No video generation provider available. "
                "Set FAL_KEY, REPLICATE_API_TOKEN, or RUNWAYML_API_SECRET."
            ),
        }

    def _gen_fal_video(
        self,
        prompt: str,
        image_path: str | None,
        output_path: str | None,
        model: str,
        duration: int,
    ) -> dict:
        model_map = {
            "minimax": "fal-ai/minimax-video",
            "wan": "fal-ai/wan/t2v-13b",
            "fal": "fal-ai/fast-animatediff/t2v",
        }
        fal_model = model_map.get(model, "fal-ai/minimax-video")
        payload: dict = {"prompt": prompt, "duration": duration}
        if image_path and pathlib.Path(image_path).exists():
            b64 = base64.b64encode(pathlib.Path(image_path).read_bytes()).decode()
            payload["image_url"] = f"data:image/png;base64,{b64}"

        try:
            resp = httpx.post(
                f"https://fal.run/{fal_model}",
                headers={"Authorization": f"Key {self._fal_key}",
                         "Content-Type": "application/json"},
                json=payload,
                timeout=300,
            )
            resp.raise_for_status()
            data = resp.json()
            video_url = (data.get("video") or {}).get("url") or data.get("video_url", "")
            if not video_url:
                return {"success": False, "error": "fal.ai video: no URL in response"}
            video_bytes = httpx.get(video_url, timeout=120).content
            fpath = self._save_video(video_bytes, output_path)
            return {"success": True, "video_path": fpath, "provider": "fal.ai",
                    "model": fal_model, "error": None}
        except Exception as e:
            return {"success": False, "error": f"fal.ai video error: {e}"}

    def _gen_replicate_video(
        self,
        prompt: str,
        image_path: str | None,
        output_path: str | None,
        model: str,
        duration: int,
    ) -> dict:
        model_id = "minimax/video-01" if "minimax" in model else "stability-ai/stable-video-diffusion"
        inp: dict = {"prompt": prompt}
        if image_path and pathlib.Path(image_path).exists():
            b64 = base64.b64encode(pathlib.Path(image_path).read_bytes()).decode()
            inp["image"] = f"data:image/png;base64,{b64}"

        try:
            import time as _time
            resp = httpx.post(
                f"https://api.replicate.com/v1/models/{model_id}/predictions",
                headers={"Authorization": f"Bearer {self._replicate_key}",
                         "Content-Type": "application/json"},
                json={"input": inp},
                timeout=30,
            )
            resp.raise_for_status()
            prediction_id = resp.json()["id"]
            for _ in range(36):
                _time.sleep(5)
                poll = httpx.get(
                    f"https://api.replicate.com/v1/predictions/{prediction_id}",
                    headers={"Authorization": f"Bearer {self._replicate_key}"},
                    timeout=15,
                )
                data = poll.json()
                if data["status"] == "succeeded":
                    video_url = data["output"] if isinstance(data["output"], str) else data["output"][0]
                    video_bytes = httpx.get(video_url, timeout=120).content
                    fpath = self._save_video(video_bytes, output_path)
                    return {"success": True, "video_path": fpath, "provider": "replicate",
                            "model": model_id, "error": None}
                elif data["status"] in ("failed", "canceled"):
                    return {"success": False, "error": f"Replicate video {data['status']}"}
            return {"success": False, "error": "Replicate video prediction timed out"}
        except Exception as e:
            return {"success": False, "error": f"Replicate video error: {e}"}

    def _gen_runway(
        self,
        prompt: str,
        image_path: str | None,
        output_path: str | None,
        duration: int,
    ) -> dict:
        try:
            payload: dict = {
                "promptText": prompt,
                "model": "gen3a_turbo",
                "duration": min(duration, 10),
                "ratio": "1280:768",
                "watermark": False,
            }
            if image_path and pathlib.Path(image_path).exists():
                b64 = base64.b64encode(pathlib.Path(image_path).read_bytes()).decode()
                payload["promptImage"] = f"data:image/png;base64,{b64}"

            headers = {
                "Authorization": f"Bearer {self._runway_key}",
                "Content-Type": "application/json",
                "X-Runway-Version": "2024-11-06",
            }
            resp = httpx.post(
                "https://api.dev.runwayml.com/v1/image_to_video",
                headers=headers, json=payload, timeout=30,
            )
            resp.raise_for_status()
            task_id = resp.json()["id"]

            import time as _time
            for _ in range(30):
                _time.sleep(10)
                poll = httpx.get(
                    f"https://api.dev.runwayml.com/v1/tasks/{task_id}",
                    headers=headers, timeout=15,
                )
                data = poll.json()
                if data["status"] == "SUCCEEDED":
                    video_url = data["output"][0]
                    video_bytes = httpx.get(video_url, timeout=120).content
                    fpath = self._save_video(video_bytes, output_path)
                    return {"success": True, "video_path": fpath, "provider": "runway",
                            "model": "gen3a_turbo", "error": None}
                elif data["status"] in ("FAILED", "CANCELED"):
                    return {"success": False, "error": f"Runway task {data['status']}"}
            return {"success": False, "error": "Runway task timed out"}
        except Exception as e:
            return {"success": False, "error": f"Runway error: {e}"}

    @staticmethod
    def _save_video(video_bytes: bytes, output_path: str | None) -> str:
        if output_path:
            pathlib.Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            pathlib.Path(output_path).write_bytes(video_bytes)
            return output_path
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            f.write(video_bytes)
            return f.name

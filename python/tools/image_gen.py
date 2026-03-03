"""
image_gen.py — AI image generation tool for Pakalon agents (Pro feature).
Supports: OpenAI DALL-E 3, Stability AI, Replicate, with graceful fallbacks.
T-IMG-01: Pro-only — blocked for free plan users.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import pathlib
import time
from typing import Any

# ---------------------------------------------------------------------------
# Provider constants
# ---------------------------------------------------------------------------

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
STABILITY_API_KEY = os.environ.get("STABILITY_API_KEY", "")
REPLICATE_API_TOKEN = os.environ.get("REPLICATE_API_TOKEN", "")

# Default output directory (relative to project)
DEFAULT_OUTPUT_DIR = ".pakalon/generated-images"

# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class PlanBlockedError(Exception):
    """Raised when a free-plan user tries to use image generation."""


class NoProviderAvailableError(Exception):
    """Raised when no image generation provider is configured."""


# ---------------------------------------------------------------------------
# ImageGenTool
# ---------------------------------------------------------------------------


class ImageGenTool:
    """
    AI image generation tool.

    Pro-only feature — raises PlanBlockedError for free users.

    Provider priority:
      1. OpenAI DALL-E 3  (requires OPENAI_API_KEY)
      2. Stability AI     (requires STABILITY_API_KEY)
      3. Replicate        (requires REPLICATE_API_TOKEN)

    Usage:
        tool = ImageGenTool(user_plan="pro")
        result = tool.generate("A minimalist SaaS dashboard screenshot")
        # result: {"url": ..., "local_path": ..., "provider": ..., "prompt": ...}
    """

    def __init__(
        self,
        user_plan: str = "free",
        output_dir: str = DEFAULT_OUTPUT_DIR,
        project_dir: str = ".",
    ) -> None:
        self.user_plan = user_plan
        self.output_dir = pathlib.Path(project_dir) / output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def generate(
        self,
        prompt: str,
        *,
        size: str = "1024x1024",
        quality: str = "standard",
        style: str = "natural",
        n: int = 1,
        save_local: bool = True,
    ) -> dict[str, Any]:
        """
        Generate an image from a text prompt.

        Args:
            prompt:     Description of the image to generate.
            size:       Image dimensions — "1024x1024", "1792x1024", "1024x1792".
            quality:    "standard" or "hd" (DALL-E 3 only).
            style:      "natural" or "vivid" (DALL-E 3 only).
            n:          Number of images (1 = DALL-E 3 max per request).
            save_local: If True, download and save the image to output_dir.

        Returns:
            dict with keys: url, local_path (if saved), provider, prompt, size, meta.

        Raises:
            PlanBlockedError: if user_plan != "pro".
            NoProviderAvailableError: if no API keys are set.
        """
        if self.user_plan != "pro":
            raise PlanBlockedError(
                "Image generation is a Pro-only feature. "
                "Upgrade at https://pakalon.com/pricing to unlock it."
            )

        # Try providers in priority order
        errors: list[str] = []

        if OPENAI_API_KEY:
            try:
                return self._generate_dalle(prompt, size=size, quality=quality, style=style, save_local=save_local)
            except Exception as e:
                errors.append(f"OpenAI DALL-E: {e}")

        if STABILITY_API_KEY:
            try:
                return self._generate_stability(prompt, size=size, save_local=save_local)
            except Exception as e:
                errors.append(f"Stability AI: {e}")

        if REPLICATE_API_TOKEN:
            try:
                return self._generate_replicate(prompt, size=size, save_local=save_local)
            except Exception as e:
                errors.append(f"Replicate: {e}")

        raise NoProviderAvailableError(
            "No image generation provider is configured. "
            "Set one of: OPENAI_API_KEY, STABILITY_API_KEY, REPLICATE_API_TOKEN. "
            f"Provider errors: {'; '.join(errors)}"
        )

    def generate_variations(
        self,
        image_path: str,
        n: int = 2,
    ) -> list[dict[str, Any]]:
        """
        Generate variations of an existing image (OpenAI only).
        Returns list of result dicts.
        """
        if self.user_plan != "pro":
            raise PlanBlockedError("Image generation is a Pro-only feature.")
        if not OPENAI_API_KEY:
            raise NoProviderAvailableError("Variations require OPENAI_API_KEY.")
        return self._generate_dalle_variations(image_path, n=n)

    # ------------------------------------------------------------------
    # OpenAI DALL-E 3
    # ------------------------------------------------------------------

    def _generate_dalle(
        self,
        prompt: str,
        *,
        size: str = "1024x1024",
        quality: str = "standard",
        style: str = "natural",
        save_local: bool = True,
    ) -> dict[str, Any]:
        try:
            import httpx
        except ImportError:
            raise RuntimeError("httpx not installed — run: pip install httpx")

        # Validate size
        valid_sizes = {"1024x1024", "1792x1024", "1024x1792"}
        if size not in valid_sizes:
            size = "1024x1024"

        payload = {
            "model": "dall-e-3",
            "prompt": prompt,
            "n": 1,
            "size": size,
            "quality": quality,
            "style": style,
            "response_format": "url",
        }

        with httpx.Client(timeout=60) as client:
            resp = client.post(
                "https://api.openai.com/v1/images/generations",
                headers={
                    "Authorization": f"Bearer {OPENAI_API_KEY}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()

        url = data["data"][0]["url"]
        revised_prompt = data["data"][0].get("revised_prompt", prompt)
        local_path: str | None = None

        if save_local and url:
            local_path = self._download_image(url, prompt, provider="dalle3")

        return {
            "url": url,
            "local_path": local_path,
            "provider": "openai/dall-e-3",
            "prompt": revised_prompt,
            "original_prompt": prompt,
            "size": size,
            "quality": quality,
            "style": style,
            "meta": data["data"][0],
        }

    def _generate_dalle_variations(
        self,
        image_path: str,
        n: int = 2,
    ) -> list[dict[str, Any]]:
        try:
            import httpx
        except ImportError:
            raise RuntimeError("httpx not installed — run: pip install httpx")

        with open(image_path, "rb") as f:
            image_bytes = f.read()

        with httpx.Client(timeout=60) as client:
            resp = client.post(
                "https://api.openai.com/v1/images/variations",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                files={"image": (pathlib.Path(image_path).name, image_bytes, "image/png")},
                data={"n": str(n), "size": "1024x1024", "response_format": "url"},
            )
            resp.raise_for_status()
            data = resp.json()

        results = []
        for item in data.get("data", []):
            url = item["url"]
            local_path = self._download_image(url, f"variation-{len(results)}", provider="dalle3-variation")
            results.append({
                "url": url,
                "local_path": local_path,
                "provider": "openai/dall-e-3-variation",
                "prompt": f"variation of {image_path}",
                "meta": item,
            })
        return results

    # ------------------------------------------------------------------
    # Stability AI (SDXL)
    # ------------------------------------------------------------------

    def _generate_stability(
        self,
        prompt: str,
        *,
        size: str = "1024x1024",
        save_local: bool = True,
    ) -> dict[str, Any]:
        try:
            import httpx
        except ImportError:
            raise RuntimeError("httpx not installed — run: pip install httpx")

        # Parse WxH
        parts = size.split("x")
        width = int(parts[0]) if len(parts) == 2 else 1024
        height = int(parts[1]) if len(parts) == 2 else 1024

        # Stability AI v1 REST API
        with httpx.Client(timeout=90) as client:
            resp = client.post(
                "https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image",
                headers={
                    "Authorization": f"Bearer {STABILITY_API_KEY}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                json={
                    "text_prompts": [{"text": prompt, "weight": 1.0}],
                    "cfg_scale": 7,
                    "width": width,
                    "height": height,
                    "steps": 30,
                    "samples": 1,
                },
            )
            resp.raise_for_status()
            data = resp.json()

        artifact = data["artifacts"][0]
        b64 = artifact["base64"]
        img_bytes = base64.b64decode(b64)

        local_path: str | None = None
        if save_local:
            slug = hashlib.md5(prompt.encode()).hexdigest()[:8]
            filename = f"stability_{slug}_{int(time.time())}.png"
            fpath = self.output_dir / filename
            fpath.write_bytes(img_bytes)
            local_path = str(fpath)

        return {
            "url": None,
            "local_path": local_path,
            "provider": "stabilityai/sdxl",
            "prompt": prompt,
            "size": size,
            "meta": {"finish_reason": artifact.get("finishReason"), "seed": artifact.get("seed")},
        }

    # ------------------------------------------------------------------
    # Replicate (FLUX / SDXL)
    # ------------------------------------------------------------------

    def _generate_replicate(
        self,
        prompt: str,
        *,
        size: str = "1024x1024",
        save_local: bool = True,
        model: str = "black-forest-labs/flux-schnell",
    ) -> dict[str, Any]:
        try:
            import httpx
        except ImportError:
            raise RuntimeError("httpx not installed — run: pip install httpx")

        parts = size.split("x")
        width = int(parts[0]) if len(parts) == 2 else 1024
        height = int(parts[1]) if len(parts) == 2 else 1024

        with httpx.Client(timeout=120) as client:
            # Create prediction
            create_resp = client.post(
                f"https://api.replicate.com/v1/models/{model}/predictions",
                headers={
                    "Authorization": f"Token {REPLICATE_API_TOKEN}",
                    "Content-Type": "application/json",
                },
                json={
                    "input": {
                        "prompt": prompt,
                        "width": width,
                        "height": height,
                        "num_outputs": 1,
                    }
                },
            )
            create_resp.raise_for_status()
            prediction = create_resp.json()
            prediction_id = prediction["id"]

            # Poll until complete (max 90s)
            deadline = time.time() + 90
            while time.time() < deadline:
                time.sleep(2)
                poll = client.get(
                    f"https://api.replicate.com/v1/predictions/{prediction_id}",
                    headers={"Authorization": f"Token {REPLICATE_API_TOKEN}"},
                )
                poll.raise_for_status()
                status_data = poll.json()
                status = status_data.get("status")
                if status == "succeeded":
                    output = status_data.get("output", [])
                    url = output[0] if output else None
                    local_path = None
                    if save_local and url:
                        local_path = self._download_image(url, prompt, provider="replicate")
                    return {
                        "url": url,
                        "local_path": local_path,
                        "provider": f"replicate/{model}",
                        "prompt": prompt,
                        "size": size,
                        "meta": status_data,
                    }
                elif status == "failed":
                    raise RuntimeError(f"Replicate prediction failed: {status_data.get('error')}")
                # Still processing — keep polling

        raise RuntimeError("Replicate prediction timed out after 90s")

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _download_image(self, url: str, prompt: str, provider: str = "unknown") -> str:
        """Download an image URL and save it; returns local path."""
        try:
            import httpx
            slug = hashlib.md5(prompt.encode()).hexdigest()[:8]
            ext = ".png"
            if ".jpg" in url or ".jpeg" in url:
                ext = ".jpg"
            elif ".webp" in url:
                ext = ".webp"
            filename = f"{provider}_{slug}_{int(time.time())}{ext}"
            fpath = self.output_dir / filename
            with httpx.Client(timeout=30) as client:
                resp = client.get(url)
                resp.raise_for_status()
                fpath.write_bytes(resp.content)
            return str(fpath)
        except Exception as e:
            return f"<download failed: {e}>"

    @staticmethod
    def list_providers() -> list[dict[str, str]]:
        """Return list of configured providers and their status."""
        return [
            {
                "name": "OpenAI DALL-E 3",
                "env_var": "OPENAI_API_KEY",
                "configured": "yes" if OPENAI_API_KEY else "no",
                "model": "dall-e-3",
            },
            {
                "name": "Stability AI",
                "env_var": "STABILITY_API_KEY",
                "configured": "yes" if STABILITY_API_KEY else "no",
                "model": "sdxl",
            },
            {
                "name": "Replicate",
                "env_var": "REPLICATE_API_TOKEN",
                "configured": "yes" if REPLICATE_API_TOKEN else "no",
                "model": "flux-schnell",
            },
        ]

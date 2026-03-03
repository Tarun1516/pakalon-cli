"""
build_registry.py — Pre-build the UI component registry cache.

Run this once before launching the pipeline to ensure registry RAG has
populated data. Without this, Phase 3 SA2 (Components) will attempt to
scrape all sites in real-time, adding several minutes of latency.

Usage:
    python -m agents.phase3.build_registry
    python -m agents.phase3.build_registry --output /path/to/registry.json
    python -m agents.phase3.build_registry --force

The output is cached to ~/.config/pakalon/registry/registry.json
and will be reused by RegistryRAG.load() automatically.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import pathlib
import sys
import time

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("build_registry")

BRIDGE_URL = os.environ.get("PAKALON_BRIDGE_URL", "http://127.0.0.1:7432")
DEFAULT_OUT = pathlib.Path.home() / ".config" / "pakalon" / "registry" / "registry.json"
CACHE_TTL_HOURS = 24


def _is_cache_fresh(path: pathlib.Path, ttl_hours: int = CACHE_TTL_HOURS) -> bool:
    if not path.exists():
        return False
    age_hours = (time.time() - path.stat().st_mtime) / 3600
    return age_hours < ttl_hours


async def _scrape_site_via_bridge(url: str, timeout: float = 20.0) -> str:
    """Scrape a URL via the Python bridge /scrape endpoint (Firecrawl)."""
    try:
        import httpx
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{BRIDGE_URL}/scrape",
                json={"url": url, "formats": ["markdown"]},
            )
            if resp.status_code == 200:
                data = resp.json()
                return data.get("markdown") or data.get("content") or data.get("text") or ""
    except Exception as e:
        log.debug("Bridge scrape failed for %s: %s", url, e)
    return ""


def _scrape_site_sync(url: str, timeout: float = 15.0) -> str:
    """Sync HTTP fallback scrape — extracts text from HTML."""
    try:
        import httpx
        import re
        resp = httpx.get(url, timeout=timeout, follow_redirects=True,
                         headers={"User-Agent": "Mozilla/5.0 Pakalon-RegistryBuilder/1.0"})
        resp.raise_for_status()
        # Strip script/style tags, then extract visible text
        text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", resp.text, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        return text[:6000]
    except Exception as e:
        log.debug("Sync scrape failed for %s: %s", url, e)
    return ""


def _extract_components_from_text(text: str, site_name: str, site_url: str, tag: str) -> list[dict]:
    """
    Heuristically extract component names from scraped page text.
    Looks for capitalized UI-style nouns (Button, Accordion, DataTable, etc.).
    """
    import re

    components: list[dict] = []
    # Heading patterns: "## Button" or "### Data Table" or "Button\n"
    headings = re.findall(r"(?:#{1,3}|<h[2-4][^>]*>)\s*([A-Z][a-zA-Z\s]{1,28}?)(?:\n|</h[2-4]>|$)", text)
    # Also scan for patterns like "Button •", "CardComponent"
    camel_names = re.findall(r"\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b", text[:3000])

    seen: set[str] = set()
    for raw in headings + camel_names:
        name = raw.strip()
        if not name or name in seen:
            continue
        if len(name) < 3 or len(name) > 35:
            continue
        # Filter out obvious non-component words
        SKIP = {"Introduction", "Overview", "Documentation", "Getting", "Started", "Install",
                 "Usage", "Example", "Examples", "Features", "License", "Contributing",
                 "Table", "Contents", "Related", "Resources", "Further", "Reading"}
        if name in SKIP:
            continue
        seen.add(name)
        components.append({
            "name": f"{site_name}/{name}",
            "description": f"{name} component from {site_name}",
            "docs_url": site_url,
            "tags": [tag, "ui", "component", name.lower().replace(" ", "-")],
            "source": site_name,
        })
        if len(components) >= 30:
            break

    # Ensure at least the library itself is represented
    if not components:
        components.append({
            "name": site_name,
            "description": f"UI component library: {site_name}",
            "docs_url": site_url,
            "tags": [tag, "ui", "component-library"],
            "source": site_name,
        })

    return components


async def build_site(
    site: dict,
    cache_dir: pathlib.Path,
    force: bool = False,
    use_bridge: bool = True,
) -> list[dict]:
    """Build registry entries for a single site."""
    tag = site.get("tag", site["name"].lower())
    cache_file = cache_dir / f"scraped_{tag}.json"

    if not force and _is_cache_fresh(cache_file):
        try:
            cached = json.loads(cache_file.read_text())
            log.info("  [cache] %-25s %d entries", site["name"], len(cached))
            return cached
        except Exception:
            pass

    log.info("  [scrape] %s → %s", site["name"], site["url"])
    text = ""

    if use_bridge:
        text = await _scrape_site_via_bridge(site["url"])

    if not text:
        text = _scrape_site_sync(site["url"])

    components = _extract_components_from_text(text, site["name"], site["url"], tag)
    log.info("  [done]   %-25s %d component(s) found", site["name"], len(components))

    try:
        cache_file.write_text(json.dumps(components, indent=2))
    except Exception as e:
        log.warning("Failed to write cache %s: %s", cache_file, e)

    return components


async def build_registry(
    output: pathlib.Path = DEFAULT_OUT,
    force: bool = False,
    use_bridge: bool = True,
    concurrency: int = 4,
) -> int:
    """
    Scrape all WEB_COMPONENT_SITES and write registry.json.

    Returns total number of component entries written.
    """
    # Import the site list from RegistryRAG
    from .registry_rag import RegistryRAG

    output.parent.mkdir(parents=True, exist_ok=True)
    cache_dir = output.parent

    if not force and _is_cache_fresh(output, ttl_hours=CACHE_TTL_HOURS):
        existing = json.loads(output.read_text())
        log.info("Registry cache is fresh (%d entries). Use --force to rebuild.", len(existing))
        return len(existing)

    sites = RegistryRAG.WEB_COMPONENT_SITES
    log.info("Building registry from %d sites (concurrency=%d)…", len(sites), concurrency)

    all_components: list[dict] = []

    # Also include entries from REGISTRY_SOURCES (shadcn/ui registry.json)
    log.info("Fetching structured registry sources…")
    try:
        import httpx
        for src_url in RegistryRAG.REGISTRY_SOURCES:
            try:
                resp = httpx.get(src_url, timeout=12, follow_redirects=True)
                data = resp.json()
                # Normalize: shadcn registry is a list of {name, type, description, ...}
                items = data if isinstance(data, list) else data.get("items", data.get("components", []))
                for item in items[:200]:
                    if isinstance(item, dict) and item.get("name"):
                        all_components.append({
                            "name": f"shadcn/{item['name']}",
                            "description": item.get("description", f"{item['name']} component"),
                            "docs_url": f"https://ui.shadcn.com/docs/components/{item['name']}",
                            "tags": ["shadcn", "ui", "component"] + list(item.get("tags", [])),
                            "source": "shadcn/ui",
                        })
                log.info("  [registry] %s → %d entries", src_url, len(items))
            except Exception as e:
                log.debug("Registry source failed %s: %s", src_url, e)
    except ImportError:
        log.warning("httpx not installed — skipping structured registry sources")

    # Scrape WEB_COMPONENT_SITES with bounded concurrency
    semaphore = asyncio.Semaphore(concurrency)

    async def guarded_build(site: dict) -> list[dict]:
        async with semaphore:
            return await build_site(site, cache_dir, force=force, use_bridge=use_bridge)

    tasks = [guarded_build(site) for site in sites]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    for result in results:
        if isinstance(result, list):
            all_components.extend(result)
        elif isinstance(result, Exception):
            log.warning("Site scrape error: %s", result)

    # Deduplicate by name
    seen_names: set[str] = set()
    deduped: list[dict] = []
    for comp in all_components:
        key = comp.get("name", "")
        if key not in seen_names:
            seen_names.add(key)
            deduped.append(comp)

    log.info("Writing %d unique components to %s", len(deduped), output)
    output.write_text(json.dumps(deduped, indent=2))

    return len(deduped)


def main() -> int:
    parser = argparse.ArgumentParser(description="Pre-build Pakalon UI component registry cache")
    parser.add_argument(
        "--output", "-o",
        type=pathlib.Path,
        default=DEFAULT_OUT,
        help=f"Output path for registry.json (default: {DEFAULT_OUT})",
    )
    parser.add_argument(
        "--force", "-f",
        action="store_true",
        help="Force rebuild even if cache is fresh",
    )
    parser.add_argument(
        "--no-bridge",
        action="store_true",
        help="Skip Firecrawl bridge, use plain HTTP scraping only",
    )
    parser.add_argument(
        "--concurrency", "-c",
        type=int,
        default=4,
        help="Number of sites to scrape concurrently (default: 4)",
    )
    args = parser.parse_args()

    start = time.perf_counter()
    count = asyncio.run(
        build_registry(
            output=args.output,
            force=args.force,
            use_bridge=not args.no_bridge,
            concurrency=args.concurrency,
        )
    )
    elapsed = time.perf_counter() - start
    log.info("Done. %d components in %.1fs → %s", count, elapsed, args.output)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
seed_rag_corpus.py — Seed the Pakalon RAG corpus with UI component documentation.

Crawls the top 12 component / design-system websites using Firecrawl and
stores the scraped pages in ChromaDB so Phase 3 SA1/SA2 can do
Registry-based Retrieval-Augmented Generation (RAG) when picking
UI components for a project.

Usage:
    python python/scripts/seed_rag_corpus.py [--limit N] [--dry-run]

Environment:
    FIRECRAWL_API_KEY   — required for live crawl (falls back to stub if absent)
    OPENROUTER_API_KEY  — required for text summarisation (optional enrichment)

Output:
    ~/.config/pakalon/chroma/  — persistent ChromaDB store (collection: rag_corpus)
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import sys
import time
from typing import Any

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Component website catalogue
# ---------------------------------------------------------------------------

COMPONENT_SITES: list[dict[str, str]] = [
    {
        "name": "shadcn-ui",
        "url": "https://ui.shadcn.com/docs/components",
        "category": "react-component-library",
        "description": "Shadcn UI — copy-paste React components built on Radix UI + Tailwind CSS",
    },
    {
        "name": "radix-ui",
        "url": "https://www.radix-ui.com/primitives/docs/overview/introduction",
        "category": "react-component-library",
        "description": "Radix UI primitives — unstyled, accessible React components",
    },
    {
        "name": "tailwindcss",
        "url": "https://tailwindcss.com/docs/utility-first",
        "category": "css-framework",
        "description": "Tailwind CSS — utility-first CSS framework",
    },
    {
        "name": "headlessui",
        "url": "https://headlessui.com",
        "category": "react-component-library",
        "description": "Headless UI — unstyled accessible UI components for React + Vue",
    },
    {
        "name": "nextui",
        "url": "https://nextui.org/docs/guide/introduction",
        "category": "react-component-library",
        "description": "NextUI — beautiful, fast and modern React UI library",
    },
    {
        "name": "mantine",
        "url": "https://mantine.dev/getting-started/",
        "category": "react-component-library",
        "description": "Mantine — full-featured React components library",
    },
    {
        "name": "chakra-ui",
        "url": "https://chakra-ui.com/getting-started",
        "category": "react-component-library",
        "description": "Chakra UI — modular and accessible component library for React",
    },
    {
        "name": "daisyui",
        "url": "https://daisyui.com/components/",
        "category": "css-component-library",
        "description": "DaisyUI — Tailwind CSS component library",
    },
    {
        "name": "framer-motion",
        "url": "https://www.framer.com/motion/introduction/",
        "category": "animation-library",
        "description": "Framer Motion — production-ready animation library for React",
    },
    {
        "name": "lucide-icons",
        "url": "https://lucide.dev/guide/",
        "category": "icon-library",
        "description": "Lucide Icons — open source icon library",
    },
    {
        "name": "tanstack-table",
        "url": "https://tanstack.com/table/latest/docs/overview",
        "category": "data-grid",
        "description": "TanStack Table — headless UI for building tables and datagrids",
    },
    {
        "name": "react-hook-form",
        "url": "https://react-hook-form.com/get-started",
        "category": "form-library",
        "description": "React Hook Form — performant forms with easy validation",
    },
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _doc_id(url: str) -> str:
    """Stable, URL-derived document ID for upsert idempotency."""
    return "rag_" + hashlib.sha256(url.encode()).hexdigest()[:32]


def _scrape_with_firecrawl(url: str, fc: Any | None, dry_run: bool) -> str | None:
    """Scrape *url* using Firecrawl; return markdown text or None on failure."""
    if dry_run:
        return f"[DRY RUN] Scraped content for {url}"
    if fc is None:
        log.warning("  Firecrawl unavailable — skipping %s", url)
        return None
    try:
        content = fc.scrape(url)
        return content[:8000] if content else None
    except Exception as exc:
        log.warning("  Firecrawl error for %s: %s", url, exc)
        return None


def _build_document(site: dict[str, str], scraped: str) -> str:
    """Build the document string to store in ChromaDB."""
    return (
        f"# {site['name']} — {site['description']}\n"
        f"URL: {site['url']}\n"
        f"Category: {site['category']}\n\n"
        f"{scraped}"
    )


# ---------------------------------------------------------------------------
# Main seed function
# ---------------------------------------------------------------------------

async def seed(limit: int = 0, dry_run: bool = False) -> None:
    """Crawl component sites and seed ChromaDB collection `rag_corpus`."""

    # Import ChromaClient
    try:
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
        from python.memory.chroma_client import ChromaClient  # type: ignore
    except ImportError:
        try:
            from memory.chroma_client import ChromaClient  # type: ignore
        except ImportError:
            log.error("Cannot import ChromaClient — run from pakalon-cli root or install dependencies.")
            return

    # Import Firecrawl tool
    fc = None
    try:
        from python.tools.firecrawl import FirecrawlTool  # type: ignore
        fc = FirecrawlTool()
        log.info("Firecrawl ready.")
    except Exception as exc:
        log.warning("Firecrawl unavailable (%s) — docs will contain placeholder text.", exc)

    chroma = ChromaClient("rag_corpus")
    sites = COMPONENT_SITES[:limit] if limit > 0 else COMPONENT_SITES

    log.info("Seeding RAG corpus with %d component sites…", len(sites))

    success = 0
    failures = 0

    for site in sites:
        log.info("  Processing %s (%s)…", site["name"], site["url"])
        scraped = await asyncio.to_thread(_scrape_with_firecrawl, site["url"], fc, dry_run)
        if scraped is None:
            failures += 1
            continue

        doc = _build_document(site, scraped)
        doc_id = _doc_id(site["url"])
        metadata: dict[str, str] = {
            "name": site["name"],
            "url": site["url"],
            "category": site["category"],
            "description": site["description"],
            "seeded_at": str(int(time.time())),
        }

        ok = chroma.upsert(doc_id=doc_id, document=doc, metadata=metadata)
        if ok:
            log.info("  ✓ %s → ChromaDB (id=%s…)", site["name"], doc_id[:16])
            success += 1
        else:
            log.warning("  ✗ %s — ChromaDB upsert failed", site["name"])
            failures += 1

        # Polite crawl delay
        if not dry_run:
            await asyncio.sleep(1.5)

    log.info(
        "\nDone. %d/%d sites seeded successfully%s.",
        success,
        len(sites),
        " (dry run)" if dry_run else "",
    )
    if failures > 0:
        log.warning("%d site(s) failed — re-run to retry.", failures)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Seed Pakalon RAG corpus from component websites.")
    parser.add_argument("--limit", type=int, default=0, help="Limit to first N sites (0 = all)")
    parser.add_argument("--dry-run", action="store_true", help="Skip actual HTTP crawling")
    args = parser.parse_args()

    asyncio.run(seed(limit=args.limit, dry_run=args.dry_run))


if __name__ == "__main__":
    main()

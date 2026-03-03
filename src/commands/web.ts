/**
 * /web command — analyze a website's design and inject it as context.
 * Calls Firecrawl via the Python bridge to scrape real page content.
 */
import { debugLog } from "@/utils/logger.js";
import { useStore } from "@/store/index.js";

const BRIDGE_URL = process.env.PAKALON_BRIDGE_URL ?? "http://127.0.0.1:7432";

/**
 * Build a web analysis prompt using the URL.
 */
export function getWebAnalysisPrompt(url: string, scrapedContent?: string): string {
  const contentBlock = scrapedContent
    ? `\n\n<scraped_content>\n${scrapedContent.slice(0, 8000)}\n</scraped_content>\n`
    : "";

  return `Analyze the design and UX of the website at: ${url}${contentBlock}

Based on the scraped content above (or if unavailable, by examining the URL), extract:
1. **Color Palette** — primary, secondary, background, text colors (exact hex/oklch values)
2. **Typography** — font families, sizes, weights for headings, body, code
3. **Layout** — grid system, spacing scale, max widths, responsive breakpoints
4. **Components** — identified UI components (nav, hero, cards, buttons, forms, footer)
5. **Design System** — any identifiable patterns or frameworks (Tailwind, Material, etc.)
6. **User Flow** — key interactions and page transitions
7. **Unique Features** — standout design choices worth replicating

Format your response as a structured design spec directly usable for building a similar interface.`;
}

export async function cmdWebAnalyze(url: string): Promise<string> {
  debugLog(`[web] Analyzing: ${url}`);

  // 1. Try Firecrawl via bridge
  try {
    const { token } = useStore.getState();
    const res = await fetch(`${BRIDGE_URL}/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ url, formats: ["markdown", "html"] }),
      signal: AbortSignal.timeout(30_000),
    });

    if (res.ok) {
      const data = await res.json() as { success: boolean; markdown?: string; html?: string; error?: string };
      if (data.success && (data.markdown || data.html)) {
        const content = data.markdown ?? data.html ?? "";
        debugLog(`[web] Firecrawl scraped ${content.length} chars`);
        return getWebAnalysisPrompt(url, content);
      }
      debugLog(`[web] Bridge scrape returned no content: ${data.error ?? "unknown"}`);
    } else {
      debugLog(`[web] Bridge scrape HTTP ${res.status}`);
    }
  } catch (err) {
    debugLog(`[web] Bridge unavailable or scrape failed: ${err}`);
  }

  // 2. Fallback: return static analysis prompt
  return getWebAnalysisPrompt(url);
}

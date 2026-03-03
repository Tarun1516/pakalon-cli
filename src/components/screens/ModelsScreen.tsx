/**
 * ModelsScreen.tsx — Full interactive TUI for /models command.
 * Ink SelectInput-based browsable model list with sorting and plan badges.
 */
import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { getApiClient } from "@/api/client.js";
import { useStore } from "@/store/index.js";
import { debugLog } from "@/utils/logger.js";

interface ModelItem {
  model_id: string;
  name: string;
  context_window: number;
  pricing_tier: "free" | "pro";
  remaining_pct?: number;
  provider?: string;
}

type SortKey = "context" | "name" | "tier";

function ctxLabel(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return `${n}`;
}

function tierBadge(tier: string): string {
  return tier === "pro" ? "[PRO]" : "[FREE]";
}

function tierColor(tier: string): string {
  return tier === "pro" ? "yellow" : "green";
}

function remainingBar(pct: number): string {
  const filled = Math.round(pct / 10);
  const empty = 10 - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

interface ModelRowProps {
  model: ModelItem;
  isSelected: boolean;
  index: number;
}

const ModelRow: React.FC<ModelRowProps> = ({ model, isSelected, index }) => {
  const bg = isSelected ? "blue" : undefined;
  const prefix = isSelected ? "❯ " : "  ";
  const pct = model.remaining_pct ?? 100;
  const barColor = pct < 15 ? "red" : pct < 40 ? "yellow" : "green";

  return (
    <Box flexDirection="row" backgroundColor={bg as never}>
      <Text color={isSelected ? "white" : "gray"}>{prefix}</Text>
      <Text color={tierColor(model.pricing_tier)} bold={model.pricing_tier === "pro"} dimColor={!isSelected}>
        {tierBadge(model.pricing_tier)}{" "}
      </Text>
      <Text color={isSelected ? "white" : undefined} bold={isSelected}>
        {model.name.padEnd(45)}
      </Text>
      <Text dimColor> {ctxLabel(model.context_window).padStart(6)}</Text>
      <Text color={barColor} dimColor={!isSelected}>
        {" "}[{remainingBar(pct)}] {pct}%
      </Text>
    </Box>
  );
};

interface ModelsScreenProps {
  onSelect?: (modelId: string) => void;
  onBack?: () => void;
}

const ModelsScreen: React.FC<ModelsScreenProps> = ({ onSelect, onBack }) => {
  const { exit } = useApp();
  const setSelectedModel = useStore((s) => s.setSelectedModel);

  const [models, setModels] = useState<ModelItem[]>([]);
  const [filtered, setFiltered] = useState<ModelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("context");
  const [filterTier, setFilterTier] = useState<"all" | "free" | "pro">("all");
  const [query, setQuery] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Fetch models on mount
  useEffect(() => {
    let cancelled = false;
    const api = getApiClient();
    api
      .get<ModelItem[]>("/models")
      .then(({ data }) => {
        if (cancelled) return;
        // Insert "auto" at top
        const autoEntry: ModelItem = {
          model_id: "auto",
          name: "auto (recommended for your plan)",
          context_window: 0,
          pricing_tier: "free",
          remaining_pct: 100,
        };
        const list = [autoEntry, ...data];
        setModels(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          debugLog("ModelsScreen fetch error", err);
          setError(String((err as {message?: string})?.message ?? err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Apply filter + sort
  useEffect(() => {
    let list = [...models];

    if (filterTier !== "all") {
      list = list.filter((m) => m.model_id === "auto" || m.pricing_tier === filterTier);
    }

    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (m) => m.name.toLowerCase().includes(q) || m.model_id.toLowerCase().includes(q)
      );
    }

    list.sort((a, b) => {
      if (a.model_id === "auto") return -1;
      if (b.model_id === "auto") return 1;
      if (sortKey === "context") return b.context_window - a.context_window;
      if (sortKey === "name") return a.name.localeCompare(b.name);
      if (sortKey === "tier") {
        if (a.pricing_tier === b.pricing_tier) return a.name.localeCompare(b.name);
        return a.pricing_tier === "free" ? -1 : 1;
      }
      return 0;
    });

    setFiltered(list);
    setSelectedIdx(0);
  }, [models, sortKey, filterTier, query]);

  const handleConfirm = useCallback(() => {
    const model = filtered[selectedIdx];
    if (!model) return;

    setSelectedModel(model.model_id);
    setStatusMsg(`✓ Model set to: ${model.name}`);
    setConfirmed(true);

    if (onSelect) {
      onSelect(model.model_id);
    } else {
      setTimeout(() => exit(), 800);
    }
  }, [filtered, selectedIdx, setSelectedModel, onSelect, exit]);

  useInput((input, key) => {
    if (confirmed) return;

    if (key.upArrow) {
      setSelectedIdx((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelectedIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (key.return) {
      handleConfirm();
    } else if (key.escape || (key.ctrl && input === "c")) {
      if (onBack) onBack();
      else exit();
    } else if (input === "s") {
      setSortKey((k) => {
        const keys: SortKey[] = ["context", "name", "tier"];
        return keys[(keys.indexOf(k) + 1) % keys.length]!;
      });
    } else if (input === "f") {
      setFilterTier((t) => {
        const tiers: Array<"all" | "free" | "pro"> = ["all", "free", "pro"];
        return tiers[(tiers.indexOf(t) + 1) % tiers.length]!;
      });
    } else if (input === "/" || (key.ctrl && input === "f")) {
      // Search mode — type query
      // For simplicity, handled in text typing below
    } else if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
    } else if (input && input.length === 1 && !key.ctrl && !key.meta) {
      setQuery((q) => q + input);
    }
  });

  // Viewport: show 20 rows, scrolled to selectedIdx
  const VIEWPORT = 20;
  const viewStart = Math.max(0, Math.min(selectedIdx - Math.floor(VIEWPORT / 2), filtered.length - VIEWPORT));
  const viewEnd = Math.min(filtered.length, viewStart + VIEWPORT);
  const visibleModels = filtered.slice(viewStart, viewEnd);

  if (loading) {
    return (
      <Box flexDirection="column">
        <Text color="cyan">⟳ Loading models...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ Failed to load models: {error}</Text>
        <Text dimColor>Press Esc to go back</Text>
      </Box>
    );
  }

  if (confirmed && statusMsg) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color="green" bold>{statusMsg}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box
        flexDirection="row"
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        marginBottom={0}
      >
        <Text bold color="cyan">
          MODELS
        </Text>
        <Text dimColor>  {filtered.length} available</Text>
        <Box flexGrow={1} />
        <Text dimColor>
          Sort: <Text color="yellow">{sortKey}</Text>  Filter:{" "}
          <Text color="yellow">{filterTier}</Text>
        </Text>
      </Box>

      {/* Search bar */}
      <Box paddingX={1} marginBottom={0}>
        <Text dimColor>Search: </Text>
        <Text color="white">{query}</Text>
        <Text color="cyan">█</Text>
      </Box>

      {/* Column headers */}
      <Box flexDirection="row" paddingX={1}>
        <Text dimColor>{"  TIER  NAME".padEnd(55)}</Text>
        <Text dimColor>CTX</Text>
        <Text dimColor>   REMAINING</Text>
      </Box>

      {/* Model list */}
      <Box flexDirection="column">
        {visibleModels.map((model, i) => (
          <ModelRow
            key={model.model_id}
            model={model}
            isSelected={viewStart + i === selectedIdx}
            index={viewStart + i}
          />
        ))}
        {filtered.length === 0 && (
          <Box paddingX={2}>
            <Text dimColor>No models match your search.</Text>
          </Box>
        )}
      </Box>

      {/* Scroll indicator */}
      {filtered.length > VIEWPORT && (
        <Box paddingX={1}>
          <Text dimColor>
            {viewStart + 1}–{viewEnd} of {filtered.length}
          </Text>
        </Box>
      )}

      {/* Controls */}
      <Box
        flexDirection="row"
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        marginTop={0}
      >
        <Text dimColor>↑↓</Text>
        <Text> navigate  </Text>
        <Text dimColor>Enter</Text>
        <Text> select  </Text>
        <Text dimColor>s</Text>
        <Text> sort  </Text>
        <Text dimColor>f</Text>
        <Text> filter  </Text>
        <Text dimColor>type</Text>
        <Text> search  </Text>
        <Text dimColor>Esc</Text>
        <Text> back</Text>
      </Box>
    </Box>
  );
};

export default ModelsScreen;

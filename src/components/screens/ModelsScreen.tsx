/**
 * ModelsScreen.tsx — Full interactive TUI for /models command.
 * Ink SelectInput-based browsable model list with sorting and plan badges.
 */
import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { getApiClient } from "@/api/client.js";
import { useStore } from "@/store/index.js";
import { debugLog } from "@/utils/logger.js";

const PAKALON_ACCENT_COLOR = "#ff8c00"; // vibrant orange

interface ModelItem {
  id?: string;
  model_id?: string;
  name: string;
  context_length?: number;
  context_window?: number;
  tier?: "free" | "paid" | string;
  pricing_tier?: "free" | "pro" | string;
  remaining_pct?: number;
  provider?: string;
}

function normalizeModel(model: ModelItem): ModelItem {
  return {
    ...model,
    id: model.id ?? model.model_id ?? "",
    context_length: model.context_length ?? model.context_window ?? 0,
    tier: model.tier ?? (model.pricing_tier === "free" ? "free" : "paid"),
  };
}

type SortKey = "context" | "name" | "tier";

function ctxLabel(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return `${n}`;
}

function tierBadge(tier: string): string {
  return tier === "free" ? "[FREE]" : "[PRO]";
}

function tierColor(tier: string): string {
  return tier === "free" ? "#ff8c00" : "yellow";
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
  const prefix = isSelected ? "➜ " : "  ";
  const pct = model.remaining_pct ?? 100;
  const barColor = pct < 15 ? "red" : pct < 40 ? "yellow" : "#ff8c00";

  return (
    <Box flexDirection="row">
      <Text color={isSelected ? PAKALON_ACCENT_COLOR : "gray"}>{prefix}</Text>
      <Text color={tierColor(model.tier ?? "paid")} bold={model.tier !== "free"} dimColor={!isSelected}>
        {tierBadge(model.tier ?? "paid")}{" "}
      </Text>
      <Text color={isSelected ? PAKALON_ACCENT_COLOR : undefined} bold={isSelected}>
        {model.name.padEnd(45)}
      </Text>
      <Text dimColor> {ctxLabel(model.context_length ?? 0).padStart(6)}</Text>
      <Text color={isSelected ? PAKALON_ACCENT_COLOR : barColor} dimColor={!isSelected}>
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
  const selectedModel = useStore((s) => s.selectedModel);

  const [models, setModels] = useState<ModelItem[]>([]);
  const [filtered, setFiltered] = useState<ModelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("context");
  const [filterTier, setFilterTier] = useState<"all" | "free" | "paid">("all");
  const [query, setQuery] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Fetch models on mount
  useEffect(() => {
    let cancelled = false;
    const api = getApiClient();
    const loadModels = async () => {
      const initial = await api.get<{ models: ModelItem[] }>("/models?include_all=true");
      const list = (initial.data.models ?? []).map(normalizeModel).filter((model) => Boolean(model.id));

      if (cancelled) return;
      setModels(list);
    };

    loadModels()
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
      list = list.filter((m) => m.id === "auto" || m.tier === filterTier);
    }

    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (m) => m.name.toLowerCase().includes(q) || (m.id ?? "").toLowerCase().includes(q)
      );
    }

    list.sort((a, b) => {
      if (a.id === "auto") return -1;
      if (b.id === "auto") return 1;
      if (sortKey === "context") return (b.context_length ?? 0) - (a.context_length ?? 0);
      if (sortKey === "name") return a.name.localeCompare(b.name);
      if (sortKey === "tier") {
        if (a.tier === b.tier) return a.name.localeCompare(b.name);
        return a.tier === "free" ? -1 : 1;
      }
      return 0;
    });

    setFiltered(list);

    const currentIndex = list.findIndex((model) => model.id === selectedModel);
    setSelectedIdx(currentIndex >= 0 ? currentIndex : 0);
  }, [models, query, selectedModel, sortKey, filterTier]);

  const handleConfirm = useCallback(() => {
    const model = filtered[selectedIdx];
    if (!model) return;

    setSelectedModel(model.id!);
    setStatusMsg(`✓ Model set to: ${model.name}`);
    setConfirmed(true);

    if (onSelect) {
      onSelect(model.id!);
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
        const tiers: Array<"all" | "free" | "paid"> = ["all", "free", "paid"];
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
        <Text color="#ff8c00">⟳ Loading models...</Text>
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
        <Text color="#ff8c00" bold>{statusMsg}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box
        flexDirection="row"
        borderStyle="round"
        borderColor="#ff8c00"
        paddingX={1}
        marginBottom={0}
      >
        <Text bold color="#ff8c00">
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
        <Text color={PAKALON_ACCENT_COLOR}>█</Text>
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
            key={model.id}
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

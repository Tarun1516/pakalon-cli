/**
 * SkillsMarketplaceScreen — Interactive TUI overlay for browsing and
 * installing Pakalon skills/plugins from the marketplace.
 *
 * Activated by `/plugins marketplace` or `/plugins search <query>` in chat.
 * Press Enter to install/uninstall a plugin, Escape/q to close.
 */
import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import {
  discoverMarketplace,
  cmdInstallPlugin,
  cmdRemovePlugin,
  cmdCheckUpdates,
  cmdAutoUpdate,
  type MarketplacePlugin,
} from "@/commands/plugins.js";

interface SkillsMarketplaceScreenProps {
  /** Initial search query (optional) */
  query?: string;
  /** Called when the user dismisses the overlay */
  onClose: (message?: string) => void;
}

type ActionState = "idle" | "loading" | "installing" | "removing" | "done" | "error";

const SkillsMarketplaceScreen: React.FC<SkillsMarketplaceScreenProps> = ({
  query: initialQuery = "",
  onClose,
}) => {
  const [query, setQuery] = useState(initialQuery);
  const [plugins, setPlugins] = useState<MarketplacePlugin[]>([]);
  const [actionState, setActionState] = useState<ActionState>("loading");
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchMode, setSearchMode] = useState(false);
  const [searchInput, setSearchInput] = useState(initialQuery);

  // Fetch marketplace data
  const fetchPlugins = useCallback(async (q: string) => {
    setActionState("loading");
    setStatusMsg("Searching marketplace…");
    try {
      const results = await discoverMarketplace(q || undefined, 30);
      setPlugins(results);
      setSelectedIndex(0);
      setStatusMsg(results.length ? `${results.length} plugin(s) found` : "No plugins found");
      setActionState("idle");
    } catch (err: any) {
      setStatusMsg(`Error: ${err?.message ?? "fetch failed"}`);
      setActionState("error");
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchPlugins(initialQuery);
  }, [fetchPlugins, initialQuery]);

  // Keyboard handling
  useInput((input, key) => {
    // Search mode — collect characters
    if (searchMode) {
      if (key.escape) {
        setSearchMode(false);
        return;
      }
      if (key.return) {
        setSearchMode(false);
        setQuery(searchInput);
        fetchPlugins(searchInput);
        return;
      }
      if (key.backspace || key.delete) {
        setSearchInput((s) => s.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setSearchInput((s) => s + input);
        return;
      }
      return;
    }

    // Normal mode
    if (key.escape || input === "q") {
      onClose();
      return;
    }

    if (input === "/") {
      setSearchMode(true);
      setSearchInput("");
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(plugins.length - 1, i + 1));
      return;
    }

    if (key.return && plugins.length > 0) {
      const plugin = plugins[selectedIndex];
      if (!plugin) return;
      void handleToggle(plugin);
    }

    if (input === "u" && plugins.length > 0) {
      const plugin = plugins[selectedIndex];
      if (plugin?.installed) void handleUpdate(plugin);
    }

    if (input === "r") {
      fetchPlugins(query);
    }
  });

  const handleToggle = async (plugin: MarketplacePlugin) => {
    if (actionState === "installing" || actionState === "removing") return;

    if (plugin.installed) {
      setActionState("removing");
      setStatusMsg(`Removing ${plugin.name}…`);
      try {
        await cmdRemovePlugin(plugin.name);
        setPlugins((prev) =>
          prev.map((p) => (p.name === plugin.name ? { ...p, installed: false } : p))
        );
        setStatusMsg(`✓ ${plugin.name} removed`);
      } catch (err: any) {
        setStatusMsg(`✗ Remove failed: ${err?.message}`);
      }
    } else {
      setActionState("installing");
      setStatusMsg(`Installing ${plugin.name}…`);
      try {
        await cmdInstallPlugin(plugin.name);
        setPlugins((prev) =>
          prev.map((p) => (p.name === plugin.name ? { ...p, installed: true } : p))
        );
        setStatusMsg(`✓ ${plugin.name} installed`);
      } catch (err: any) {
        setStatusMsg(`✗ Install failed: ${err?.message}`);
      }
    }
    setActionState("idle");
  };

  const handleUpdate = async (plugin: MarketplacePlugin) => {
    if (actionState !== "idle") return;
    setActionState("installing");
    setStatusMsg(`Updating ${plugin.name}…`);
    try {
      await cmdAutoUpdate(plugin.name);
      setStatusMsg(`✓ ${plugin.name} updated`);
    } catch (err: any) {
      setStatusMsg(`✗ Update failed: ${err?.message}`);
    }
    setActionState("idle");
    // Refresh list
    await fetchPlugins(query);
  };

  const isBusy = actionState === "installing" || actionState === "removing" || actionState === "loading";

  const actionColor = (state: ActionState): string => {
    if (state === "loading") return "yellow";
    if (state === "error") return "red";
    if (state === "installing" || state === "removing") return "cyan";
    return "green";
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={0}
    >
      {/* Header */}
      <Box flexDirection="row" justifyContent="space-between" marginBottom={0}>
        <Text bold color="cyan">
          {"  Pakalon Skills Marketplace  "}
        </Text>
        <Text dimColor>{"  [Esc/q] close  [/] search  [Enter] install/remove  [u] update  [r] refresh"}</Text>
      </Box>

      {/* Search input */}
      {searchMode ? (
        <Box marginBottom={1}>
          <Text color="yellow" bold>{"Search: "}</Text>
          <Text>{searchInput}</Text>
          <Text dimColor>{"█"}</Text>
        </Box>
      ) : query ? (
        <Box marginBottom={1}>
          <Text dimColor>{"Filter: "}</Text>
          <Text color="yellow">{query}</Text>
          <Text dimColor>{"  (press / to change)"}</Text>
        </Box>
      ) : null}

      {/* Status bar */}
      <Box marginBottom={1}>
        <Text color={actionColor(actionState)}>
          {isBusy ? "⟳ " : ""}
          {statusMsg}
        </Text>
      </Box>

      {/* Plugin list */}
      {plugins.length === 0 && !isBusy ? (
        <Box>
          <Text dimColor>{"No plugins found. Try /search <query> or press r to refresh."}</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {plugins.map((plugin, idx) => {
            const isSel = idx === selectedIndex;
            const instColor = plugin.installed ? "green" : "gray";
            const instLabel = plugin.installed ? "[installed]" : "[available]";
            const selPrefix = isSel ? "> " : "  ";
            const selColor = isSel ? "cyan" : "white";

            return (
              <Box key={plugin.name} flexDirection="row" paddingY={0}>
                <Box minWidth={2}>
                  <Text color={isSel ? "cyan" : "gray"} bold={isSel}>
                    {selPrefix}
                  </Text>
                </Box>
                <Box minWidth={38}>
                  <Text color={selColor} bold={isSel}>
                    {plugin.name}
                  </Text>
                </Box>
                <Box minWidth={10}>
                  <Text dimColor>{`v${plugin.version ?? "latest"}`}</Text>
                </Box>
                <Box minWidth={14}>
                  <Text color={instColor}>{instLabel}</Text>
                </Box>
                <Box flexGrow={1}>
                  <Text dimColor wrap="truncate">
                    {plugin.description?.slice(0, 60) ?? ""}
                  </Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Footer hint for selected plugin */}
      {plugins[selectedIndex] ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>
            {"── "}
            <Text bold color="white">{plugins[selectedIndex].name}</Text>
            {" ── "}
            {(plugins[selectedIndex].description ?? "").slice(0, 100)}
          </Text>
          {plugins[selectedIndex].keywords?.length ? (
            <Text dimColor>{"Keywords: " + plugins[selectedIndex].keywords!.join(", ")}</Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
};

export default SkillsMarketplaceScreen;

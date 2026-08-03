import { useCallback, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react-native";

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { FetchRecentProviderSessionEntry } from "@getpaseo/client/internal/daemon-client";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import {
  PER_PROVIDER_LIMIT,
  aggregateSessionEntries,
  getSessionTitle,
  getPromptPreview,
  requiresImportSessionsHostUpgrade,
  resolveProvidersToFetch,
} from "@/components/import-session-sheet-view-model";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { formatTimeAgo } from "@/utils/time";
import { getProviderIcon } from "@/components/provider-icons";
import { PI_LIVE_UI } from "@/composer/pi-live-feature-flag";

type SessionListClient = Pick<
  DaemonClient,
  | "fetchRecentProviderSessions"
  | "importAgent"
  | "updateProviderSessionMeta"
  | "forkProviderSession"
  | "launchHeadlessProviderSession"
> &
  Partial<Pick<DaemonClient, "attachLiveAgent">>;

export interface PiSessionListProps {
  serverId: string | null;
  client: SessionListClient | null;
  cwd?: string | null;
  workspaceId?: string | null;
  /** When true, show all sessions across all cwds (scanEnabled). */
  scanAll?: boolean;
  /** Compact mode (home screen inline vs sheet). */
  compact?: boolean;
  onImportedAgent?: (agent: { id: string; cwd: string }) => void;
  testID?: string;
}

export function PiSessionList({
  serverId,
  client,
  cwd,
  workspaceId,
  scanAll = true,
  compact: _compact = false,
  onImportedAgent,
  testID,
}: PiSessionListProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { config: daemonConfig } = useDaemonConfig(serverId);
  const scanAllSessions = scanAll || daemonConfig?.piSessionDiscovery?.scanEnabled === true;

  const { entries: snapshotEntries, supportsSnapshot } = useProvidersSnapshot(serverId, {
    cwd,
    enabled: true,
  });
  const supportsWorkspaceTarget = useHostFeature(serverId, "importSessionWorkspaceTarget");
  const requiresHostUpgrade = requiresImportSessionsHostUpgrade({
    supportsSnapshot,
    workspaceId,
    supportsWorkspaceTarget,
  });

  const providersToFetch = useMemo(
    () => (requiresHostUpgrade ? null : resolveProvidersToFetch(supportsSnapshot, snapshotEntries)),
    [requiresHostUpgrade, supportsSnapshot, snapshotEntries],
  );

  const sessionsQueryRoot = useMemo(
    () => ["recent-provider-sessions", cwd ?? null, scanAllSessions ? "all" : "cwd"] as const,
    [cwd, scanAllSessions],
  );

  const queriesConfig = useMemo(() => {
    if (providersToFetch === null) return [];
    return providersToFetch.map((provider) => ({
      queryKey: [...sessionsQueryRoot, provider],
      enabled: true,
      queryFn: async () => {
        if (!client) {
          throw new Error(t("workspace.terminal.hostDisconnected"));
        }
        return await client.fetchRecentProviderSessions({
          ...(cwd && !scanAllSessions ? { cwd } : {}),
          providers: [provider],
          limit: PER_PROVIDER_LIMIT,
        });
      },
    }));
  }, [providersToFetch, sessionsQueryRoot, client, cwd, scanAllSessions, t]);

  const queries = useQueries({ queries: queriesConfig });
  const aggregatedEntries = useMemo(() => aggregateSessionEntries(queries), [queries]);

  const [search, setSearch] = useState("");
  const [renamingEntry, setRenamingEntry] = useState<FetchRecentProviderSessionEntry | null>(null);

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return aggregatedEntries;
    return aggregatedEntries.filter((e) => {
      const title = getSessionTitle(e).toLowerCase();
      const preview = getPromptPreview(e).toLowerCase();
      const cwdMatch = e.cwd?.toLowerCase().includes(q) ?? false;
      return title.includes(q) || preview.includes(q) || cwdMatch;
    });
  }, [aggregatedEntries, search]);

  const _isRefreshing = queries.some((q) => q.isFetching);
  const handleRefresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["recent-provider-sessions"] });
  }, [queryClient]);

  const importMutation = useMutation({
    mutationFn: async (entry: FetchRecentProviderSessionEntry) => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      if (!entry.cwd) throw new Error("Session missing cwd");
      const agent =
        entry.isLiveAttachable && client.attachLiveAgent
          ? await client.attachLiveAgent({
              providerId: entry.providerId,
              providerHandleId: entry.providerHandleId,
              cwd: entry.cwd,
              ...(workspaceId ? { workspaceId } : {}),
            })
          : await client.importAgent({
              providerId: entry.providerId,
              providerHandleId: entry.providerHandleId,
              cwd: entry.cwd,
              ...(workspaceId ? { workspaceId } : {}),
            });
      return agent;
    },
    onSuccess: (agent) => {
      void queryClient.invalidateQueries({ queryKey: ["recent-provider-sessions"] });
      onImportedAgent?.({ id: agent.id, cwd: agent.cwd });
    },
  });

  const pinMutation = useMutation({
    mutationFn: async (input: { entry: FetchRecentProviderSessionEntry; pinned: boolean }) => {
      if (!client?.updateProviderSessionMeta)
        throw new Error(t("workspace.terminal.hostDisconnected"));
      return client.updateProviderSessionMeta({
        provider: input.entry.providerId,
        providerHandleId: input.entry.providerHandleId,
        meta: { pinned: input.pinned },
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["recent-provider-sessions"] });
    },
  });

  const forkMutation = useMutation({
    mutationFn: async (entry: FetchRecentProviderSessionEntry) => {
      if (!client?.forkProviderSession) throw new Error(t("workspace.terminal.hostDisconnected"));
      return client.forkProviderSession({
        provider: entry.providerId,
        providerHandleId: entry.providerHandleId,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["recent-provider-sessions"] });
    },
  });

  const launchMutation = useMutation({
    mutationFn: async (entry: FetchRecentProviderSessionEntry) => {
      if (!client?.launchHeadlessProviderSession)
        throw new Error(t("workspace.terminal.hostDisconnected"));
      return client.launchHeadlessProviderSession({
        provider: entry.providerId,
        providerHandleId: entry.providerHandleId,
        cwd: entry.cwd,
      });
    },
    onSuccess: (payload) => {
      Alert.alert(
        t("importSession.row.launchTitle"),
        `${t("importSession.row.launchBody")}\n\ncd ${payload.cwd}\n${payload.resumeCommand}`,
      );
    },
  });

  const renameMutation = useMutation({
    mutationFn: async (input: { entry: FetchRecentProviderSessionEntry; value: string }) => {
      if (!client?.updateProviderSessionMeta)
        throw new Error(t("workspace.terminal.hostDisconnected"));
      return client.updateProviderSessionMeta({
        provider: input.entry.providerId,
        providerHandleId: input.entry.providerHandleId,
        meta: { displayName: input.value },
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["recent-provider-sessions"] });
    },
  });

  const handleOpen = useCallback(
    (e: FetchRecentProviderSessionEntry) => importMutation.mutate(e),
    [importMutation],
  );
  const handleTogglePin = useCallback(
    (e: FetchRecentProviderSessionEntry) =>
      pinMutation.mutate({ entry: e, pinned: !e.meta?.pinned }),
    [pinMutation],
  );
  const handleFork = useCallback(
    (e: FetchRecentProviderSessionEntry) => forkMutation.mutate(e),
    [forkMutation],
  );
  const handleRename = useCallback((e: FetchRecentProviderSessionEntry) => setRenamingEntry(e), []);
  const handleLaunch = useCallback(
    (e: FetchRecentProviderSessionEntry) => launchMutation.mutate(e),
    [launchMutation],
  );

  const handleRenameSubmit = useCallback(
    async (value: string) => {
      if (!renamingEntry) return;
      await renameMutation.mutateAsync({ entry: renamingEntry, value });
    },
    [renamingEntry, renameMutation],
  );

  const handleRenameClose = useCallback(() => setRenamingEntry(null), []);

  const importKey =
    importMutation.isPending && importMutation.variables
      ? `${importMutation.variables.providerId}:${importMutation.variables.providerHandleId}`
      : null;

  return (
    <View style={styles.container} testID={testID}>
      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder={t("piSessionList.searchPlaceholder")}
          placeholderTextColor="#888"
          autoCapitalize="none"
          autoCorrect={false}
          testID={`${testID ?? "pi-session-list"}-search`}
        />
        <Pressable
          onPress={handleRefresh}
          hitSlop={8}
          testID={`${testID ?? "pi-session-list"}-refresh`}
        >
          <RotateCw size={16} color="#888" />
        </Pressable>
      </View>
      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
        {filteredEntries.length === 0 ? (
          <Text style={styles.emptyText}>{t("piSessionList.empty")}</Text>
        ) : (
          filteredEntries.map((entry) => (
            <SessionListRow
              key={`${entry.providerId}:${entry.providerHandleId}`}
              entry={entry}
              disabled={importMutation.isPending}
              importing={importKey === `${entry.providerId}:${entry.providerHandleId}`}
              showCwd={scanAllSessions || !cwd}
              onOpen={handleOpen}
              onTogglePin={handleTogglePin}
              onFork={handleFork}
              onRename={handleRename}
              onLaunch={handleLaunch}
            />
          ))
        )}
      </ScrollView>
      <AdaptiveRenameModal
        visible={renamingEntry !== null}
        title={t("importSession.row.rename")}
        initialValue={renamingEntry ? getSessionTitle(renamingEntry) : ""}
        placeholder={renamingEntry?.title ?? ""}
        onClose={handleRenameClose}
        onSubmit={handleRenameSubmit}
      />
    </View>
  );
}

function SessionListRow({
  entry,
  disabled,
  importing,
  showCwd,
  onOpen,
  onTogglePin,
  onFork,
  onRename,
  onLaunch,
}: {
  entry: FetchRecentProviderSessionEntry;
  disabled: boolean;
  importing: boolean;
  showCwd: boolean;
  onOpen: (entry: FetchRecentProviderSessionEntry) => void;
  onTogglePin: (entry: FetchRecentProviderSessionEntry) => void;
  onFork?: (entry: FetchRecentProviderSessionEntry) => void;
  onRename?: (entry: FetchRecentProviderSessionEntry) => void;
  onLaunch?: (entry: FetchRecentProviderSessionEntry) => void;
}) {
  const { t } = useTranslation();
  const title = getSessionTitle(entry);
  const promptPreview = getPromptPreview(entry);
  const lastActivity = formatTimeAgo(new Date(entry.lastActivityAt));
  const ProviderIcon = getProviderIcon(entry.providerId);

  const handleLongPress = useCallback(() => onTogglePin(entry), [entry, onTogglePin]);
  const handleOpen = useCallback(() => onOpen(entry), [entry, onOpen]);
  const handleFork = useCallback(() => onFork?.(entry), [entry, onFork]);
  const handleRename = useCallback(() => onRename?.(entry), [entry, onRename]);
  const handleLaunch = useCallback(() => onLaunch?.(entry), [entry, onLaunch]);
  const rowStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [styles.row, pressed && styles.rowPressed],
    [],
  );

  return (
    <Pressable
      disabled={disabled}
      onPress={handleOpen}
      onLongPress={handleLongPress}
      style={rowStyle}
      testID={`pi-session-row-${entry.providerId}-${entry.providerHandleId}`}
    >
      <View style={styles.rowIconWrap}>
        <ProviderIcon size={16} color="#888" />
      </View>
      <View style={styles.rowContent}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {title}
          </Text>
          {entry.meta?.pinned ? <Text style={styles.pinIndicator}>★</Text> : null}
          {PI_LIVE_UI && (entry.isLive || entry.isLiveAttachable) ? (
            <View style={styles.liveBadge}>
              <Text style={styles.badgeText}>LIVE</Text>
            </View>
          ) : null}
          {entry.meta?.forkedFrom ? (
            <View style={styles.forkBadge}>
              <Text style={styles.badgeText}>FORK</Text>
            </View>
          ) : null}
          {onFork ? (
            <Pressable onPress={handleFork} disabled={disabled} hitSlop={8}>
              <Text style={styles.actionIcon}>⎋</Text>
            </Pressable>
          ) : null}
          {onRename ? (
            <Pressable onPress={handleRename} disabled={disabled} hitSlop={8}>
              <Text style={styles.actionIcon}>✎</Text>
            </Pressable>
          ) : null}
          {onLaunch ? (
            <Pressable onPress={handleLaunch} disabled={disabled} hitSlop={8}>
              <Text style={styles.actionIcon}>▶</Text>
            </Pressable>
          ) : null}
          <Text style={styles.rowMeta}>
            {importing ? t("importSession.row.importing") : lastActivity}
          </Text>
        </View>
        <Text style={styles.rowPreview} numberOfLines={2}>
          {promptPreview}
        </Text>
        {showCwd && entry.cwd ? (
          <Text style={styles.rowCwd} numberOfLines={1}>
            {entry.cwd}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    gap: theme.spacing[2],
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  searchInput: {
    flex: 1,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  list: {
    flex: 1,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    padding: theme.spacing[6],
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  rowPressed: {
    opacity: 0.7,
  },
  rowIconWrap: {
    paddingTop: 2,
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexWrap: "wrap",
  },
  rowTitle: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  pinIndicator: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.base,
  },
  liveBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.accent,
  },
  forkBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.foregroundMuted,
  },
  badgeText: {
    color: theme.colors.surface0,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.bold,
  },
  actionIcon: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    paddingHorizontal: theme.spacing[1],
  },
  rowMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginLeft: "auto",
  },
  rowPreview: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  rowCwd: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    opacity: 0.7,
  },
}));

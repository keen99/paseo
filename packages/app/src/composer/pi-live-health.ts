import { useCallback, useSyncExternalStore } from "react";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export type PiBridgeHealth = "connected" | "disconnected";
export type PiTailHealth = "connected" | "pending" | "error" | "disconnected";

export interface PiLiveHealth {
  bridge: PiBridgeHealth;
  tail: PiTailHealth;
  transportConnected: boolean;
  live: boolean;
}

export function usePiLiveHealth(serverId: string, agentId: string): PiLiveHealth {
  const transportConnected = useHostRuntimeIsConnected(serverId);
  const bridge = useSessionStore((state) =>
    state.sessions[serverId]?.agents?.get(agentId)?.liveState === "connected"
      ? "connected"
      : "disconnected",
  );
  const viewedTimelineSync = useSessionStore(
    (state) => state.sessions[serverId]?.viewedTimelineSync ?? null,
  );
  const subscribe = useCallback(
    (listener: () => void) => viewedTimelineSync?.subscribe(listener) ?? (() => {}),
    [viewedTimelineSync],
  );
  const readTail = useCallback((): PiTailHealth => {
    if (!transportConnected || !viewedTimelineSync) return "disconnected";
    const status = viewedTimelineSync.getAgentTimelineStatus(agentId);
    if (status === "ready") return "connected";
    return status;
  }, [agentId, transportConnected, viewedTimelineSync]);
  const tail = useSyncExternalStore(subscribe, readTail, readTail);

  return {
    bridge,
    tail,
    transportConnected,
    live: bridge === "connected" && tail === "connected" && transportConnected,
  };
}

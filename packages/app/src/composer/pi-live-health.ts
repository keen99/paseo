import { useEffect, useState } from "react";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export type PiBridgeHealth = "connected" | "disconnected";
export type PiTailHealth = "connected" | "pending" | "disconnected";

export interface PiLiveHealth {
  bridge: PiBridgeHealth;
  tail: PiTailHealth;
  transportConnected: boolean;
  lastHeartbeatAt: number | null;
  heartbeatAgeMs: number | null;
  live: boolean;
}

const HEARTBEAT_STALE_MS = 7_000;

function resolveTailHealth(
  transportConnected: boolean,
  heartbeatAgeMs: number | null,
): PiTailHealth {
  if (!transportConnected) return "disconnected";
  if (heartbeatAgeMs === null) return "pending";
  return heartbeatAgeMs <= HEARTBEAT_STALE_MS ? "connected" : "disconnected";
}

export function usePiLiveHealth(serverId: string, agentId: string): PiLiveHealth {
  const client = useHostRuntimeClient(serverId);
  const transportConnected = useHostRuntimeIsConnected(serverId);
  const bridge = useSessionStore((state) =>
    state.sessions[serverId]?.agents?.get(agentId)?.liveState === "connected"
      ? "connected"
      : "disconnected",
  );
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setLastHeartbeatAt(null);
    if (!client) return;
    return client.on("agent_stream", (message) => {
      if (message.payload.agentId === agentId && message.payload.event.type === "live_heartbeat") {
        setLastHeartbeatAt(Date.now());
      }
    });
  }, [agentId, client]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const heartbeatAgeMs = lastHeartbeatAt === null ? null : Math.max(0, now - lastHeartbeatAt);
  const tail = resolveTailHealth(transportConnected, heartbeatAgeMs);

  return {
    bridge,
    tail,
    transportConnected,
    lastHeartbeatAt,
    heartbeatAgeMs,
    live: bridge === "connected" && tail === "connected" && transportConnected,
  };
}

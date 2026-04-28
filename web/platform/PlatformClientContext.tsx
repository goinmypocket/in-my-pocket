import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ClientMessage,
  ServerMessage,
} from "../../shared/platformProtocol";
import { PlatformClient } from "./ws";

interface ClientValue {
  send(msg: ClientMessage): void;
  subscribe(cb: (msg: ServerMessage) => void): () => void;
  status: "idle" | "connecting" | "open" | "closed";
}

const Ctx = createContext<ClientValue | null>(null);

export function PlatformClientProvider({ children }: { children: ReactNode }) {
  const clientRef = useRef<PlatformClient | null>(null);
  if (!clientRef.current) clientRef.current = new PlatformClient();
  const client = clientRef.current;

  const [status, setStatus] = useState<ClientValue["status"]>("idle");

  useEffect(() => {
    client.connect();
    const unsubStatus = client.onStatus(setStatus);
    return () => {
      unsubStatus();
      client.disconnect();
    };
  }, [client]);

  const value = useMemo<ClientValue>(
    () => ({
      status,
      send: (msg) => client.send(msg),
      subscribe: (cb) => client.subscribe(cb),
    }),
    [client, status],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useClient(): ClientValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useClient outside <PlatformClientProvider>");
  return v;
}

export function useServerMessage(
  predicate: (msg: ServerMessage) => boolean,
  handler: (msg: ServerMessage) => void,
): void {
  const { subscribe } = useClient();
  const handlerRef = useRef(handler);
  const predRef = useRef(predicate);
  handlerRef.current = handler;
  predRef.current = predicate;
  useEffect(() => {
    return subscribe((msg) => {
      if (predRef.current(msg)) handlerRef.current(msg);
    });
  }, [subscribe]);
}

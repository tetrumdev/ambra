import { createContext, useContext } from "react";

export type NetworkStatus = { state: string; method?: string | null; error?: string | null };
export type ClientConnection = {
  connected: boolean;
  network: NetworkStatus;
  sharedPlayback: boolean;
  setSharedPlayback: (shared: boolean, remember?: boolean) => Promise<void>;
  reconnect: () => void;
};
export const ClientConnectionContext = createContext<ClientConnection>({
  connected: false, network: { state: "Offline" }, sharedPlayback: false,
  setSharedPlayback: async () => {}, reconnect: () => {},
});
export const useClientConnection = () => useContext(ClientConnectionContext);

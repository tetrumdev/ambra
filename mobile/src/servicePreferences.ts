import * as SecureStore from "expo-secure-store";

export const services = ["tidal", "qobuz", "spotify"] as const;
export type Service = typeof services[number];
export type EnabledServices = Record<Service, boolean>;
const key = "ambra.mobile.services.v1";
const defaults = (): EnabledServices => ({ tidal: true, qobuz: true, spotify: true });
let enabled = defaults();
let loading: Promise<void> | null = null;
let writing: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

export function parseServicePreferences(raw: string | null): EnabledServices {
  try {
    const saved = raw ? JSON.parse(raw) : null;
    return Object.fromEntries(services.map(service => [service, typeof saved?.[service] === "boolean" ? saved[service] : true])) as EnabledServices;
  } catch { return defaults(); }
}

export const servicePreferences = () => enabled;
export function subscribeServicePreferences(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function loadServicePreferences() {
  return loading ??= SecureStore.getItemAsync(key).then(saved => {
    enabled = parseServicePreferences(saved);
    for (const listener of listeners) listener();
  }).catch(error => { loading = null; throw error; });
}

export function setServiceEnabled(service: Service, value: boolean): Promise<void> {
  const save = writing.catch(() => {}).then(async () => {
    await loadServicePreferences();
    const next = { ...enabled, [service]: value };
    await SecureStore.setItemAsync(key, JSON.stringify(next));
    enabled = next;
    for (const listener of listeners) listener();
  });
  writing = save;
  return save;
}

export function serviceAllowed(provider: string, selected: EnabledServices): boolean {
  return !services.includes(provider as Service) || selected[provider as Service];
}

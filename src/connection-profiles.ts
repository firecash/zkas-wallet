export interface EndpointProfile {
  id: string;
  name: string;
  address: string;
}

const NODE_PROFILES_KEY = "zkas_node_profiles_v1";
const KASPA_NODE_PROFILES_KEY = "kaspa_node_profiles_v1";
const WALLETD_PROFILES_KEY = "zkas_walletd_profiles_v1";

function read(key: string): EndpointProfile[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is EndpointProfile => {
      if (!item || typeof item !== "object") return false;
      const profile = item as Partial<EndpointProfile>;
      return typeof profile.id === "string" && typeof profile.name === "string" && typeof profile.address === "string";
    });
  } catch {
    return [];
  }
}

function write(key: string, profiles: EndpointProfile[]) {
  localStorage.setItem(key, JSON.stringify(profiles.slice(0, 20)));
  window.dispatchEvent(new CustomEvent("connection-profiles-changed"));
}

function idFor(address: string): string {
  const bytes = new TextEncoder().encode(`${address}:${Date.now()}:${Math.random()}`);
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return `endpoint-${(hash >>> 0).toString(16)}`;
}

function upsert(key: string, name: string, address: string): EndpointProfile {
  const cleanName = name.trim().slice(0, 32) || "My node";
  const cleanAddress = address.trim();
  const profiles = read(key);
  const existing = profiles.find((profile) => profile.address.toLowerCase() === cleanAddress.toLowerCase());
  const next = existing
    ? profiles.map((profile) => profile.id === existing.id ? { ...profile, name: cleanName, address: cleanAddress } : profile)
    : [...profiles, { id: idFor(cleanAddress), name: cleanName, address: cleanAddress }];
  write(key, next);
  return next.find((profile) => profile.address === cleanAddress)!;
}

export const nodeProfiles = {
  load: () => read(NODE_PROFILES_KEY),
  save: (name: string, address: string) => upsert(NODE_PROFILES_KEY, name, address),
  remove: (id: string) => write(NODE_PROFILES_KEY, read(NODE_PROFILES_KEY).filter((profile) => profile.id !== id)),
};

export const kaspaNodeProfiles = {
  load: () => read(KASPA_NODE_PROFILES_KEY),
  save: (name: string, address: string) => upsert(KASPA_NODE_PROFILES_KEY, name, address),
  remove: (id: string) => write(KASPA_NODE_PROFILES_KEY, read(KASPA_NODE_PROFILES_KEY).filter((profile) => profile.id !== id)),
};

export const walletdProfiles = {
  load: () => read(WALLETD_PROFILES_KEY),
  save: (name: string, address: string) => upsert(WALLETD_PROFILES_KEY, name, address),
  remove: (id: string) => write(WALLETD_PROFILES_KEY, read(WALLETD_PROFILES_KEY).filter((profile) => profile.id !== id)),
};

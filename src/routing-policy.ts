export interface RoutingRule { category: string; profiles: string[]; fallbackEnabled: boolean; }
export interface RoutingPolicy { rules: RoutingRule[]; reserveEnabled: boolean; reservedProfile: string | null; }
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = { rules: [], reserveEnabled: false, reservedProfile: null };
export function validateRoutingPolicy(policy: RoutingPolicy): RoutingPolicy {
  for (const r of policy.rules) {
    if (!r.category.trim() || r.profiles.length === 0) throw new Error("routing rule needs category and profiles");
    if (r.profiles.some((p) => /yolo/i.test(p))) throw new Error("yolo profiles are never eligible for routing");
  }
  if (policy.reservedProfile && /yolo/i.test(policy.reservedProfile)) throw new Error("yolo profiles cannot be reserved");
  return policy;
}
export function routeFor(policy: RoutingPolicy, category: string | null): { profile: string | null; fallbackProfiles: string[] } {
  const rule = policy.rules.find((r) => r.category === (category ?? ""));
  if (!rule) return { profile: null, fallbackProfiles: [] };
  return { profile: rule.profiles[0] ?? null, fallbackProfiles: rule.fallbackEnabled ? rule.profiles.slice(1) : [] };
}

export function normalizeRole(role: unknown): string {
  return String(role || "").trim().toLowerCase();
}

export function isPlatformLikeRole(role: unknown): boolean {
  return ["platform_admin", "master_admin", "super_admin"].includes(normalizeRole(role));
}

export function isAdminLikeRole(role: unknown): boolean {
  const r = normalizeRole(role);
  return r === "admin" || isPlatformLikeRole(r);
}

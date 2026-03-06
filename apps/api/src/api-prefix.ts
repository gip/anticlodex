export const API_V1_PREFIX = "/v1";

export function withApiPrefix(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_V1_PREFIX}${normalizedPath}`;
}

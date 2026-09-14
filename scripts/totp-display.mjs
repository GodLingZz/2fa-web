export function getRemainingSeconds(expiresAt, now = Date.now()) {
  return Math.max(0, Math.ceil((Number(expiresAt) - Number(now)) / 1000));
}

export function shouldRefresh(session) {
  return session.phase === "first" && session.refreshCount === 0;
}

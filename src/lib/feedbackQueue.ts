import { supabase } from "@/lib/supabase";
import { getTenantScopeFromLocalUser, readScopedJSON, writeScopedJSON } from "@/lib/tenantScope";

export type FeedbackType = "bug" | "feature" | "review";
export type FeedbackSeverity = "low" | "medium" | "high";

export type QueuedFeedback = {
  id: string;
  queued_at: string;
  business_id: string | null;
  local_user_id: string | null;

  type: FeedbackType;
  rating: number | null;
  title: string;
  message: string;
  severity: FeedbackSeverity;

  app_version: string | null;
  platform: string | null;
  route: string | null;
  metadata: Record<string, any> | null;
};

const QUEUE_KEY = "binancexi_feedback_queue_v1";

function safeGetQueue(): QueuedFeedback[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = readScopedJSON<QueuedFeedback[]>(QUEUE_KEY, [], {
      scope: getTenantScopeFromLocalUser(),
      migrateLegacy: true,
    });
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeSetQueue(next: QueuedFeedback[]) {
  if (typeof window === "undefined") return;
  try {
    writeScopedJSON(QUEUE_KEY, next, { scope: getTenantScopeFromLocalUser() });
  } catch {
    // ignore
  }
}

function randomId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `fb_${Math.random().toString(16).slice(2)}_${Date.now()}`;
  }
}

export function enqueueFeedback(
  input: Omit<QueuedFeedback, "id" | "queued_at">
): QueuedFeedback {
  const item: QueuedFeedback = {
    ...input,
    id: randomId(),
    queued_at: new Date().toISOString(),
  };

  const q = safeGetQueue();
  q.unshift(item);
  safeSetQueue(q.slice(0, 50)); // cap to prevent unbounded growth
  return item;
}

export function getQueuedFeedbackCount() {
  return safeGetQueue().length;
}

export async function flushFeedbackQueue(opts: {
  currentUser: { id?: string | null; business_id?: string | null } | null;
  max?: number;
}): Promise<{ sent: number; remaining: number; skipped_reason?: string }> {
  const max = typeof opts.max === "number" ? Math.max(1, Math.min(50, opts.max)) : 10;
  const currentUser = opts.currentUser;

  if (!currentUser?.business_id || !currentUser?.id) {
    return { sent: 0, remaining: safeGetQueue().length, skipped_reason: "missing_user" };
  }

  if (!navigator.onLine) {
    return { sent: 0, remaining: safeGetQueue().length, skipped_reason: "offline" };
  }

  const { data: sess } = await supabase.auth.getSession();
  if (!sess?.session?.access_token) {
    return { sent: 0, remaining: safeGetQueue().length, skipped_reason: "no_session" };
  }

  const { data: u, error: uErr } = await supabase.auth.getUser();
  if (uErr || !u?.user?.id) {
    return { sent: 0, remaining: safeGetQueue().length, skipped_reason: "no_user" };
  }

  const authUserId = String(u.user.id);
  const businessId = String(currentUser.business_id);

  const queue = safeGetQueue();
  const keep: QueuedFeedback[] = [];
  let sent = 0;

  for (const item of queue) {
    // Only flush items for the currently signed-in local user + business.
    if (item.business_id !== businessId || item.local_user_id !== String(currentUser.id)) {
      keep.push(item);
      continue;
    }

    if (sent >= max) {
      keep.push(item);
      continue;
    }

    const insertRow: any = {
      business_id: businessId,
      user_id: authUserId,
      type: item.type,
      rating: item.type === "review" ? item.rating : null,
      title: item.title,
      message: item.message,
      severity: item.severity,
      app_version: item.app_version,
      platform: item.platform,
      route: item.route,
      metadata: item.metadata,
    };

    const { error } = await supabase.from("app_feedback").insert(insertRow);
    if (error) {
      // Keep unsent items if the backend is not ready (migration/RLS/session problems).
      keep.push(item, ...queue.slice(queue.indexOf(item) + 1));
      safeSetQueue(keep);
      return { sent, remaining: keep.length, skipped_reason: "insert_failed" };
    }

    sent += 1;
  }

  safeSetQueue(keep);
  return { sent, remaining: keep.length };
}

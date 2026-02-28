import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json } from "../_shared/cors.ts";
import { getSupabaseEnv, supabaseAdminClient } from "../_shared/supabase.ts";
import { fdmsClient } from "../_shared/fdms.ts";

function sanitizeExcerpt(value: unknown, max = 500) {
  if (value == null) return null;
  const out = typeof value === "string" ? value : JSON.stringify(value);
  return out.length > max ? out.slice(0, max) : out;
}

function nextBackoff(attempt: number) {
  const minutes = Math.min(60, 2 ** Math.max(0, attempt - 1));
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function mapAcceptedStatus(jobType: string) {
  if (jobType === "status_poll") return "submitted";
  return "submitted";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const expectedSecret = String(Deno.env.get("FDMS_WORKER_SECRET") || "").trim();
    const suppliedSecret = String(req.headers.get("x-fdms-worker-secret") || "").trim();

    if (expectedSecret && suppliedSecret !== expectedSecret) {
      return json(403, { error: "Invalid worker secret" });
    }

    const body = await req.json().catch(() => ({} as any));
    const limit = Math.max(1, Math.min(100, Number(body?.limit || 20)));

    const admin = supabaseAdminClient(getSupabaseEnv());

    const { data: jobs, error: jobsErr } = await admin
      .from("fdms_retry_jobs")
      .select("id, tenant_id, submission_log_id, job_type, status, attempt_count, max_attempts")
      .eq("status", "pending")
      .lte("next_run_at", new Date().toISOString())
      .order("next_run_at", { ascending: true })
      .limit(limit);

    if (jobsErr) return json(500, { error: "Failed to load retry jobs" });

    let completed = 0;
    let retried = 0;
    let deadLettered = 0;
    let failed = 0;

    for (const job of jobs || []) {
      const attempt = Number((job as any).attempt_count || 0) + 1;
      const maxAttempts = Number((job as any).max_attempts || 8);

      await admin
        .from("fdms_retry_jobs")
        .update({ status: "running", attempt_count: attempt })
        .eq("id", (job as any).id);

      const { data: submission, error: subErr } = await admin
        .from("fdms_submission_logs")
        .select("id, tenant_id, submission_type, request_payload")
        .eq("id", (job as any).submission_log_id)
        .maybeSingle();

      if (subErr || !submission) {
        failed += 1;
        await admin
          .from("fdms_retry_jobs")
          .update({ status: "dead_letter", dead_letter_reason: "Submission not found", updated_at: new Date().toISOString() })
          .eq("id", (job as any).id);
        continue;
      }

      try {
        const payload = (submission as any).request_payload ?? {};
        let response: unknown;

        if ((job as any).job_type === "submit_file") {
          response = await fdmsClient.submitFile(payload);
        } else if ((job as any).job_type === "status_poll") {
          response = await fdmsClient.getFileStatus(payload);
        } else {
          response = await fdmsClient.submitReceipt(payload);
        }

        await admin
          .from("fdms_submission_logs")
          .update({
            status: mapAcceptedStatus(String((job as any).job_type || "")),
            response_payload: response,
            response_excerpt: sanitizeExcerpt(response),
            error_message: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", (submission as any).id);

        await admin
          .from("fdms_retry_jobs")
          .update({ status: "completed", last_error: null, updated_at: new Date().toISOString() })
          .eq("id", (job as any).id);

        completed += 1;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const shouldDeadLetter = attempt >= maxAttempts;

        if (shouldDeadLetter) {
          deadLettered += 1;
          await admin
            .from("fdms_retry_jobs")
            .update({
              status: "dead_letter",
              last_error: sanitizeExcerpt(msg, 800),
              dead_letter_reason: sanitizeExcerpt(msg, 800),
              updated_at: new Date().toISOString(),
            })
            .eq("id", (job as any).id);

          await admin
            .from("fdms_submission_logs")
            .update({ status: "failed", error_message: sanitizeExcerpt(msg, 800), updated_at: new Date().toISOString() })
            .eq("id", (submission as any).id);
        } else {
          retried += 1;
          await admin
            .from("fdms_retry_jobs")
            .update({
              status: "pending",
              last_error: sanitizeExcerpt(msg, 800),
              next_run_at: nextBackoff(attempt),
              updated_at: new Date().toISOString(),
            })
            .eq("id", (job as any).id);
        }
      }
    }

    return json(200, {
      ok: true,
      processed: (jobs || []).length,
      completed,
      retried,
      deadLettered,
      failed,
    });
  } catch (e) {
    return json(500, { error: "Unhandled error", details: e instanceof Error ? e.message : String(e) });
  }
});

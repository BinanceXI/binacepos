import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/lib/supabase";
import { friendlyAdminError, requirePlatformCloudSession } from "@/lib/platformAdminUtils";

import { PlatformPageHeader } from "@/components/platform/PlatformPageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type FeedbackRow = {
  id: string;
  created_at: string;
  business_id: string;
  type: string;
  rating: number | null;
  title: string;
  message: string;
  severity: string;
  status: string;
  app_version: string | null;
  platform: string | null;
  route: string | null;
  businesses?: { name?: string | null } | null;
  profiles?: { username?: string | null; full_name?: string | null } | null;
};

export function PlatformSupportPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [type, setType] = useState("all");

  const { data: feedback = [], isFetching } = useQuery({
    queryKey: ["platform", "supportFeedback", status, type],
    queryFn: async () => {
      let q = supabase
        .from("app_feedback")
        .select(
          "id, created_at, business_id, type, rating, title, message, severity, status, app_version, platform, route, businesses(name), profiles(username, full_name)"
        )
        .order("created_at", { ascending: false })
        .limit(250);
      if (status !== "all") q = q.eq("status", status);
      if (type !== "all") q = q.eq("type", type);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as unknown as FeedbackRow[];
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const rows = feedback.filter((f) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      String(f.title || "").toLowerCase().includes(q) ||
      String(f.message || "").toLowerCase().includes(q) ||
      String(f.businesses?.name || "").toLowerCase().includes(q) ||
      String(f.profiles?.username || "").toLowerCase().includes(q)
    );
  });

  const updateStatus = async (row: FeedbackRow, next: string) => {
    try {
      if (!(await requirePlatformCloudSession())) return;
      const { error } = await supabase
        .from("app_feedback")
        .update({ status: next } as any)
        .eq("id", row.id);
      if (error) throw error;
      toast.success("Support item updated");
      await qc.invalidateQueries({ queryKey: ["platform", "supportFeedback"] });
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to update support item");
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-4">
      <PlatformPageHeader
        title="Support / Chats"
        subtitle="Customer issues and feedback inbox (used as lightweight support queue)."
      />

      <Card className="shadow-card">
        <CardHeader>
          <div className="flex flex-col xl:flex-row xl:items-end xl:justify-between gap-3">
            <CardTitle>Support Queue</CardTitle>
            <div className="flex flex-col md:flex-row gap-2">
              <select
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="all">All status</option>
                <option value="new">New</option>
                <option value="triaged">Triaged</option>
                <option value="in_progress">In progress</option>
                <option value="done">Done</option>
                <option value="wont_fix">Won&apos;t fix</option>
              </select>
              <select
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                value={type}
                onChange={(e) => setType(e.target.value)}
              >
                <option value="all">All types</option>
                <option value="bug">Bug</option>
                <option value="feature">Feature</option>
                <option value="review">Review</option>
              </select>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search support queue"
                className="w-[260px] max-w-full"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Business</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!rows.length ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-sm text-muted-foreground">
                      {isFetching ? "Loading..." : "No support items"}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((f) => (
                    <TableRow key={f.id}>
                      <TableCell className="text-sm">
                        {new Date(f.created_at).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-sm">
                        <div className="font-semibold">{f.businesses?.name || f.business_id}</div>
                        <div className="text-xs text-muted-foreground">
                          {f.profiles?.full_name || f.profiles?.username || "—"}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {f.type}
                          {f.type === "review" && f.rating ? ` (${f.rating}/5)` : ""}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            f.status === "new"
                              ? "destructive"
                              : f.status === "in_progress"
                                ? "outline"
                                : "secondary"
                          }
                        >
                          {f.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        <div className="font-semibold">{f.title}</div>
                        <div className="text-xs text-muted-foreground line-clamp-2">
                          {f.message}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button size="sm" variant="outline" onClick={() => void updateStatus(f, "triaged")}>
                            Triaged
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => void updateStatus(f, "in_progress")}>
                            In Progress
                          </Button>
                          <Button size="sm" onClick={() => void updateStatus(f, "done")}>
                            Done
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default PlatformSupportPage;

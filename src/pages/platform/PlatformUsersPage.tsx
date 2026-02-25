import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/lib/supabase";
import { usePOS } from "@/contexts/POSContext";
import { friendlyAdminError, requirePlatformCloudSession } from "@/lib/platformAdminUtils";

import { PlatformPageHeader } from "@/components/platform/PlatformPageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type PlatformUserRow = {
  id: string;
  username: string | null;
  full_name: string | null;
  role: string;
  active: boolean | null;
  business_id: string | null;
  is_support?: boolean | null;
  businesses?: { name?: string | null } | null;
};

export function PlatformUsersPage() {
  const qc = useQueryClient();
  const { currentUser } = usePOS();
  const [search, setSearch] = useState("");

  const { data: users = [], isFetching } = useQuery({
    queryKey: ["platform", "users"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, username, full_name, role, active, business_id, is_support, businesses(name)")
        .order("role", { ascending: true })
        .order("full_name", { ascending: true });
      if (error) throw error;
      return (data || []) as unknown as PlatformUserRow[];
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      return (
        String(u.full_name || "").toLowerCase().includes(q) ||
        String(u.username || "").toLowerCase().includes(q) ||
        String(u.role || "").toLowerCase().includes(q) ||
        String(u.businesses?.name || "").toLowerCase().includes(q) ||
        String(u.business_id || "").toLowerCase().includes(q)
      );
    });
  }, [users, search]);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["platform", "users"] });
    await qc.invalidateQueries({ queryKey: ["platform", "businessUsers"] });
  };

  const setUserActive = async (row: PlatformUserRow, nextActive: boolean) => {
    if (String(currentUser?.id || "") === String(row.id || "")) {
      return toast.error("You cannot modify your own account here");
    }
    try {
      if (!(await requirePlatformCloudSession())) return;
      const { error } = await supabase
        .from("profiles")
        .update({ active: nextActive } as any)
        .eq("id", row.id);
      if (error) throw error;
      toast.success(nextActive ? "User activated" : "User deactivated");
      await refresh();
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to update user");
    }
  };

  const deleteUser = async (row: PlatformUserRow) => {
    if (String(currentUser?.id || "") === String(row.id || "")) {
      return toast.error("You cannot delete your own account");
    }
    const ok = window.confirm(
      `Permanently delete user ${row.username || row.full_name || row.id}?\n\nIf they have related history, deletion may fail and you should deactivate instead.`
    );
    if (!ok) return;

    try {
      if (!(await requirePlatformCloudSession())) return;
      const { data, error } = await supabase.functions.invoke("delete_staff_user", {
        body: { user_id: row.id },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success("User deleted");
      await refresh();
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Delete failed");
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-4">
      <PlatformPageHeader
        title="Users"
        subtitle="Manage users across all businesses. Destructive actions require confirmation."
      />

      <Card className="shadow-card">
        <CardHeader>
          <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
            <CardTitle>All Users</CardTitle>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name / username / business"
              className="w-[320px] max-w-full"
            />
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Business</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!filtered.length ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-sm text-muted-foreground">
                      {isFetching ? "Loading..." : "No users found"}
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell className="text-sm">
                        <div className="font-semibold">{u.full_name || u.username || "—"}</div>
                        <div className="text-xs text-muted-foreground">
                          {u.username || "no username"} • {u.id}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">{u.role || "—"}</Badge>
                          {u.is_support ? <Badge variant="secondary">support</Badge> : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        <div>{u.businesses?.name || "—"}</div>
                        <div className="text-xs text-muted-foreground">{u.business_id || "—"}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={u.active === false ? "destructive" : "secondary"}>
                          {u.active === false ? "disabled" : "active"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button size="sm" variant="outline" onClick={() => void setUserActive(u, true)}>
                            Activate
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => void setUserActive(u, false)}>
                            Deactivate
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => void deleteUser(u)}>
                            Delete
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

export default PlatformUsersPage;

import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";

import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";

import { POSProvider, usePOS } from "./contexts/POSContext";
import { LoginScreen } from "./components/auth/LoginScreen";
import { CloudSessionGate } from "./components/auth/CloudSessionGate";
import { MainLayout } from "./components/layout/MainLayout";
import { SubscriptionGate } from "./components/billing/SubscriptionGate";

import { VerifyReceiptPage } from "./pages/VerifyReceiptPage";
import { DashboardPage } from "./pages/Dashboard";
import { POSPage } from "./pages/POSPage";
import { InventoryPage } from "./pages/InventoryPage";
import { ReportsPage } from "./pages/ReportsPage";
import { ReceiptsPage } from "./pages/ReceiptsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ProfitAnalysisPage } from "./pages/ProfitAnalysisPage";
import { ExpensesPage } from "./pages/ExpensesPage";
import PlatformOverviewPage from "./pages/platform/PlatformOverviewPage";
import PlatformBusinessesPage from "./pages/platform/PlatformBusinessesPage";
import PlatformUsersPage from "./pages/platform/PlatformUsersPage";
import PlatformDevicesPage from "./pages/platform/PlatformDevicesPage";
import PlatformPlansPricingPage from "./pages/platform/PlatformPlansPricingPage";
import PlatformActivationRequestsPage from "./pages/platform/PlatformActivationRequestsPage";
import PlatformAnalyticsPage from "./pages/platform/PlatformAnalyticsPage";
import PlatformSupportPage from "./pages/platform/PlatformSupportPage";
import PlatformAuditLogsPage from "./pages/platform/PlatformAuditLogsPage";
import PlatformAdminSettingsPage from "./pages/platform/PlatformAdminSettingsPage";
import NotFound from "./pages/NotFound";
import { EXPECTED_SUPABASE_REFS, getBackendInfo } from "@/lib/backendInfo";
import { isPlatformLikeRole } from "@/lib/roles";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 1000 * 60 * 60 * 24 * 7,
      staleTime: 1000 * 60 * 5,
      retry: 0,
      networkMode: "offlineFirst",
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
  },
});

const persister = createSyncStoragePersister({
  storage: window.localStorage,
});

const AppRoutes = () => {
  const { currentUser } = usePOS();
  const role = (currentUser as any)?.role;
  const isPlatformAdmin = isPlatformLikeRole(role);

  return (
    <Routes>
      {/* ✅ Public verify route (no login needed) */}
      <Route path="/verify/:id" element={<VerifyReceiptPage />} />

      {/* ✅ Auth gate */}
      {!currentUser ? (
        <Route path="*" element={<LoginScreen onLogin={() => {}} />} />
      ) : isPlatformAdmin ? (
        <>
          <Route path="/" element={<Navigate to="/platform/overview" replace />} />
          <Route path="/platform" element={<Navigate to="/platform/overview" replace />} />
          <Route
            path="/platform/overview"
            element={
              <CloudSessionGate>
                <MainLayout>
                  <PlatformOverviewPage />
                </MainLayout>
              </CloudSessionGate>
            }
          />
          <Route
            path="/platform/businesses"
            element={
              <CloudSessionGate>
                <MainLayout>
                  <PlatformBusinessesPage />
                </MainLayout>
              </CloudSessionGate>
            }
          />
          <Route
            path="/platform/users"
            element={
              <CloudSessionGate>
                <MainLayout>
                  <PlatformUsersPage />
                </MainLayout>
              </CloudSessionGate>
            }
          />
          <Route
            path="/platform/devices"
            element={
              <CloudSessionGate>
                <MainLayout>
                  <PlatformDevicesPage />
                </MainLayout>
              </CloudSessionGate>
            }
          />
          <Route
            path="/platform/plans"
            element={
              <CloudSessionGate>
                <MainLayout>
                  <PlatformPlansPricingPage />
                </MainLayout>
              </CloudSessionGate>
            }
          />
          <Route
            path="/platform/activation-requests"
            element={
              <CloudSessionGate>
                <MainLayout>
                  <PlatformActivationRequestsPage />
                </MainLayout>
              </CloudSessionGate>
            }
          />
          <Route
            path="/platform/analytics"
            element={
              <CloudSessionGate>
                <MainLayout>
                  <PlatformAnalyticsPage />
                </MainLayout>
              </CloudSessionGate>
            }
          />
          <Route
            path="/platform/support"
            element={
              <CloudSessionGate>
                <MainLayout>
                  <PlatformSupportPage />
                </MainLayout>
              </CloudSessionGate>
            }
          />
          <Route
            path="/platform/audit-logs"
            element={
              <CloudSessionGate>
                <MainLayout>
                  <PlatformAuditLogsPage />
                </MainLayout>
              </CloudSessionGate>
            }
          />
          <Route
            path="/platform/settings"
            element={
              <CloudSessionGate>
                <MainLayout>
                  <PlatformAdminSettingsPage />
                </MainLayout>
              </CloudSessionGate>
            }
          />
          <Route path="*" element={<Navigate to="/platform/overview" replace />} />
        </>
      ) : (
        <>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />

          <Route
            path="/dashboard"
            element={
              <SubscriptionGate>
                <MainLayout>
                  <DashboardPage />
                </MainLayout>
              </SubscriptionGate>
            }
          />
          <Route
            path="/pos"
            element={
              <SubscriptionGate>
                <MainLayout>
                  <POSPage />
                </MainLayout>
              </SubscriptionGate>
            }
          />
          <Route
            path="/inventory"
            element={
              <SubscriptionGate>
                <MainLayout>
                  <InventoryPage />
                </MainLayout>
              </SubscriptionGate>
            }
          />
          <Route
            path="/profit"
            element={
              <SubscriptionGate>
                <MainLayout>
                  <ProfitAnalysisPage />
                </MainLayout>
              </SubscriptionGate>
            }
          />
          <Route
            path="/receipts"
            element={
              <SubscriptionGate>
                <MainLayout>
                  <ReceiptsPage />
                </MainLayout>
              </SubscriptionGate>
            }
          />
          <Route
            path="/reports"
            element={
              <SubscriptionGate>
                <MainLayout>
                  <ReportsPage />
                </MainLayout>
              </SubscriptionGate>
            }
          />
          <Route
            path="/expenses"
            element={
              <SubscriptionGate>
                <MainLayout>
                  <ExpensesPage />
                </MainLayout>
              </SubscriptionGate>
            }
          />
          <Route
            path="/settings"
            element={
              <SubscriptionGate>
                <MainLayout>
                  <SettingsPage />
                </MainLayout>
              </SubscriptionGate>
            }
          />

          {/* ✅ Proper NotFound (NO recursion) */}
          <Route
            path="*"
            element={
              <SubscriptionGate>
                <MainLayout>
                  <NotFound />
                </MainLayout>
              </SubscriptionGate>
            }
          />
        </>
      )}
    </Routes>
  );
};

const App = () => {
  useEffect(() => {
    const saved = localStorage.getItem("binancexi_theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const shouldUseDark = saved ? saved === "dark" : prefersDark;
    document.documentElement.classList.toggle("dark", shouldUseDark);
  }, []);

  useEffect(() => {
    const b = getBackendInfo();
    const expected = EXPECTED_SUPABASE_REFS as readonly string[];
    const ok = !!b.supabaseRef && expected.includes(b.supabaseRef);

    const msg = `[backend] ref=${b.supabaseRef || "unknown"} mode=${b.mode || "unknown"}${
      b.appVersion ? ` version=${b.appVersion}` : ""
    }${b.appCommit ? ` commit=${b.appCommit.slice(0, 7)}` : ""}`;

    if (!b.supabaseUrl) {
      console.warn("[backend] Missing VITE_SUPABASE_URL. App will not be connected.");
      return;
    }

    if (!ok) {
      console.warn(`${msg} expected=${expected.join(", ")}`, { supabaseUrl: b.supabaseUrl });
    } else {
      console.info(msg, { supabaseUrl: b.supabaseUrl });
    }
  }, []);

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: 1000 * 60 * 60 * 24 * 7,
        buster: "binancexi-v1",
      }}
    >
      <TooltipProvider>
        <POSProvider>
          <Toaster />
          <Sonner />
          <AppRoutes />
        </POSProvider>
      </TooltipProvider>
    </PersistQueryClientProvider>
  );
};

export default App;

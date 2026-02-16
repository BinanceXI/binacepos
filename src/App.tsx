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
import { PlatformAdminPage } from "./pages/PlatformAdminPage";
import NotFound from "./pages/NotFound";

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

  return (
    <Routes>
      {/* ✅ Public verify route (no login needed) */}
      <Route path="/verify/:id" element={<VerifyReceiptPage />} />

      {/* ✅ Auth gate */}
      {!currentUser ? (
        <Route path="*" element={<LoginScreen onLogin={() => {}} />} />
      ) : role === "platform_admin" ? (
        <>
          <Route path="/" element={<Navigate to="/platform" replace />} />
          <Route
            path="/platform"
            element={
              <MainLayout>
                <PlatformAdminPage />
              </MainLayout>
            }
          />
          <Route path="*" element={<Navigate to="/platform" replace />} />
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

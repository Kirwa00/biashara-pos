import { lazy, StrictMode, Suspense, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import "./index.css";
import { session } from "./api";
import { Loading } from "./pages/ui";

/** Pages load on first visit so a till on a slow line downloads only what it opens; the service worker keeps them afterwards. */
const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
import { AppShell } from "./pages/AppShell";
import { AuthPage } from "./pages/AuthPage";
import { LandingPage } from "./pages/LandingPage";
const CustomersPage = page(() => import("./pages/CustomersPage"), "CustomersPage");
const ProductsPage = page(() => import("./pages/ProductsPage"), "ProductsPage");
const Dashboard = page(() => import("./pages/Dashboard"), "Dashboard");
const TeamPage = page(() => import("./pages/TeamPage"), "TeamPage");
const InventoryPage = page(() => import("./pages/InventoryPage"), "InventoryPage");
const InvoicesPage = page(() => import("./pages/InvoicesPage"), "InvoicesPage");
const PaymentsSettingsPage = page(() => import("./pages/PaymentsSettingsPage"), "PaymentsSettingsPage");
const ReportsPage = page(() => import("./pages/ReportsPage"), "ReportsPage");
const PurchaseOrdersPage = page(() => import("./pages/PurchaseOrdersPage"), "PurchaseOrdersPage");
const SuppliersPage = page(() => import("./pages/SuppliersPage"), "SuppliersPage");
const TillPage = page(() => import("./pages/TillPage"), "TillPage");
const ReceiptPage = page(() => import("./pages/ReceiptPage"), "ReceiptPage");
const DocumentPrintPage = page(() => import("./pages/DocumentPrintPage"), "DocumentPrintPage");
const RemindersPage = page(() => import("./pages/RemindersPage"), "RemindersPage");
const NotificationsPage = page(() => import("./pages/NotificationsPage"), "NotificationsPage");
const TransfersPage = page(() => import("./pages/TransfersPage"), "TransfersPage");
const AdminPage = page(() => import("./pages/AdminPage"), "AdminPage");
const ShiftsPage = page(() => import("./pages/ShiftsPage"), "ShiftsPage");
const ReturnsPage = page(() => import("./pages/ReturnsPage"), "ReturnsPage");
const EtimsPage = page(() => import("./pages/EtimsPage"), "EtimsPage");
const ZReportPage = page(() => import("./pages/ZReportPage"), "ZReportPage");

// Signed-out visitors to "/" see the marketing page; other app routes send them to sign in.
const Protected = ({ children }: { children: React.ReactNode }) => {
  const { pathname } = useLocation();
  if (session.get()) return children;
  return pathname === "/" ? <LandingPage /> : <Navigate to="/login" replace />;
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route
          path="/receipt/:id"
          element={
            <Protected>
              <ReceiptPage />
            </Protected>
          }
        />
        <Route
          path="/print/:id"
          element={
            <Protected>
              <DocumentPrintPage />
            </Protected>
          }
        />
        <Route
          path="/receipt/shift/:id"
          element={
            <Protected>
              <ZReportPage />
            </Protected>
          }
        />
        <Route
          element={
            <Protected>
              <AppShell />
            </Protected>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="till" element={<TillPage />} />
          <Route path="shifts" element={<ShiftsPage />} />
          <Route path="sales" element={<InvoicesPage />} />
          <Route path="returns" element={<ReturnsPage />} />
          <Route path="inventory" element={<InventoryPage />} />
          <Route path="transfers" element={<TransfersPage />} />
          <Route path="suppliers" element={<SuppliersPage />} />
          <Route path="purchase-orders" element={<PurchaseOrdersPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="etims" element={<EtimsPage />} />
          <Route path="products" element={<ProductsPage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="reminders" element={<RemindersPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="team" element={<TeamPage />} />
          <Route path="settings/payments" element={<PaymentsSettingsPage />} />
          <Route path="admin" element={<AdminPage />} />
        </Route>
      </Routes>
      </Suspense>
    </BrowserRouter>
  </StrictMode>
);

if ("serviceWorker" in navigator && import.meta.env.PROD) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));

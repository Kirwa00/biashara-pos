import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import "./index.css";
import { session } from "./api";
import { AppShell } from "./pages/AppShell";
import { AuthPage } from "./pages/AuthPage";
import { CustomersPage } from "./pages/CustomersPage";
import { ProductsPage } from "./pages/ProductsPage";
import { Dashboard } from "./pages/Dashboard";
import { TeamPage } from "./pages/TeamPage";
import { InventoryPage } from "./pages/InventoryPage";
import { InvoicesPage } from "./pages/InvoicesPage";
import { PaymentsSettingsPage } from "./pages/PaymentsSettingsPage";
import { ReportsPage } from "./pages/ReportsPage";
import { SuppliersPage } from "./pages/SuppliersPage";
import { TillPage } from "./pages/TillPage";
import { ReceiptPage } from "./pages/ReceiptPage";

const Protected = ({ children }: { children: React.ReactNode }) => (session.get() ? children : <Navigate to="/login" replace />);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route path="/receipt/:id" element={<Protected><ReceiptPage /></Protected>} />
        <Route element={<Protected><AppShell /></Protected>}>
          <Route index element={<Dashboard />} />
          <Route path="products" element={<ProductsPage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="team" element={<TeamPage />} />
          <Route path="till" element={<TillPage />} />
          <Route path="sales" element={<InvoicesPage />} />
          <Route path="inventory" element={<InventoryPage />} />
          <Route path="suppliers" element={<SuppliersPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="settings/payments" element={<PaymentsSettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);

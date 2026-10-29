import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import "./index.css";
import { session } from "./api";
import { AppShell } from "./pages/AppShell";
import { AuthPage } from "./pages/AuthPage";
import { Dashboard } from "./pages/Dashboard";
import { TeamPage } from "./pages/TeamPage";

const Protected = ({ children }: { children: React.ReactNode }) => (session.get() ? children : <Navigate to="/login" replace />);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route element={<Protected><AppShell /></Protected>}>
          <Route index element={<Dashboard />} />
          <Route path="team" element={<TeamPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);

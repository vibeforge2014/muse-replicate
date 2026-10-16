import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import AgentsPage from "./pages/AgentsPage";
import EnvironmentsPage from "./pages/EnvironmentsPage";
import SessionsPage from "./pages/SessionsPage";
import ChatPage from "./pages/ChatPage";
import ResourcesPage from "./pages/ResourcesPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Navigate to="/agents" replace />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="environments" element={<EnvironmentsPage />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="sessions/new" element={<SessionsPage mode="new" />} />
        <Route path="sessions/:id" element={<ChatPage />} />
        <Route path="resources" element={<ResourcesPage />} />
        <Route path="*" element={<Navigate to="/agents" replace />} />
      </Route>
    </Routes>
  );
}

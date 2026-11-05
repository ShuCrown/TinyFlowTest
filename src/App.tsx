import { Navigate, Route, Routes } from "react-router-dom";
import { Shell } from "./Shell";
import { FlowsPage } from "./pages/FlowsPage";
import { RecordsPage } from "./pages/RecordsPage";
import { SystemsPage } from "./pages/SystemsPage";

export function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Navigate to="/records" replace />} />
        <Route path="systems" element={<SystemsPage />} />
        <Route path="records" element={<RecordsPage />} />
        <Route path="flows" element={<FlowsPage />} />
        <Route path="*" element={<Navigate to="/records" replace />} />
      </Route>
    </Routes>
  );
}

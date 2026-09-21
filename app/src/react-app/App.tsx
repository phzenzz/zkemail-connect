import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import SendPage from "./pages/SendPage";
import "./App.css";

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-background text-foreground">
        <Routes>
          <Route path="/" element={<Navigate to="/send" replace />} />
          <Route path="/send" element={<SendPage />} />
          <Route path="/claim/:escrow" element={<div data-testid="claim-page">Claim page placeholder</div>} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

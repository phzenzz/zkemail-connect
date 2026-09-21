import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./App.css";

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-background text-foreground">
        <Routes>
          <Route path="/" element={<Navigate to="/send" replace />} />
          <Route path="/send" element={<div data-testid="send-page">Send page placeholder</div>} />
          <Route path="/claim/:escrow" element={<div data-testid="claim-page">Claim page placeholder</div>} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

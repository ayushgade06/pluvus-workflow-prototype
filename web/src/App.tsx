import { useEffect, useState } from "react";

type HealthStatus = "loading" | "ok" | "error";

interface HealthResponse {
  status: string;
  service: string;
  timestamp: string;
}

export default function App() {
  const [serverHealth, setServerHealth] = useState<HealthStatus>("loading");
  const [agentHealth, setAgentHealth] = useState<HealthStatus>("loading");

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json() as Promise<HealthResponse>)
      .then((data) => setServerHealth(data.status === "ok" ? "ok" : "error"))
      .catch(() => setServerHealth("error"));

    fetch("/agent/health")
      .then((r) => r.json() as Promise<HealthResponse>)
      .then((data) => setAgentHealth(data.status === "ok" ? "ok" : "error"))
      .catch(() => setAgentHealth("error"));
  }, []);

  return (
    <div style={{ fontFamily: "monospace", padding: "2rem", maxWidth: "480px" }}>
      <h1 style={{ fontSize: "1.25rem", marginBottom: "1.5rem" }}>
        Pluvus Workflow — Phase 1
      </h1>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          <ServiceRow label="Express server" status={serverHealth} />
          <ServiceRow label="Agent service" status={agentHealth} />
        </tbody>
      </table>
    </div>
  );
}

function ServiceRow({ label, status }: { label: string; status: HealthStatus }) {
  const symbol = status === "loading" ? "…" : status === "ok" ? "✓" : "✗";
  const color = status === "loading" ? "#999" : status === "ok" ? "#22c55e" : "#ef4444";
  return (
    <tr>
      <td style={{ padding: "0.4rem 0", color: "#ccc" }}>{label}</td>
      <td style={{ padding: "0.4rem 0", color, fontWeight: "bold" }}>{symbol}</td>
    </tr>
  );
}

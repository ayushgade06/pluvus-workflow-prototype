import { useState, useMemo } from "react";
import { useCreators, enrollCreators, useWorkflowExecution } from "../../api/builderClient";
import { colors } from "../../theme";
import type { EnrollResponse, WorkflowDetail } from "../../api/builderTypes";

interface Props {
  workflow: WorkflowDetail;
  onEnrolled: () => void;
}

export function EnrollTab({ workflow, onEnrolled }: Props) {
  const { data: creators, isLoading } = useCreators();
  const { data: execution } = useWorkflowExecution(workflow.id);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<EnrollResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasVersion = !!workflow.latestVersion;

  const filtered = useMemo(() => {
    if (!creators) return [];
    const q = filter.toLowerCase();
    if (!q) return creators;
    return creators.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        (c.handle ?? "").toLowerCase().includes(q) ||
        (c.platform ?? "").toLowerCase().includes(q) ||
        (c.niche ?? "").toLowerCase().includes(q),
    );
  }, [creators, filter]);

  const enrolledCount = execution?.totalInstances ?? 0;

  function toggleAll() {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((c) => c.id)));
    }
  }

  async function handleEnroll() {
    if (selected.size === 0) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const r = await enrollCreators(workflow.id, [...selected]);
      setResult(r);
      setSelected(new Set());
      onEnrolled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Enrollment failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (!hasVersion) {
    return (
      <Blocker message="Publish the workflow before enrolling creators." />
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        padding: "20px 24px",
        gap: 16,
        overflow: "auto",
      }}
    >
      {/* Summary row */}
      <div style={{ display: "flex", gap: 16 }}>
        <StatCard label="Already Enrolled" value={enrolledCount} color={colors.accent} />
        <StatCard label="Selected" value={selected.size} color={colors.success} />
        <StatCard label="Total Creators" value={creators?.length ?? 0} />
      </div>

      {result && (
        <div
          style={{
            padding: "10px 14px",
            background: "rgba(63,185,80,0.1)",
            border: `1px solid ${colors.success}`,
            borderRadius: 6,
            fontSize: 13,
            color: colors.success,
          }}
        >
          ✓ Enrolled {result.enrolled} creator{result.enrolled !== 1 ? "s" : ""}
          {result.skipped > 0 ? ` · ${result.skipped} skipped (already enrolled)` : ""}
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "10px 14px",
            background: "rgba(248,81,73,0.1)",
            border: `1px solid ${colors.danger}`,
            borderRadius: 6,
            fontSize: 13,
            color: colors.danger,
          }}
        >
          {error}
        </div>
      )}

      {/* Search + select all */}
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search creators…"
          style={{
            flex: 1,
            padding: "7px 10px",
            background: colors.bg,
            border: `1px solid ${colors.border}`,
            borderRadius: 5,
            color: colors.text,
            fontSize: 13,
            outline: "none",
          }}
        />
        <button
          onClick={toggleAll}
          style={{
            padding: "7px 12px",
            background: "none",
            border: `1px solid ${colors.border}`,
            borderRadius: 5,
            color: colors.textMuted,
            fontSize: 12,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {selected.size === filtered.length && filtered.length > 0
            ? "Deselect All"
            : "Select All"}
        </button>
      </div>

      {/* Creator list */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          border: `1px solid ${colors.border}`,
          borderRadius: 8,
          background: colors.bg,
        }}
      >
        {isLoading ? (
          <div style={{ padding: 20, color: colors.textMuted, fontSize: 13 }}>
            Loading creators…
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 20, color: colors.textMuted, fontSize: 13 }}>
            No creators found.
          </div>
        ) : (
          filtered.map((c) => (
            <div
              key={c.id}
              onClick={() => {
                const next = new Set(selected);
                if (next.has(c.id)) next.delete(c.id);
                else next.add(c.id);
                setSelected(next);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 14px",
                borderBottom: `1px solid ${colors.border}`,
                cursor: "pointer",
                background: selected.has(c.id) ? "rgba(56,139,253,0.05)" : "transparent",
              }}
            >
              <div
                style={{
                  width: 16,
                  height: 16,
                  border: `1.5px solid ${selected.has(c.id) ? colors.accent : colors.border}`,
                  borderRadius: 3,
                  background: selected.has(c.id) ? colors.accent : "transparent",
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {selected.has(c.id) && (
                  <span style={{ color: "#fff", fontSize: 10, lineHeight: 1 }}>✓</span>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>
                  {c.name}
                  {c.handle && (
                    <span style={{ fontSize: 12, fontWeight: 400, color: colors.textMuted, marginLeft: 6 }}>
                      @{c.handle}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: colors.textDim }}>
                  {c.email}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                {c.platform && (
                  <div style={{ fontSize: 11, color: colors.textMuted }}>{c.platform}</div>
                )}
                {c.niche && (
                  <div style={{ fontSize: 11, color: colors.textDim }}>{c.niche}</div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Enroll button */}
      <button
        disabled={selected.size === 0 || submitting}
        onClick={() => void handleEnroll()}
        style={{
          padding: "10px",
          background: selected.size === 0 || submitting ? colors.border : colors.accent,
          color: selected.size === 0 || submitting ? colors.textDim : "#fff",
          border: "none",
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 600,
          cursor: selected.size === 0 || submitting ? "not-allowed" : "pointer",
          flexShrink: 0,
        }}
      >
        {submitting
          ? "Enrolling…"
          : selected.size === 0
          ? "Select creators to enroll"
          : `Enroll ${selected.size} Creator${selected.size !== 1 ? "s" : ""}`}
      </button>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div
      style={{
        flex: 1,
        padding: "12px 16px",
        background: colors.panel,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 700, color: color ?? colors.text }}>
        {value}
      </div>
      <div
        style={{
          fontSize: 10.5,
          color: colors.textDim,
          textTransform: "uppercase",
          letterSpacing: 0.4,
        }}
      >
        {label}
      </div>
    </div>
  );
}

function Blocker({ message }: { message: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        color: colors.textMuted,
        fontSize: 13,
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ fontSize: 28 }}>🔒</div>
      <div>{message}</div>
    </div>
  );
}

import { Card } from "../ui/index.tsx";

export function KpiCard({ label, value }: { label: string; value?: number | null }) {
  return (
    <Card className="kpiCard">
      <p>{label}</p>
      <strong>{value ?? "—"}</strong>
    </Card>
  );
}

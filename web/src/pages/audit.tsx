import { useApi } from "../api";
import { Badge, Card, ErrorBox, Loading, PageHeader, Table } from "../ui";

export function AuditPage() {
  const events = useApi<any[]>("/audit");
  const verify = useApi<any>("/audit/verify");
  return (
    <div>
      <PageHeader
        title="Audit log"
        sub="Append-only and hash-chained: every AI suggestion, edit, approval and submission."
        actions={verify.data && <Badge tone={verify.data.ok ? "good" : "crit"}>{verify.data.ok ? `Chain verified · ${verify.data.count} events` : `Chain broken at #${verify.data.brokenAt}`}</Badge>}
      />
      <ErrorBox error={events.error} />
      {!events.data ? <Loading /> : (
        <Card pad={false}>
          <div className="p-4">
            <Table>
              <thead><tr><th>#</th><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Hash</th></tr></thead>
              <tbody>
                {events.data.map((e) => (
                  <tr key={e.id}>
                    <td className="num text-muted">{e.seq}</td>
                    <td className="whitespace-nowrap">{new Date(e.at).toLocaleString("en-GB")}</td>
                    <td>{e.actor} <span className="text-muted">({e.role})</span></td>
                    <td className="font-medium">{e.action}</td>
                    <td className="font-mono text-[12px]">{e.entity}:{e.entityId}</td>
                    <td className="font-mono text-[11px] text-muted">{e.hash.slice(0, 12)}…</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  );
}

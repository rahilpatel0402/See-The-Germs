import { useMemo } from "react";
import type { Analysis } from "../../engine/types.ts";

interface Props {
  readonly analysis: Analysis;
  readonly onSeek: (t: number) => void;
  readonly onHover: (entityId: string | null) => void;
}

const WIDTH = 312;
const ROW_H = 54;
const NODE_W = 92;
const NODE_H = 26;

// Nodes in order of first appearance along the transfer edges, laid out left to right in a
// zigzag so labels stay readable in a narrow drawer. Plain SVG, no library.
export function ChainGraph({ analysis, onSeek, onHover }: Props) {
  const { nodes, edges, height } = useMemo(() => {
    const labels = new Map(analysis.entities.map((e) => [e.id, e]));
    const order: string[] = [analysis.scenario.sourceEntityId];
    for (const e of analysis.propagation.transfers) {
      for (const id of [e.fromId, e.toId]) if (!order.includes(id)) order.push(id);
    }
    const perRow = 3;
    const nodes = order.map((id, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const x = (row % 2 === 0 ? col : perRow - 1 - col) * ((WIDTH - NODE_W) / (perRow - 1)) + NODE_W / 2;
      const y = row * ROW_H + NODE_H / 2 + 6;
      const entity = labels.get(id);
      return { id, x, y, label: entity?.label ?? id, kind: entity?.class ?? "object", contaminated: analysis.propagation.contaminated.includes(id) };
    });
    const pos = new Map(nodes.map((n) => [n.id, n]));
    // One edge per pair, labeled with every transfer time, so repeated transfers do not overlap.
    const grouped = new Map<string, { fromId: string; toId: string; times: number[] }>();
    for (const e of analysis.propagation.transfers) {
      const key = `${e.fromId}>${e.toId}`;
      const g = grouped.get(key) ?? { fromId: e.fromId, toId: e.toId, times: [] };
      g.times.push(e.t);
      grouped.set(key, g);
    }
    const edges = [...grouped.values()].map((g, i) => ({ ...g, i, t: g.times[0] ?? 0, from: pos.get(g.fromId)!, to: pos.get(g.toId)! }));
    const rows = Math.ceil(order.length / perRow);
    return { nodes, edges, height: rows * ROW_H + 12 };
  }, [analysis]);

  const firstTime = (id: string): number | undefined => analysis.propagation.transfers.find((e) => e.toId === id || e.fromId === id)?.t;

  return (
    <svg className="chain-graph" viewBox={`0 0 ${WIDTH} ${height}`} width="100%" height={height} role="img" aria-label="transmission chain graph">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--hot)" />
        </marker>
      </defs>
      {edges.map((e) => {
        const dx = e.to.x - e.from.x;
        const dy = e.to.y - e.from.y;
        const len = Math.hypot(dx, dy) || 1;
        const sx = e.from.x + (dx / len) * (NODE_W / 2 - 4);
        const sy = e.from.y + (dy / len) * (NODE_H / 2);
        const ex = e.to.x - (dx / len) * (NODE_W / 2 + 2);
        const ey = e.to.y - (dy / len) * (NODE_H / 2);
        return (
          <g key={e.i} className="edge" onClick={() => onSeek(e.t)}>
            <line x1={sx} y1={sy} x2={ex} y2={ey} stroke="var(--hot)" strokeWidth={2} markerEnd="url(#arrow)" />
            <text x={(sx + ex) / 2} y={(sy + ey) / 2 - 4} textAnchor="middle" fontSize={10} fill="var(--muted)">
              {e.times.map((t) => `${t.toFixed(1)}s`).join(", ")}
            </text>
          </g>
        );
      })}
      {nodes.map((n) => (
        <g
          key={n.id}
          className={`node ${n.kind}${n.contaminated ? " hot" : ""}`}
          transform={`translate(${n.x - NODE_W / 2} ${n.y - NODE_H / 2})`}
          onMouseEnter={() => onHover(n.id)}
          onMouseLeave={() => onHover(null)}
          onClick={() => {
            const t = firstTime(n.id);
            if (t !== undefined) onSeek(t);
          }}
        >
          <rect width={NODE_W} height={NODE_H} rx={6} />
          <text x={NODE_W / 2} y={NODE_H / 2 + 4} textAnchor="middle" fontSize={11}>
            {n.label.length > 14 ? `${n.label.slice(0, 13)}.` : n.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

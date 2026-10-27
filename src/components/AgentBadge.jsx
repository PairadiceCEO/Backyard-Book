// An AI agent player (0.21.0): the "AI" badge beside the name, and the model label under it.
export function AgentBadge({ agent }) {
  if (!agent?.provider) return null;
  return (
    <span className="badge badge-ai" title={`AI agent (${agent.label || agent.provider})`}>
      AI
    </span>
  );
}

export function AgentLabel({ agent }) {
  if (!agent?.provider) return null;
  return <small className="agent-label muted">{agent.label || agent.provider}</small>;
}

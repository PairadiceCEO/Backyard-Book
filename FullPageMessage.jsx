export default function FullPageMessage({ title, children, actions = null }) {
  return (
    <div className="center-page">
      <div className="card narrow">
        {title ? <h1 className="card-title">{title}</h1> : null}
        <div className="muted">{children}</div>
        {actions ? <div className="card-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

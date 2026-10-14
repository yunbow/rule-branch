import type { ReactNode } from "react";

export function Breadcrumbs({ children }: { children: ReactNode }) {
  return <nav className="breadcrumbs" aria-label="パンくず">{children}</nav>;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  meta,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return <section className="pageHeader">
    <div className="pageHeaderCopy">
      {eyebrow && <p className="pageEyebrow">{eyebrow}</p>}
      <h1 className="pageTitle">{title}</h1>
      {description && <div className="pageLead">{description}</div>}
      {meta && <div className="pageHeaderMeta">{meta}</div>}
    </div>
    {actions && <div className="pageActions">{actions}</div>}
  </section>;
}

export function PageSection({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return <section className={["pageSection", "pageSectionCard", className].filter(Boolean).join(" ")}>
    {(title || description || actions) && <header className="pageSectionHeader">
      <div>
        {title && <h2>{title}</h2>}
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="sectionActions">{actions}</div>}
    </header>}
    {children}
  </section>;
}

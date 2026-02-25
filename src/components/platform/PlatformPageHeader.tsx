import type { ReactNode } from "react";

export function PlatformPageHeader(props: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div className="space-y-1">
        <div className="text-sm text-muted-foreground">Platform Admin</div>
        <h1 className="text-2xl font-extrabold tracking-tight">{props.title}</h1>
        {props.subtitle ? (
          <div className="text-sm text-muted-foreground">{props.subtitle}</div>
        ) : null}
      </div>
      {props.right ? <div>{props.right}</div> : null}
    </div>
  );
}

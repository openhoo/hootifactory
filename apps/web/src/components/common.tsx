import { Check, Copy } from "lucide-react";
import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** Page heading with an optional subtitle and a right-aligned action slot. */
export function PageTitle({
  children,
  description,
  action,
}: {
  children: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight text-balance">
          {children}
        </h1>
        {description && <p className="max-w-prose text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** Copies `value` to the clipboard with a brief confirmation. */
export function CopyButton({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Copy to clipboard"
      className={cn("text-muted-foreground hover:text-foreground", className)}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          toast.success("Copied to clipboard");
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1200);
        } catch {
          toast.error("Couldn't copy — copy it manually");
        }
      }}
    >
      {copied ? <Check className="text-primary" /> : <Copy />}
    </Button>
  );
}

/** A terminal-style code block with a hover-revealed copy control. */
export function Code({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("group/code relative", className)}>
      <pre className="overflow-x-auto rounded-lg border border-border bg-muted/50 py-2.5 pr-11 pl-3 font-mono text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap text-foreground">
        <code>{children}</code>
      </pre>
      <CopyButton
        value={children}
        className="absolute top-1.5 right-1.5 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/code:opacity-100"
      />
    </div>
  );
}

/**
 * A labelled form control. Injects a generated id into its single child so the
 * label is correctly associated for accessibility.
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<{ id?: string }>, { id })
    : children;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {control}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Compact metric tile for the dashboard. */
export function StatCard({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="transition-shadow hover:ring-foreground/15">
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
            {label}
          </span>
          {icon && <span className="text-muted-foreground/70">{icon}</span>}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/** Centered placeholder for empty collections. */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon && (
        <div className="flex size-11 items-center justify-center rounded-xl border border-border bg-muted/50 text-muted-foreground">
          {icon}
        </div>
      )}
      <div className="space-y-1">
        <p className="font-heading text-sm font-medium text-foreground">{title}</p>
        {description && (
          <p className="mx-auto max-w-xs text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

/** Amber, monospaced tag for a registry format (npm, docker, …). */
export function FormatBadge({ format, className }: { format: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 font-mono text-[0.7rem] font-medium text-primary",
        className,
      )}
    >
      {format}
    </span>
  );
}

/** Status pill with a leading dot — neutral / success / danger. */
export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "success" | "danger";
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    neutral: "border-border bg-muted text-muted-foreground",
    success: "border-emerald-600/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    danger: "border-destructive/25 bg-destructive/10 text-destructive",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        tones[tone],
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

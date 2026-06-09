import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

export interface StepperStep {
  id: string;
  title: string;
}

/**
 * Presentational progress indicator for a multi-step flow. Steps before
 * `current` render as done (check), `current` as active, the rest as pending.
 * Purely visual — navigation lives with the parent.
 */
export function Stepper({
  steps,
  current,
  className,
}: {
  steps: StepperStep[];
  current: number;
  className?: string;
}) {
  return (
    <ol role="list" className={cn("flex items-center gap-1.5", className)}>
      {steps.map((step, i) => {
        const state = i < current ? "done" : i === current ? "active" : "pending";
        return (
          <li
            key={step.id}
            aria-current={state === "active" ? "step" : undefined}
            className="flex flex-1 items-center gap-1.5 last:flex-none"
          >
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-xs font-semibold transition-colors",
                state === "active" && "bg-primary text-primary-foreground",
                state === "done" && "bg-primary/15 text-primary",
                state === "pending" && "bg-muted text-muted-foreground",
              )}
            >
              {state === "done" ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span
              className={cn(
                "hidden text-xs font-medium whitespace-nowrap sm:inline",
                state === "pending" ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {step.title}
            </span>
            {i < steps.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  "h-px flex-1 transition-colors",
                  i < current ? "bg-primary/30" : "bg-border",
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

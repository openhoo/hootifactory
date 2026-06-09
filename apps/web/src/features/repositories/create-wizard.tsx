import type { RegistryModuleDto } from "@hootifactory/contracts/legacy";
import { REPO_KINDS, type RepoKind, VISIBILITIES, type Visibility } from "@hootifactory/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Globe, Lock, Search } from "lucide-react";
import {
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { EmptyState, Field, SubmitButton } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Stepper } from "@/components/ui/stepper";
import { Textarea } from "@/components/ui/textarea";
import { useOrg } from "@/features/orgs/context";
import { Loading } from "@/layout/app-shell";
import { ApiError, api, apiErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

// --- pure logic (exported for unit tests) --------------------------------

export type StepId = "format" | "type" | "details" | "review";

export interface RepoFormState {
  moduleId: string;
  kind: RepoKind;
  visibility: Visibility;
  name: string;
  description: string;
}

export const INITIAL_FORM: RepoFormState = {
  moduleId: "",
  kind: "hosted",
  visibility: "private",
  name: "",
  description: "",
};

/** Mirrors the global server-side rule; per-module rules surface as server errors. */
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateStep(
  id: StepId,
  form: RepoFormState,
): Partial<Record<keyof RepoFormState, string>> {
  if (id === "format") {
    return form.moduleId ? {} : { moduleId: "Choose a format to continue." };
  }
  if (id === "details") {
    const errors: Partial<Record<keyof RepoFormState, string>> = {};
    const name = form.name.trim();
    if (!name) errors.name = "Name is required.";
    else if (name.length > 256) errors.name = "Name must be 256 characters or fewer.";
    else if (name.includes("..")) errors.name = "Name cannot contain “..”.";
    else if (!REPO_NAME_RE.test(name))
      errors.name =
        "Use letters, numbers, dots, dashes, or underscores; must start with a letter or number.";
    if (form.description.length > 2048)
      errors.description = "Description must be 2048 characters or fewer.";
    return errors;
  }
  return {};
}

/** Keep the chosen kind only if the (new) module supports it; otherwise reset to hosted. */
export function selectModuleNextKind(
  module: RegistryModuleDto | undefined,
  kind: RepoKind,
): RepoKind {
  if (kind === "proxy" && module?.capabilities.proxyable) return "proxy";
  if (kind === "virtual" && module?.capabilities.virtualizable) return "virtual";
  return "hosted";
}

export function buildCreatePayload(form: RepoFormState): Record<string, unknown> {
  const description = form.description.trim();
  return {
    name: form.name.trim(),
    moduleId: form.moduleId,
    kind: form.kind,
    visibility: form.visibility,
    ...(description ? { description } : {}),
  };
}

// --- presentation constants ----------------------------------------------

const STEPS: { id: StepId; title: string; subtitle: string }[] = [
  { id: "format", title: "Format", subtitle: "Choose the registry format for this repository." },
  {
    id: "type",
    title: "Type",
    subtitle: "Pick how this repository serves artifacts and who can see it.",
  },
  {
    id: "details",
    title: "Details",
    subtitle: "Name your repository and add an optional description.",
  },
  { id: "review", title: "Review", subtitle: "Confirm the details and create your repository." },
];
const DETAILS_INDEX = STEPS.findIndex((s) => s.id === "details");

const KIND_LABEL: Record<RepoKind, string> = {
  hosted: "Hosted",
  proxy: "Proxy",
  virtual: "Virtual",
};
const KIND_DESC: Record<RepoKind, string> = {
  hosted: "Store artifacts published directly to this repository.",
  proxy: "Cache and serve artifacts from a remote upstream.",
  virtual: "Aggregate several repositories behind one endpoint.",
};
const VIS_DESC: Record<Visibility, string> = {
  private: "Only members of your organization can access it.",
  public: "Anyone can read; members can publish.",
};

function kindAvailability(
  module: RegistryModuleDto | undefined,
): Record<RepoKind, { available: boolean; reason?: string }> {
  return {
    hosted: { available: true },
    proxy: {
      available: !!module?.capabilities.proxyable,
      reason: "This format doesn’t support proxy (pull-through) repositories.",
    },
    virtual: {
      available: !!module?.capabilities.virtualizable,
      reason: "This format doesn’t support virtual (aggregated) repositories.",
    },
  };
}

const CARD_BASE =
  "rounded-lg border px-3 py-2.5 transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50";
const CARD_SELECTED = "border-primary/50 bg-primary/5";
const CARD_IDLE = "border-input hover:border-primary/40 hover:bg-muted/50";

// --- component -----------------------------------------------------------

export function CreateRepositoryWizard({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { selected } = useOrg();
  const qc = useQueryClient();
  const modules = useQuery({
    queryKey: ["registry-modules"],
    queryFn: () => api.registryModules(),
  });
  const moduleOptions = modules.data?.modules ?? [];

  const [step, setStep] = useState(0);
  const [form, setForm] = useState<RepoFormState>(INITIAL_FORM);
  const [serverError, setServerError] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [query, setQuery] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);

  const create = useMutation({
    mutationFn: () => api.createRepo(selected!.id, buildCreatePayload(form)),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ["repos", selected?.id] });
      toast.success(`Repository “${res.repository.name}” created`);
      onOpenChange(false);
    },
    onError: (e) => {
      setServerError(apiErrorMessage(e));
      // Name conflicts / per-module name-policy rejections belong to the Details step.
      if (e instanceof ApiError && [400, 409, 422].includes(e.status)) setStep(DETAILS_INDEX);
      setShowErrors(true);
    },
  });

  // Move focus to the first control whenever the visible step changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-focus on step change, not form edits.
  useEffect(() => {
    if (!open) return;
    bodyRef.current
      ?.querySelector<HTMLElement>("input, textarea, [role='radio']:not([disabled])")
      ?.focus();
  }, [step, open]);

  function reset() {
    setStep(0);
    setForm(INITIAL_FORM);
    setServerError("");
    setShowErrors(false);
    setQuery("");
    create.reset();
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function setModule(id: string) {
    setForm((f) => {
      const module = moduleOptions.find((m) => m.id === id);
      return { ...f, moduleId: id, kind: selectModuleNextKind(module, f.kind) };
    });
  }

  const currentStep = STEPS[step]!;
  const errors = validateStep(currentStep.id, form);
  const isLast = step === STEPS.length - 1;
  const formatBlocked =
    currentStep.id === "format" &&
    (modules.isLoading || modules.isError || moduleOptions.length === 0);

  function goNext() {
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      return;
    }
    setServerError("");
    setShowErrors(false);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function goBack() {
    setServerError("");
    setShowErrors(false);
    setStep((s) => Math.max(s - 1, 0));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!isLast) {
      goNext();
      return;
    }
    if (create.isPending || !selected) return;
    create.mutate();
  }

  const selectedModule = moduleOptions.find((m) => m.id === form.moduleId);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="repo-create-dialog">
        <DialogHeader>
          <DialogTitle>New repository</DialogTitle>
          <DialogDescription>{currentStep.subtitle}</DialogDescription>
        </DialogHeader>

        <Stepper steps={STEPS} current={step} />

        {/* `display:contents` keeps body + footer participating in the dialog's grid spacing. */}
        <form onSubmit={handleSubmit} className="contents">
          <div ref={bodyRef} className="min-h-[19rem] py-1">
            {currentStep.id === "format" &&
              renderFormatStep({
                modules,
                moduleOptions,
                query,
                setQuery,
                value: form.moduleId,
                onSelect: setModule,
                error: showErrors ? errors.moduleId : undefined,
              })}
            {currentStep.id === "type" &&
              renderTypeStep({
                form,
                setForm,
                module: selectedModule,
              })}
            {currentStep.id === "details" &&
              renderDetailsStep({
                form,
                setForm,
                errors: showErrors ? errors : {},
                serverError,
              })}
            {currentStep.id === "review" &&
              renderReviewStep({ form, module: selectedModule, serverError })}
          </div>

          <DialogFooter showCloseButton={false}>
            {step > 0 ? (
              <Button type="button" variant="outline" onClick={goBack} data-testid="repo-step-back">
                Back
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
            )}
            {isLast ? (
              <SubmitButton pending={create.isPending} data-testid="repo-create">
                Create repository
              </SubmitButton>
            ) : (
              <Button type="submit" data-testid="repo-step-next" disabled={formatBlocked}>
                Next
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- step bodies (plain render functions — NOT components, to avoid remounts) ---

function renderFormatStep({
  modules,
  moduleOptions,
  query,
  setQuery,
  value,
  onSelect,
  error,
}: {
  modules: { isLoading: boolean; isError: boolean; refetch: () => unknown };
  moduleOptions: RegistryModuleDto[];
  query: string;
  setQuery: (q: string) => void;
  value: string;
  onSelect: (id: string) => void;
  error?: string;
}): ReactNode {
  if (modules.isLoading) return <Loading />;
  if (modules.isError)
    return (
      <EmptyState
        icon={<Boxes className="size-5" />}
        title="Couldn't load formats"
        description="Check your connection or permissions and try again."
        action={
          <Button variant="outline" size="sm" onClick={() => modules.refetch()}>
            Retry
          </Button>
        }
      />
    );
  if (moduleOptions.length === 0)
    return (
      <EmptyState
        icon={<Boxes className="size-5" />}
        title="No formats installed"
        description="An operator needs to enable at least one registry module."
      />
    );

  const q = query.trim().toLowerCase();
  const filtered = q
    ? moduleOptions.filter(
        (m) => m.displayName.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
      )
    : moduleOptions;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search formats…"
          className="h-9 pl-8"
          aria-label="Search formats"
          data-testid="repo-format-search"
        />
      </div>
      {filtered.length ? (
        <RadioGroup
          value={value}
          onValueChange={onSelect}
          aria-label="Registry format"
          className="grid max-h-[18rem] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3"
        >
          {filtered.map((m) => (
            <label
              key={m.id}
              htmlFor={`repo-format-radio-${m.id}`}
              data-testid={`repo-format-${m.id}`}
              className={cn(
                "flex cursor-pointer flex-col gap-0.5",
                CARD_BASE,
                value === m.id ? CARD_SELECTED : CARD_IDLE,
              )}
            >
              <RadioGroupItem id={`repo-format-radio-${m.id}`} value={m.id} className="sr-only" />
              <span className="text-sm font-medium">{m.displayName}</span>
              <span className="font-mono text-xs text-muted-foreground">{m.mountSegment}</span>
            </label>
          ))}
        </RadioGroup>
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No formats match “{query}”.
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function renderTypeStep({
  form,
  setForm,
  module,
}: {
  form: RepoFormState;
  setForm: Dispatch<SetStateAction<RepoFormState>>;
  module: RegistryModuleDto | undefined;
}): ReactNode {
  const avail = kindAvailability(module);
  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Repository type</legend>
        <RadioGroup
          value={form.kind}
          onValueChange={(v) => setForm((f) => ({ ...f, kind: v as RepoKind }))}
          aria-label="Repository type"
        >
          {REPO_KINDS.map((kind) => {
            const { available, reason } = avail[kind];
            const checked = form.kind === kind;
            return (
              <label
                key={kind}
                htmlFor={`repo-kind-radio-${kind}`}
                data-testid={`repo-kind-${kind}`}
                aria-disabled={!available || undefined}
                className={cn(
                  "flex items-start gap-3",
                  CARD_BASE,
                  !available
                    ? "cursor-not-allowed border-input opacity-60"
                    : cn("cursor-pointer", checked ? CARD_SELECTED : CARD_IDLE),
                )}
              >
                <RadioGroupItem
                  id={`repo-kind-radio-${kind}`}
                  value={kind}
                  disabled={!available}
                  className="mt-0.5"
                />
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium">{KIND_LABEL[kind]}</span>
                  <span className="block text-xs text-muted-foreground">
                    {available ? KIND_DESC[kind] : reason}
                  </span>
                </span>
              </label>
            );
          })}
        </RadioGroup>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-medium">Visibility</legend>
        <RadioGroup
          value={form.visibility}
          onValueChange={(v) => setForm((f) => ({ ...f, visibility: v as Visibility }))}
          aria-label="Visibility"
          className="grid-cols-2"
        >
          {VISIBILITIES.map((vis) => {
            const checked = form.visibility === vis;
            return (
              <label
                key={vis}
                htmlFor={`repo-visibility-radio-${vis}`}
                data-testid={`repo-visibility-${vis}`}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5",
                  CARD_BASE,
                  checked ? CARD_SELECTED : CARD_IDLE,
                )}
              >
                <RadioGroupItem
                  id={`repo-visibility-radio-${vis}`}
                  value={vis}
                  className="mt-0.5"
                />
                <span className="space-y-0.5">
                  <span className="flex items-center gap-1.5 text-sm font-medium capitalize">
                    {vis === "public" ? (
                      <Globe className="size-3.5" />
                    ) : (
                      <Lock className="size-3.5" />
                    )}
                    {vis}
                  </span>
                  <span className="block text-xs text-muted-foreground">{VIS_DESC[vis]}</span>
                </span>
              </label>
            );
          })}
        </RadioGroup>
      </fieldset>
    </div>
  );
}

function renderDetailsStep({
  form,
  setForm,
  errors,
  serverError,
}: {
  form: RepoFormState;
  setForm: Dispatch<SetStateAction<RepoFormState>>;
  errors: Partial<Record<keyof RepoFormState, string>>;
  serverError: string;
}): ReactNode {
  return (
    <div className="space-y-4">
      {serverError && (
        <p className="text-sm text-destructive" role="alert" data-testid="repo-create-error">
          {serverError}
        </p>
      )}
      <div className="space-y-1.5">
        <Field label="Name" hint="Letters, numbers, dots, dashes, and underscores.">
          <Input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="my-repository"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!errors.name}
            data-testid="repo-name"
          />
        </Field>
        {errors.name && (
          <p className="text-sm text-destructive" role="alert">
            {errors.name}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Field label="Description" hint="Optional.">
          <Textarea
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="What is this repository for?"
            rows={3}
            aria-invalid={!!errors.description}
            data-testid="repo-description"
          />
        </Field>
        {errors.description && (
          <p className="text-sm text-destructive" role="alert">
            {errors.description}
          </p>
        )}
      </div>
    </div>
  );
}

function renderReviewStep({
  form,
  module,
  serverError,
}: {
  form: RepoFormState;
  module: RegistryModuleDto | undefined;
  serverError: string;
}): ReactNode {
  const rows: { label: string; value: ReactNode }[] = [
    { label: "Format", value: module?.displayName ?? form.moduleId },
    { label: "Type", value: KIND_LABEL[form.kind] },
    { label: "Visibility", value: <span className="capitalize">{form.visibility}</span> },
    { label: "Name", value: <span className="font-mono">{form.name.trim()}</span> },
  ];
  const description = form.description.trim();
  if (description) rows.push({ label: "Description", value: description });

  return (
    <div className="space-y-3">
      <dl className="divide-y divide-border rounded-lg border border-border">
        {rows.map((r) => (
          <div key={r.label} className="flex items-start justify-between gap-4 px-3 py-2.5">
            <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {r.label}
            </dt>
            <dd className="text-right text-sm break-all">{r.value}</dd>
          </div>
        ))}
      </dl>
      {serverError && (
        <p className="text-sm text-destructive" role="alert" data-testid="repo-create-error">
          {serverError}
        </p>
      )}
    </div>
  );
}

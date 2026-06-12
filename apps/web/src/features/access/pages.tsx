import { KeyRound, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Code, PageTitle } from "@/components/common";
import { Button } from "@/components/ui/button";
import { useOrg } from "@/features/orgs/context";
import { GroupsSection } from "./groups-section";
import { OrgMembersSection } from "./org-members-section";
import { UsersSection } from "./users-section";

export function AccessPage() {
  const { selected } = useOrg();
  const [temporaryPassword, setTemporaryPassword] = useState("");

  // The org switcher swaps the active org without remounting this page, so clear
  // the one-time temporary password when the selected org changes. The sections
  // below are keyed by org id, so their own state resets on the same switch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: selected?.id is the intentional reset trigger, not read in the body.
  useEffect(() => {
    setTemporaryPassword("");
  }, [selected?.id]);

  return (
    <div>
      <PageTitle description={selected ? `${selected.displayName} access controls.` : undefined}>
        Access
      </PageTitle>

      {temporaryPassword && (
        <div className="mb-4 rounded-lg border border-primary/30 bg-primary/5 p-3.5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-xs font-medium text-primary">
              <KeyRound className="size-3.5" />
              Temporary password
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setTemporaryPassword("")}
              aria-label="Clear temporary password"
            >
              <X />
            </Button>
          </div>
          <Code>{temporaryPassword}</Code>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <UsersSection key={`users-${selected?.id}`} onTemporaryPassword={setTemporaryPassword} />
        <OrgMembersSection key={`members-${selected?.id}`} />
      </div>

      <GroupsSection key={`groups-${selected?.id}`} />
    </div>
  );
}

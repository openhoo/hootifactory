import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { api, type Org } from "@/lib/api";

export interface OrgContextValue {
  orgs: Org[];
  selected: Org | null;
  setOrgId: (id: string) => void;
}

export const OrgContext = createContext<OrgContextValue>({
  orgs: [],
  selected: null,
  setOrgId: () => {},
});

export function useOrg() {
  return useContext(OrgContext);
}

export function useRepos() {
  const { selected } = useOrg();
  return useQuery({
    queryKey: ["repos", selected?.id],
    queryFn: () => api.repos(selected!.id),
    enabled: !!selected,
  });
}

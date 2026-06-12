import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { api, type Org, type PaginationQuery } from "@/lib/api";

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

export function useRepos(query?: PaginationQuery) {
  const { selected } = useOrg();
  return useQuery({
    queryKey: ["repos", selected?.id, query?.limit, query?.offset],
    queryFn: () => api.repos(selected!.id, query),
    enabled: !!selected,
  });
}

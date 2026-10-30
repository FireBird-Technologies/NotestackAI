import { billingApi } from "@notestack/shared/endpoints";

/** The plan and its meters; kept a minute before it is asked for again. */
export const planQuery = { queryKey: ["billing", "status"], queryFn: billingApi.status, staleTime: 60_000 } as const;

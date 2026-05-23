import type { ApiClient } from "@/lib/api";

/**
 * Global search service — backs the Command Palette (Epic #364, GLO-001).
 *
 * Wire format follows the Givernance `{ data: ... }` envelope. The shape
 * mirrors `packages/api/src/modules/search/service.ts` SearchResult.
 */

export interface SearchHit {
  type: "constituent" | "campaign" | "donation";
  id: string;
  title: string;
  subtitle: string;
  /** Path relative to the app root, no host, no locale prefix. */
  href: string;
}

export interface SearchGroups {
  constituents: SearchHit[];
  campaigns: SearchHit[];
  donations: SearchHit[];
}

export interface SearchResult {
  query: string;
  groups: SearchGroups;
}

interface SearchResponse {
  data: SearchResult;
}

export const SearchService = {
  async search(client: ApiClient, q: string, signal?: AbortSignal): Promise<SearchResult> {
    const response = await client.get<SearchResponse>("/v1/search", {
      params: { q },
      signal,
    });
    return response.data;
  },
};

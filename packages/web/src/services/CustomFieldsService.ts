/**
 * Custom-fields admin service (Epic #539) — the `/v1/custom-fields`
 * management surface behind `/settings/custom-fields`.
 *
 * Every mapper is an explicit field-by-field copy (drops unknown props) and
 * tolerant of envelope variants (`data: []` vs `data: {definitions: []}`) so
 * the page keeps rendering while the API module stabilises. Mutations go
 * through `createClientApiClient()` — CSRF is automatic.
 */

import type { ApiClient } from "@/lib/api";
import type {
  ArchivedCustomFieldDefinition,
  CustomFieldCatalog,
  CustomFieldCreateInput,
  CustomFieldDefinition,
  CustomFieldDomain,
  CustomFieldOption,
  CustomFieldOptionCreateInput,
  CustomFieldOptionUpdateInput,
  CustomFieldQuotaInfo,
  CustomFieldUpdateInput,
  CustomFieldUsage,
  CustomFieldUsageRow,
  OptionMergeDryRun,
  OptionMergeResult,
} from "@/models/custom-field";

interface DetailResponse {
  data: unknown;
}

export const CustomFieldsService = {
  /**
   * Admin catalog for one domain: active definitions (sortOrder-ordered),
   * archived definitions, effective quotas, catalog version.
   */
  async getCatalog(client: ApiClient, domain: CustomFieldDomain): Promise<CustomFieldCatalog> {
    const response = await client.get<DetailResponse>("/v1/custom-fields", {
      params: { domain, includeArchived: true },
    });
    return mapCatalog(response.data, domain);
  },

  /**
   * On-demand usage stats (fill rate + per-option counts) plus the
   * effective quotas for the domain. Counts under 5 arrive masked as
   * `'< 5'` strings — mapped to `null` here; k-anonymity is enforced
   * server-side.
   */
  async getUsage(client: ApiClient, domain: CustomFieldDomain): Promise<CustomFieldUsage> {
    const response = await client.get<DetailResponse>("/v1/custom-fields/usage", {
      params: { domain },
    });
    return mapUsage(response.data, domain);
  },

  async createField(
    client: ApiClient,
    input: CustomFieldCreateInput,
  ): Promise<CustomFieldDefinition> {
    const response = await client.post<DetailResponse>("/v1/custom-fields", toCreateBody(input));
    return mapDefinitionOrThrow(response.data);
  },

  async updateField(
    client: ApiClient,
    id: string,
    input: CustomFieldUpdateInput,
  ): Promise<CustomFieldDefinition> {
    const response = await client.patch<DetailResponse>(
      `/v1/custom-fields/${encodeURIComponent(id)}`,
      toUpdateBody(input),
    );
    return mapDefinitionOrThrow(response.data);
  },

  /** Soft-archive — values are retained, the definition leaves every surface. */
  async archiveField(client: ApiClient, id: string): Promise<void> {
    await client.delete(`/v1/custom-fields/${encodeURIComponent(id)}`);
  },

  async restoreField(client: ApiClient, id: string): Promise<CustomFieldDefinition> {
    const response = await client.post<DetailResponse>(
      `/v1/custom-fields/${encodeURIComponent(id)}/restore`,
      {},
    );
    return mapDefinitionOrThrow(response.data);
  },

  /** Bulk sort-order — `ids` is the full active list in its new order. */
  async reorderFields(client: ApiClient, domain: CustomFieldDomain, ids: string[]): Promise<void> {
    await client.post("/v1/custom-fields/reorder", { domain, ids });
  },

  async addOption(
    client: ApiClient,
    definitionId: string,
    input: CustomFieldOptionCreateInput,
  ): Promise<CustomFieldDefinition> {
    // The API mints the stable option id server-side — only the label is
    // accepted; a client-generated id (create-mode local state) is dropped.
    const response = await client.post<DetailResponse>(
      `/v1/custom-fields/${encodeURIComponent(definitionId)}/options`,
      { label: input.label },
    );
    return mapDefinitionOrThrow(response.data);
  },

  /** Rename-in-place / deactivate / reactivate / reorder one option. */
  async updateOption(
    client: ApiClient,
    definitionId: string,
    optionId: string,
    input: CustomFieldOptionUpdateInput,
  ): Promise<CustomFieldDefinition> {
    const body: Record<string, unknown> = {};
    if (input.label !== undefined) body.label = input.label;
    if (input.active !== undefined) body.active = input.active;
    if (input.sortOrder !== undefined) body.sortOrder = input.sortOrder;
    const response = await client.patch<DetailResponse>(
      `/v1/custom-fields/${encodeURIComponent(definitionId)}/options/${encodeURIComponent(optionId)}`,
      body,
    );
    return mapDefinitionOrThrow(response.data);
  },

  /** Affected-row preview — no writes happen on a dry run. */
  async mergeOptionDryRun(
    client: ApiClient,
    definitionId: string,
    optionId: string,
    targetOptionId: string,
  ): Promise<OptionMergeDryRun> {
    const response = await client.post<DetailResponse>(
      `/v1/custom-fields/${encodeURIComponent(definitionId)}/options/${encodeURIComponent(optionId)}/merge`,
      { targetOptionId },
      { params: { dryRun: "true" } },
    );
    const raw = asRecord(response.data);
    return { affectedCount: typeof raw?.affectedCount === "number" ? raw.affectedCount : 0 };
  },

  /** Real merge — 202: idempotent chunked backfill job + 30-day undo rows. */
  async mergeOption(
    client: ApiClient,
    definitionId: string,
    optionId: string,
    targetOptionId: string,
  ): Promise<OptionMergeResult> {
    const response = await client.post<DetailResponse>(
      `/v1/custom-fields/${encodeURIComponent(definitionId)}/options/${encodeURIComponent(optionId)}/merge`,
      { targetOptionId },
    );
    const raw = asRecord(response.data);
    return {
      mergeId: typeof raw?.mergeId === "string" ? raw.mergeId : null,
      affectedCount: typeof raw?.affectedCount === "number" ? raw.affectedCount : null,
      undoExpiresAt: typeof raw?.undoExpiresAt === "string" ? raw.undoExpiresAt : null,
    };
  },

  /**
   * Reverts a merge inside its 30-day window — 202: the source option is
   * active again and the worker restores pre-merge values asynchronously.
   */
  async undoMergeOption(
    client: ApiClient,
    definitionId: string,
    optionId: string,
    mergeId: string,
  ): Promise<void> {
    await client.post(
      `/v1/custom-fields/${encodeURIComponent(definitionId)}/options/${encodeURIComponent(optionId)}/merge/${encodeURIComponent(mergeId)}/undo`,
      {},
    );
  },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mapOption(raw: unknown): CustomFieldOption | null {
  const record = asRecord(raw);
  if (!record || typeof record.id !== "string" || typeof record.label !== "string") return null;
  return {
    id: record.id,
    label: record.label,
    active: record.active !== false,
    sortOrder: typeof record.sortOrder === "number" ? record.sortOrder : 0,
    ...(typeof record.mergedInto === "string" ? { mergedInto: record.mergedInto } : {}),
    ...(typeof record.mergeId === "string" ? { mergeId: record.mergeId } : {}),
    ...(typeof record.mergedAt === "string" ? { mergedAt: record.mergedAt } : {}),
  };
}

function mapDefinition(raw: unknown): CustomFieldDefinition | null {
  const record = asRecord(raw);
  if (
    !record ||
    typeof record.id !== "string" ||
    typeof record.domain !== "string" ||
    typeof record.key !== "string" ||
    typeof record.label !== "string" ||
    typeof record.type !== "string"
  ) {
    return null;
  }
  return {
    id: record.id,
    domain: record.domain as CustomFieldDomain,
    key: record.key,
    label: record.label,
    description: typeof record.description === "string" ? record.description : null,
    type: record.type as CustomFieldDefinition["type"],
    options: Array.isArray(record.options)
      ? record.options.map(mapOption).filter((o): o is CustomFieldOption => o !== null)
      : [],
    sortOrder: typeof record.sortOrder === "number" ? record.sortOrder : 0,
    required: record.required === true,
    filterable: record.filterable === true,
    exportable: record.exportable !== false,
    showOnRelated: record.showOnRelated === true,
    sensitive: record.sensitive === true,
    purposeText: typeof record.purposeText === "string" ? record.purposeText : null,
  };
}

function mapDefinitionOrThrow(payload: unknown): CustomFieldDefinition {
  const definition = mapDefinition(payload);
  if (!definition) {
    throw new Error("Malformed custom-field definition payload");
  }
  return definition;
}

function mapArchived(raw: unknown): ArchivedCustomFieldDefinition | null {
  const definition = mapDefinition(raw);
  if (!definition) return null;
  const record = asRecord(raw);
  return {
    ...definition,
    archivedAt: typeof record?.archivedAt === "string" ? record.archivedAt : "",
  };
}

/** Usage-endpoint quotas: `{ limit, used }` objects → the flat limit numbers. */
function mapQuotas(raw: unknown): CustomFieldQuotaInfo | null {
  const record = asRecord(raw);
  const fieldsPerDomain = asRecord(record?.fieldsPerDomain);
  const optionsPerPicklist = asRecord(record?.optionsPerPicklist);
  const showOnRelatedFields = asRecord(record?.showOnRelatedFields);
  if (
    typeof fieldsPerDomain?.limit !== "number" ||
    typeof optionsPerPicklist?.limit !== "number" ||
    typeof showOnRelatedFields?.limit !== "number"
  ) {
    return null;
  }
  return {
    fieldsPerDomain: fieldsPerDomain.limit,
    optionsPerPicklist: optionsPerPicklist.limit,
    showOnRelatedFields: showOnRelatedFields.limit,
  };
}

/**
 * `GET /v1/custom-fields?includeArchived=true` answers a FLAT definition
 * array — archived rows ride along with `archivedAt` set. Partition on
 * that marker; both halves keep the admin `sortOrder` ordering.
 */
function mapCatalog(payload: unknown, domain: CustomFieldDomain): CustomFieldCatalog {
  const list = Array.isArray(payload) ? payload : [];
  const active: CustomFieldDefinition[] = [];
  const archived: ArchivedCustomFieldDefinition[] = [];
  for (const raw of list) {
    const record = asRecord(raw);
    if (typeof record?.archivedAt === "string" && record.archivedAt !== "") {
      const definition = mapArchived(raw);
      if (definition && definition.domain === domain) archived.push(definition);
    } else {
      const definition = mapDefinition(raw);
      if (definition && definition.domain === domain) active.push(definition);
    }
  }
  active.sort((a, b) => a.sortOrder - b.sortOrder);
  archived.sort((a, b) => a.sortOrder - b.sortOrder);
  // The catalog GET carries neither quotas nor an explicit version — quotas
  // come from `/usage`; the definitions' updatedAt set stands in as a
  // client-state reset key.
  const versionKey = list
    .map((raw) => {
      const record = asRecord(raw);
      return typeof record?.updatedAt === "string" ? record.updatedAt : "";
    })
    .join("|");
  return {
    definitions: active,
    archived,
    quotas: null,
    catalogVersion: versionKey === "" ? null : versionKey,
  };
}

/** Masked counts arrive as `'< 5'`; exact counts as digit strings. */
function parseMaskableCount(raw: unknown): number | null {
  return typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : null;
}

function mapUsageField(raw: unknown): CustomFieldUsageRow | null {
  const record = asRecord(raw);
  if (!record || typeof record.id !== "string" || typeof record.key !== "string") {
    return null;
  }
  const options = Array.isArray(record.options)
    ? record.options
        .map((entry) => {
          const option = asRecord(entry);
          if (!option || typeof option.id !== "string") return null;
          return { optionId: option.id, count: parseMaskableCount(option.count) };
        })
        .filter((o): o is CustomFieldUsageRow["options"][number] => o !== null)
    : [];
  return {
    definitionId: record.id,
    key: record.key,
    // API reports percent (0–100); the UI renders from a [0, 1] rate.
    fillRate: typeof record.fillRatePercent === "number" ? record.fillRatePercent / 100 : null,
    filledCount: parseMaskableCount(record.filled),
    options,
  };
}

/**
 * `GET /v1/custom-fields/usage` answers one group per enabled domain:
 * `{ domain, totalRows, quotas, fields }`. Pick the requested domain's
 * group and flatten it.
 */
function mapUsage(payload: unknown, domain: CustomFieldDomain): CustomFieldUsage {
  const groups = Array.isArray(payload) ? payload : [];
  const group = groups.map(asRecord).find((entry) => entry?.domain === domain);
  const fields = Array.isArray(group?.fields) ? group.fields : [];
  return {
    rows: fields.map(mapUsageField).filter((r): r is CustomFieldUsageRow => r !== null),
    quotas: mapQuotas(group?.quotas),
  };
}

function toCreateBody(input: CustomFieldCreateInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    domain: input.domain,
    key: input.key,
    label: input.label,
    type: input.type,
  };
  if (input.description !== undefined) body.description = input.description;
  // Option ids are minted server-side — the create body carries labels only.
  if (input.options !== undefined) body.options = input.options.map((o) => ({ label: o.label }));
  if (input.required !== undefined) body.required = input.required;
  if (input.filterable !== undefined) body.filterable = input.filterable;
  if (input.exportable !== undefined) body.exportable = input.exportable;
  if (input.showOnRelated !== undefined) body.showOnRelated = input.showOnRelated;
  if (input.sensitive !== undefined) body.sensitive = input.sensitive;
  if (input.purposeText !== undefined) body.purposeText = input.purposeText;
  return body;
}

function toUpdateBody(input: CustomFieldUpdateInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.label !== undefined) body.label = input.label;
  if (input.description !== undefined) body.description = input.description;
  if (input.required !== undefined) body.required = input.required;
  if (input.filterable !== undefined) body.filterable = input.filterable;
  if (input.exportable !== undefined) body.exportable = input.exportable;
  if (input.showOnRelated !== undefined) body.showOnRelated = input.showOnRelated;
  if (input.sensitive !== undefined) body.sensitive = input.sensitive;
  if (input.purposeText !== undefined) body.purposeText = input.purposeText;
  return body;
}

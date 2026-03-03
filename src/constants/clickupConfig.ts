// src/constants/clickupConfig.ts

// Workspace / team and space (override via env CLICKUP_SPACE_ID if your space is different)
export const CU_TEAM_ID  = '90182255856';      // Workspace (team) ID
export const CU_SPACE_ID = process.env.CLICKUP_SPACE_ID || '901810032596';  // "Concrete Truck Schedule" fallback

// Custom field IDs
export const CU_FIELD_ID                  = '652549c7-f380-48d5-b58e-9e4dfa977cd5';
export const CU_FIELD_TRUCK_LICENSE       = '9771090f-b05e-45d2-bfc3-d3a9df3e5cd6';

export const CU_FIELD_CONCRETE_PLANT      = '8b03bf5e-d755-4866-9015-f54830e8211b';
export const CU_FIELD_M3_PER_TRUCK        = '502dbd1c-2b2b-4d49-9af9-02761b92b986';
export const CU_FIELD_TIME_PERIOD         = 'e6bbbaa1-8475-4072-972d-7c21266277fd';
export const CU_FIELD_PLANNED_ARRIVAL_TXT = '58a5683c-460e-4903-aacb-e0ad338994ff';
export const CU_FIELD_PLANNED_ARRIVAL_DT  = '60ba3f48-7d97-49e9-a2c7-aa7e11ba45ac';

export const CU_FIELD_ESTIMATED_ARRIVAL   = 'e8859982-29d6-46ed-bde0-6e4de94cd627';
export const CU_FIELD_ACTUAL_DEPARTURE    = '1d3dd57d-1ac9-4cc7-ad15-dcd0f31ff1d7';
export const CU_FIELD_ACTUAL_ARRIVAL      = '40b45d8d-0251-4bc2-84fd-507ff157ce1f';

/** ClickUp status values that mean "trip ended" (only Arrived counts for actual progress). */
export const CU_STATUS_ENDED = ['rejected', 'not used', 'arrived', 'complete', 'closed'] as const;

export const CU_FIELD_TRUCK_DEPART_FLAG   = 'a131e508-c9e4-47a0-bc8f-3bca4bfbea51';
export const CU_FIELD_TRUCK_ARRIVE_FLAG   = '03e2f16f-6eec-44c8-a213-00cf17b34f12';

export const CU_FIELD_REMARK              = '813635ab-3536-4e85-b276-34e4ab6d67d1';
export const CU_FIELD_CONCRETE_GRADE      = 'e797450b-b238-49b7-8ca8-985435ad5392';

// Concrete plant options (for mapping to pathId)
export const CU_OPT_GAMMON_TM             = '08c16118-ef08-44f4-a200-468037cd8b70';
export const CU_OPT_HKC_TY                = '0f4616b1-81bc-4ec8-addc-d4bedeb239eb';

// Default list when no name/description match (e.g. 20260226_Zone1)
export const CU_DEFAULT_LIST_ID = '901816296677';

/** List name format for operation day: name must start with YYYYMMDD (e.g. 20260226_Zone1). */
export const CU_LIST_NAME_DATE_PREFIX = true;

/** Time Period dropdown: option id → label (HH:MM-HH:MM) for resolving planned-by-period. */
export const CU_TIME_PERIOD_OPTIONS: Record<string, string> = {
  '15932ad0-2d74-4d72-a633-71fe09f56d54': '06:00-07:00',
  '26c93f69-5b10-4ffe-97e3-4362f7e7857f': '07:00-08:00',
  'fa653f6f-22eb-431f-ad53-7d847a909dbb': '08:00-09:00',
  'e955d4e9-4e20-4367-aaf9-01ce86669c17': '09:00-10:00',
  'a0aed9f0-7278-423a-9b80-f60bfa6e0535': '10:00-11:00',
  '80f32a59-9b8d-41c3-9901-3d210d921edc': '11:00-12:00',
  '200d0b23-2193-4fdd-b688-f1353e7849d9': '12:00-13:00',
  'e4597797-48b0-4c85-af0a-cec5e1ea43a3': '13:00-14:00',
  '1ce14144-58e4-42ba-8713-53c8c3e4d943': '14:00-15:00',
  'a8240730-40e1-407e-874f-033c156d73c3': '15:00-16:00',
  '87ef48c6-5347-4b80-86b1-9fc93955a6ac': '16:00-17:00',
  '937a572b-c8f6-4155-ba5f-9f3f13010d06': '17:00-18:00',
  '1c720dee-b624-45ab-ac36-84bcb69a1d7f': '18:00-19:00',
  'da674163-aa01-4870-a4b2-6d86d915a496': '19:00-20:00',
  '74cd70eb-940e-46a0-bab8-f18b9eeb5734': '20:00-21:00',
  'f93d9a72-4cc6-4b21-aa9a-fab4db4f7214': '21:00-22:00',
};

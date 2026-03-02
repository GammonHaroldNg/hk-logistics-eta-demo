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

- Add usage fetcher for Muse Code (Meta). Meta exposes no usage/balance API, so
  `getMuseUsage()` returns the subscription tier captured at auth time
  (`subsTierName`, `subsTierId`, `isSubsActive`, `hasPaymentMethod`) from
  `providerSpecificData` with no used/total figures. Registered in
  `USAGE_FETCHER_PROVIDERS` so the quota dashboard can surface Muse Code
  subscription info instead of "not implemented". planRegistry already treats
  `muse-code` as `Number.EPSILON` (unknown, set manually in Wizard "Limite").

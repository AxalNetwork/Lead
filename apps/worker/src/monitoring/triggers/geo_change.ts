import type { EvaluatorFn } from "../types";

export const evalGeoChange: EvaluatorFn = async (ctx) => {
  const cityD = ctx.diff.find((d) => d.field === "city");
  const countryD = ctx.diff.find((d) => d.field === "country");
  if (!cityD && !countryD) return null;
  const newCity = ctx.newSummary.city ?? "∅";
  const newCountry = ctx.newSummary.country ?? "∅";
  return {
    dedupe_key: `${newCity}|${newCountry}`,
    title: `${ctx.newSummary.display_name ?? ctx.entityId} moved to ${newCity}, ${newCountry}`,
    body: `Location changed — city: ${ctx.oldSummary?.city ?? "∅"} → ${newCity}; country: ${ctx.oldSummary?.country ?? "∅"} → ${newCountry}.`,
    diff: [cityD, countryD].filter((d): d is NonNullable<typeof d> => !!d),
    payload: {
      old_city: ctx.oldSummary?.city, new_city: newCity,
      old_country: ctx.oldSummary?.country, new_country: newCountry,
    },
  };
};

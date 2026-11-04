// Pathogen rules table, values exactly as PLAN.md 6.3. Do not add a pathogen or change an
// effectiveness rule without Rahil confirming it. Every citation below was opened on Nov 4,
// 2026 and the statement the rule rests on was read on the page; the quoted phrase is in the
// README's pathogen table. No citation is added from memory.

// Shared sources: CDC hand hygiene guidance for healthcare workers (alcohol-based hand sanitizer
// preferred in most clinical situations; soap and water during C. difficile and norovirus
// outbreaks), the WHO Guidelines on Hand Hygiene in Health Care (2009) and the WHO Hand Hygiene
// Technical Reference Manual (2009) for the Five Moments and rub technique, and the EPA's
// selected registered disinfectant lists (G norovirus, H MRSA, K C. difficile spores, P C. auris).
export const SHARED_CITATIONS = {
  cdcHandHygiene: "https://www.cdc.gov/clean-hands/hcp/clinical-safety/index.html",
  whoGuidelines2009: "https://www.who.int/publications/i/item/9789241597906",
  whoTechnicalReferenceManual: "https://www.who.int/publications/i/item/9789241598606",
  epaDisinfectantLists: "https://www.epa.gov/pesticide-registration/selected-epa-registered-disinfectants",
} as const;

import type { HygieneAgent, PathogenId, PathogenProfile } from "./types.ts";

// All four persist on surfaces far longer than any clip, so no surface decay inside a clip.
export const EFFECTIVELY_FOREVER_S = 1_000_000_000;

export const PATHOGEN_IDS: readonly PathogenId[] = ["mrsa", "c_auris", "c_difficile", "norovirus"];

export const PATHOGENS: Readonly<Record<PathogenId, PathogenProfile>> = {
  mrsa: {
    id: "mrsa",
    label: "MRSA",
    alcoholRubClearsHands: true,
    soapWaterClearsHands: true,
    surfacePersistenceS: EFFECTIVELY_FOREVER_S,
    uiNote: "Alcohol rub is effective.",
    disinfectantNote: "Use an EPA List H registered disinfectant (effective against MRSA).",
    // CDC MRSA infection control: "Clean hands with soap and water or an alcohol-based hand
    // sanitizer before and after caring for every patient." EPA List H: MRSA and VRE.
    citations: ["https://www.cdc.gov/mrsa/hcp/infection-control/index.html", SHARED_CITATIONS.cdcHandHygiene, SHARED_CITATIONS.epaDisinfectantLists],
  },
  c_auris: {
    id: "c_auris",
    label: "C. auris",
    alcoholRubClearsHands: true,
    soapWaterClearsHands: true,
    surfacePersistenceS: EFFECTIVELY_FOREVER_S,
    uiNote: "Persists on surfaces for weeks; alcohol rub effective; a major NY nursing home concern.",
    disinfectantNote: "Use an EPA List P registered disinfectant (effective against Candida auris); routine quaternary ammonium products are not reliable.",
    // CDC C. auris infection control: "Alcohol-based hand sanitizer is preferred for C. auris
    // when hands are not visibly soiled." and "See EPA's List P for a current list of
    // EPA-approved products for C. auris."
    citations: ["https://www.cdc.gov/candida-auris/hcp/infection-control/index.html", SHARED_CITATIONS.epaDisinfectantLists],
  },
  c_difficile: {
    id: "c_difficile",
    label: "C. difficile",
    alcoholRubClearsHands: false,
    soapWaterClearsHands: true,
    surfacePersistenceS: EFFECTIVELY_FOREVER_S,
    uiNote: "Spores are not killed by alcohol rub. Soap and water required. Contact precautions.",
    disinfectantNote: "Use an EPA List K sporicidal disinfectant (effective against C. difficile spores); standard disinfectants do not kill spores.",
    // CDC C. diff facts for clinicians: "hand sanitizer doesn't kill C. diff." CDC Preventing
    // C. diff: "Washing your hands with soap and water is the best way to prevent the spread of
    // C. diff from person to person." CDC hand hygiene: soap and water during C. difficile
    // outbreaks. EPA List K: C. difficile spores.
    citations: [
      "https://www.cdc.gov/c-diff/hcp/clinical-overview/index.html",
      "https://www.cdc.gov/c-diff/prevention/index.html",
      SHARED_CITATIONS.cdcHandHygiene,
      SHARED_CITATIONS.epaDisinfectantLists,
    ],
  },
  norovirus: {
    id: "norovirus",
    label: "Norovirus",
    alcoholRubClearsHands: false,
    soapWaterClearsHands: true,
    surfacePersistenceS: EFFECTIVELY_FOREVER_S,
    uiNote: "Alcohol rub is largely ineffective. Soap and water required.",
    disinfectantNote: "Use an EPA List G registered disinfectant (effective against norovirus).",
    // CDC How to Prevent Norovirus: "Hand sanitizer does not work well against norovirus." CDC
    // hand hygiene: soap and water during norovirus outbreaks. EPA List G: norovirus.
    citations: ["https://www.cdc.gov/norovirus/prevention/index.html", SHARED_CITATIONS.cdcHandHygiene, SHARED_CITATIONS.epaDisinfectantLists],
  },
};

export function isPathogenId(value: string): value is PathogenId {
  return (PATHOGEN_IDS as readonly string[]).includes(value);
}

export function agentClearsHands(profile: PathogenProfile, agent: HygieneAgent): boolean {
  return agent === "alcohol_rub" ? profile.alcoholRubClearsHands : profile.soapWaterClearsHands;
}

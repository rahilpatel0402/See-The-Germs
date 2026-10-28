// Pathogen rules table, values exactly as PLAN.md 6.3. Do not add a pathogen or change an
// effectiveness rule without Rahil confirming it. Citations are supplied by Rahil, never invented.

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
    citations: [],
  },
  c_auris: {
    id: "c_auris",
    label: "C. auris",
    alcoholRubClearsHands: true,
    soapWaterClearsHands: true,
    surfacePersistenceS: EFFECTIVELY_FOREVER_S,
    uiNote: "Persists on surfaces for weeks; alcohol rub effective; a major NY nursing home concern.",
    disinfectantNote: "Use an EPA List P registered disinfectant (effective against Candida auris); routine quaternary ammonium products are not reliable.",
    citations: [],
  },
  c_difficile: {
    id: "c_difficile",
    label: "C. difficile",
    alcoholRubClearsHands: false,
    soapWaterClearsHands: true,
    surfacePersistenceS: EFFECTIVELY_FOREVER_S,
    uiNote: "Spores are not killed by alcohol rub. Soap and water required. Contact precautions.",
    disinfectantNote: "Use an EPA List K sporicidal disinfectant (effective against C. difficile spores); standard disinfectants do not kill spores.",
    citations: [],
  },
  norovirus: {
    id: "norovirus",
    label: "Norovirus",
    alcoholRubClearsHands: false,
    soapWaterClearsHands: true,
    surfacePersistenceS: EFFECTIVELY_FOREVER_S,
    uiNote: "Alcohol rub is largely ineffective. Soap and water required.",
    disinfectantNote: "Use an EPA List G registered disinfectant (effective against norovirus).",
    citations: [],
  },
};

export function isPathogenId(value: string): value is PathogenId {
  return (PATHOGEN_IDS as readonly string[]).includes(value);
}

export function agentClearsHands(profile: PathogenProfile, agent: HygieneAgent): boolean {
  return agent === "alcohol_rub" ? profile.alcoholRubClearsHands : profile.soapWaterClearsHands;
}

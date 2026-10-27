// Hand-coded event lists for engine tests. Clip A is PLAN.md section 8: caregiver touches rail A
// (source), adjusts the IV pole, picks up the phone, touches blanket B and resident B. No hygiene.

import type { ContactEvent, Entity } from "./types.ts";

export const CLIP_A_ENTITIES: readonly Entity[] = [
  { id: "bare_hand", label: "bare hand", class: "bare_hand", zone: "healthcare_area", samPhrase: "bare hand", person: "P1" },
  { id: "gloved_hand", label: "gloved hand", class: "gloved_hand", zone: "healthcare_area", samPhrase: "gloved hand", person: "P1" },
  { id: "rail_A", label: "bed rail A", class: "object", zone: "patient_zone_A", samPhrase: "white rod" },
  { id: "iv_pole", label: "IV pole", class: "object", zone: "healthcare_area", samPhrase: "floor lamp" },
  { id: "phone", label: "phone", class: "object", zone: "healthcare_area", samPhrase: "phone" },
  { id: "glucometer", label: "glucometer", class: "object", zone: "healthcare_area", samPhrase: "white box", aseptic: true },
  { id: "blanket_B", label: "blanket B", class: "object", zone: "patient_zone_B", samPhrase: "blanket" },
  { id: "resident_B", label: "resident B", class: "resident_zone", zone: "patient_zone_B", samPhrase: "pillow" },
  { id: "sanitizer", label: "sanitizer dispenser", class: "dispenser", zone: "hygiene_station", samPhrase: "pump bottle", agent: "alcohol_rub" },
  { id: "sink", label: "sink", class: "dispenser", zone: "hygiene_station", samPhrase: "sink", agent: "soap_water" },
  { id: "glove_box", label: "glove box", class: "dispenser", zone: "hygiene_station", samPhrase: "tissue box", agent: "gloves" },
];

export const contact = (handId: string, entityId: string, startT: number, endT: number): ContactEvent => ({
  handId,
  entityId,
  startT,
  endT,
  adjudicated: false,
});

export const CLIP_A_CONTACTS: readonly ContactEvent[] = [
  contact("bare_hand", "rail_A", 1.0, 2.0),
  contact("bare_hand", "iv_pole", 4.0, 5.0),
  contact("bare_hand", "phone", 7.0, 8.0),
  contact("bare_hand", "blanket_B", 12.0, 13.0),
  contact("bare_hand", "resident_B", 15.0, 16.0),
];

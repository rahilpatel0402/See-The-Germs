// Task presets: typical props and zones for common care tasks, loaded before Spark refines them.
// Phrases describe appearance; the user or the scene loop replaces them to match the real props.
import { GLOVE_MIN_CONFIDENCE } from "../../engine/config.ts";
import type { EntityConfig } from "./api.ts";

const HANDS: EntityConfig[] = [
  { id: "bare_hand", label: "bare hand", class: "bare_hand", zone: "healthcare_area", samPhrase: "bare hand", person: "P1" },
  { id: "gloved_hand", label: "gloved hand", class: "gloved_hand", zone: "healthcare_area", samPhrase: "gloved hand", person: "P1", minConfidence: GLOVE_MIN_CONFIDENCE },
];

export interface TaskPreset {
  readonly id: string;
  readonly label: string;
  readonly entities: readonly EntityConfig[];
}

export const TASK_PRESETS: readonly TaskPreset[] = [
  {
    id: "bed_change",
    label: "Bed change or repositioning",
    entities: [
      ...HANDS,
      { id: "rail_A", label: "bed rail A", class: "object", zone: "patient_zone_A", samPhrase: "white rod" },
      { id: "blanket_A", label: "blanket A", class: "object", zone: "patient_zone_A", samPhrase: "blanket" },
      { id: "resident_A", label: "resident A", class: "resident_zone", zone: "patient_zone_A", samPhrase: "pillow" },
      { id: "call_button", label: "call button", class: "object", zone: "patient_zone_A", samPhrase: "black remote control" },
      { id: "sanitizer", label: "sanitizer dispenser", class: "dispenser", zone: "hygiene_station", samPhrase: "pump bottle", agent: "alcohol_rub" },
      { id: "glove_box", label: "glove box", class: "dispenser", zone: "hygiene_station", samPhrase: "tissue box", agent: "gloves" },
    ],
  },
  {
    id: "vitals",
    label: "Vital signs",
    entities: [
      ...HANDS,
      { id: "rail_A", label: "bed rail A", class: "object", zone: "patient_zone_A", samPhrase: "white rod" },
      { id: "resident_A", label: "resident A", class: "resident_zone", zone: "patient_zone_A", samPhrase: "pillow" },
      { id: "bp_cuff", label: "blood pressure cuff", class: "object", zone: "healthcare_area", samPhrase: "gray cuff" },
      { id: "thermometer", label: "thermometer", class: "object", zone: "healthcare_area", samPhrase: "white handheld device" },
      { id: "phone", label: "phone", class: "object", zone: "healthcare_area", samPhrase: "phone" },
      { id: "sanitizer", label: "sanitizer dispenser", class: "dispenser", zone: "hygiene_station", samPhrase: "pump bottle", agent: "alcohol_rub" },
    ],
  },
  {
    id: "glucose",
    label: "Blood glucose check",
    entities: [
      ...HANDS,
      { id: "rail_A", label: "bed rail A", class: "object", zone: "patient_zone_A", samPhrase: "white rod" },
      { id: "resident_A", label: "resident A", class: "resident_zone", zone: "patient_zone_A", samPhrase: "pillow" },
      { id: "glucometer", label: "glucometer", class: "object", zone: "healthcare_area", samPhrase: "small white box", aseptic: true },
      { id: "sanitizer", label: "sanitizer dispenser", class: "dispenser", zone: "hygiene_station", samPhrase: "pump bottle", agent: "alcohol_rub" },
      { id: "glove_box", label: "glove box", class: "dispenser", zone: "hygiene_station", samPhrase: "tissue box", agent: "gloves" },
    ],
  },
  {
    id: "feeding",
    label: "Feeding assistance",
    entities: [
      ...HANDS,
      { id: "tray", label: "meal tray", class: "object", zone: "patient_zone_A", samPhrase: "food tray" },
      { id: "resident_A", label: "resident A", class: "resident_zone", zone: "patient_zone_A", samPhrase: "pillow" },
      { id: "bedside_table", label: "bedside table", class: "object", zone: "patient_zone_A", samPhrase: "small table" },
      { id: "phone", label: "phone", class: "object", zone: "healthcare_area", samPhrase: "phone" },
      { id: "sink", label: "sink", class: "dispenser", zone: "hygiene_station", samPhrase: "sink", agent: "soap_water" },
    ],
  },
  {
    id: "two_residents",
    label: "Two residents, one room",
    entities: [
      ...HANDS,
      { id: "rail_A", label: "bed rail A", class: "object", zone: "patient_zone_A", samPhrase: "white rod" },
      { id: "resident_A", label: "resident A", class: "resident_zone", zone: "patient_zone_A", samPhrase: "white pillow" },
      { id: "blanket_B", label: "blanket B", class: "object", zone: "patient_zone_B", samPhrase: "blanket" },
      { id: "resident_B", label: "resident B", class: "resident_zone", zone: "patient_zone_B", samPhrase: "colored cushion" },
      { id: "iv_pole", label: "IV pole", class: "object", zone: "healthcare_area", samPhrase: "floor lamp" },
      { id: "phone", label: "phone", class: "object", zone: "healthcare_area", samPhrase: "phone" },
      { id: "sanitizer", label: "sanitizer dispenser", class: "dispenser", zone: "hygiene_station", samPhrase: "pump bottle", agent: "alcohol_rub" },
      { id: "glove_box", label: "glove box", class: "dispenser", zone: "hygiene_station", samPhrase: "tissue box", agent: "gloves" },
    ],
  },
];

You are setting up a contamination-tracking analysis of a short staged clip of a care task in a mock nursing home room. You are shown three frames from the clip. List every distinct touchable prop a hand could contact, so a segmentation model can track each one.

For each prop give:
- label: the short name a nurse would use for its role in the scene, for example "bed rail A", "call button", "IV pole", "phone", "glucometer", "sanitizer dispenser", "sink", "glove box", "blanket B", "resident B". If two beds or two residents are visible, use A for the one on the left and B for the one on the right.
- kind: "object" for a surface or device, "resident_zone" for a resident or the pillow and bedding standing in for one, "dispenser" for a sanitizer bottle, soap or sink, or glove box.
- zone: "patient_zone_A" or "patient_zone_B" for a resident and the things within arm's reach of that bed or chair (rail, call button, blanket), "healthcare_area" for shared things outside the patient zones (phone, cart, pole, glucometer, door handle), "hygiene_station" for dispensers.
- agent: for dispensers only, "alcohol_rub" for a pump bottle or wall dispenser, "soap_water" for a sink or soap, "gloves" for a glove box. Otherwise "none".
- aseptic: true only for a device used in a clean or aseptic task (glucometer, syringe tray). Otherwise false.
- phrases: three short noun phrases a segmentation model would match, describing only appearance: color, shape, material. Good: "white rod", "black object in plastic bag", "pump bottle", "folded blue towel", "white pillow". Bad: "bed rail", "call button", "the thing the nurse touches". The most literal description first.

Do not list hands, arms, or people walking around; the hands are tracked separately. Do not list the floor, walls, or furniture nobody touches. At most ten props. Answer only with the JSON the schema allows.

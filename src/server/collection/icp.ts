/**
 * Who Orbit is for: small, owner-run service businesses in the 20 target
 * categories (beauty, grooming, events, creative, marketing, consulting,
 * tutoring, fitness, cleaning, repair & maintenance, content production,
 * virtual assistants). Everything collected passes through this gate, and the
 * cleanup script archives anything already stored that doesn't.
 */

/** Overture taxonomy → Orbit category, limited to the 20 target categories (plus close beauty/wellness siblings). */
export const ORBIT_TAXONOMY: Record<string, string> = {
  // 1. Hair stylists
  hair_salon: "hair_stylist", hair_stylist: "hair_stylist", hair_extensions: "hair_stylist", hair_replacement: "hair_stylist", beauty_salon: "beauty_salon",
  // 2. Nail technicians
  nail_salon: "nail_technician",
  // 3. Makeup artists
  makeup_artist: "makeup_artist", skin_care_and_makeup: "makeup_artist",
  // 4. Barbers
  barber: "barber",
  // 5. Lash & brow
  eyelash_service: "lash_technician", threading_service: "lash_technician", waxing: "skincare", hair_removal: "skincare", laser_hair_removal: "skincare",
  skin_care: "skincare", spa: "spa_wellness", day_spa: "spa_wellness", health_spa: "spa_wellness", massage_therapy: "spa_wellness", massage: "spa_wellness",
  // 6. Photographers  /  19. Videographers & content production
  photographer: "photographer", event_photography_service: "photographer", session_photography_service: "photographer", photography_service: "photographer",
  videographer: "photographer", video_film_production: "media_production", music_production: "media_production", music_production_service: "media_production",
  recording_and_rehearsal_studio: "media_production", animation_studio: "media_production",
  // 7. Event planners
  party_and_event_planning: "event_planner", event_planning: "event_planner", wedding_planning: "event_planner", dj_service: "entertainer",
  balloon_services: "event_planner", party_equipment_rental: "event_planner", caterer: "caterer", personal_chef: "caterer",
  // 21–34. Beauty, events, entertainment and creative additions
  tattoo_and_piercing: "tattoo_artist", medical_spa: "skincare", health_coaching: "coach",
  florist: "florist", cupcake_shop: "cake_designer", patisserie_cake_shop: "cake_designer", cake_shop: "cake_designer",
  musician: "entertainer",
  // 35–44. Professional services
  accountant: "accountant", tax_services: "accountant",
  employment_agency: "hr_recruiter", b2b_human_resource_service: "hr_recruiter",
  attorney_or_law_firm: "legal_practice", legal_service: "legal_practice", lawyer: "legal_practice", immigration_law: "immigration_consultant",
  real_estate_law: "legal_practice", criminal_defense_law: "legal_practice", employment_law: "legal_practice", divorce_and_family_law: "legal_practice",
  ip_and_internet_law: "legal_practice", tax_law: "legal_practice", passport_and_visa_service: "immigration_consultant",
  // 8. Fashion designers & tailors
  tailor: "fashion_designer", sewing_and_alterations: "fashion_designer", fashion_designer: "fashion_designer", costume_designer: "fashion_designer",
  // 9. Graphic & brand designers  /  10. Web designers  /  17. Interior designers
  graphic_designer: "designer", web_designer: "designer", interior_design: "designer",
  // 11. Social media managers  /  12. Digital marketing
  social_media_agency: "marketing_agency", internet_marketing_service: "marketing_agency", marketing_agency: "marketing_agency",
  advertising_agency: "marketing_agency", b2b_marketing_consultant: "marketing_agency", public_relations: "marketing_agency",
  b2b_advertising_and_marketing_service: "marketing_agency", media_agency: "marketing_agency",
  // 13. Business consultants
  business_consulting: "consultant", life_coach: "coach", career_counseling: "coach", image_consultant: "personal_stylist",
  // 14. Tutors & private educators
  tutoring_service: "tutor", computer_coaching: "tutor", music_school: "tutor", language_school: "tutor", driving_school: "tutor",
  cooking_school: "tutor", art_school: "tutor", cosmetology_school: "tutor", dance_school: "fitness_trainer",
  // 15. Personal trainers & fitness
  personal_trainer: "fitness_trainer", fitness_trainer: "fitness_trainer", yoga_studio: "fitness_trainer", pilates_studio: "fitness_trainer",
  boot_camp: "fitness_trainer", martial_arts_club: "fitness_trainer", gym: "fitness_trainer", nutrition_service: "coach",
  // 16. Cleaning
  home_cleaning: "cleaning_service", janitorial_service: "cleaning_service", carpet_cleaning: "cleaning_service", pool_cleaning: "cleaning_service",
  laundry_service: "cleaning_service", dry_cleaning: "cleaning_service", laundromat: "cleaning_service",
  // 18. Repair & maintenance
  electrician: "home_service", plumbing: "home_service", hvac_service: "home_service", appliance_repair_service: "home_service",
  washer_and_dryer_repair_service: "home_service", water_heater_installation_repair: "home_service", handyman: "home_service",
  pest_control_service: "home_service", painting: "home_service", carpenter: "home_service", key_and_locksmith: "home_service",
  furniture_assembly: "home_service", gardener: "home_service", landscaping: "home_service", mobile_phone_repair: "home_service",
  computer_repair: "home_service", electronics_repair: "home_service", it_service_and_computer_repair: "home_service",
  // 20. Virtual assistants & freelance admin
  virtual_assistant: "freelancer", bookkeeper: "accountant", b2b_secretarial_service: "freelancer", writing_service: "freelancer",
  translating_and_interpreting_service: "freelancer", copywriting_service: "freelancer",
};

/** Orbit categories that are in scope (used for name-pattern and OpenStreetMap results). */
export const ORBIT_CATEGORIES = new Set([
  "hair_stylist", "beauty_salon", "barber", "nail_technician", "lash_technician", "makeup_artist", "skincare", "spa_wellness",
  "photographer", "media_production", "event_planner", "caterer", "fashion_designer", "designer", "marketing_agency", "consultant",
  "coach", "tutor", "fitness_trainer", "cleaning_service", "home_service", "freelancer",
  "tattoo_artist", "henna_artist", "personal_stylist", "florist", "cake_designer", "entertainer",
  "accountant", "hr_recruiter", "legal_practice", "immigration_consultant",
]);

/** Names that signal a large organisation rather than a small, owner-run service business. */
const LARGE_ORG = /\b(plc|holdings?|group of companies|conglomerate|corporation|multinational|hospital|university|polytechnic|bank|insurance|nigeria limited|international limited|federal|state government|ministry|kpmg|deloitte|pwc|pricewaterhouse|ernst|accenture)\b/i;

export interface FitInput {
  category: string | null | undefined;
  taxonomy?: string | null;
  name: string;
  /** Overture brand name: set for chains and franchises. */
  brand?: string | null;
}

/** Is this a small business in one of Orbit's target categories? Returns the reason when not. */
/** Bakeries count only as custom cake designers ("… Cakes", "… Cakes & Pastries"), not as bread shops. */
export function cakeDesignerFromBakery(taxonomy: string | null | undefined, name: string): boolean {
  return taxonomy === "bakery" && /\b(cakes?|cake designs?|cakery|confectioner(y|ies)|cupcakes?)\b/i.test(name);
}

export function orbitFit(x: FitInput): { ok: true } | { ok: false; reason: string } {
  if (!x.category || !ORBIT_CATEGORIES.has(x.category)) return { ok: false, reason: `category ${x.category ?? "unknown"} is outside Orbit's 20 target categories` };
  if (x.taxonomy && !ORBIT_TAXONOMY[x.taxonomy] && !NAME_ONLY_OK.has(x.taxonomy) && !(x.category === "cake_designer" && cakeDesignerFromBakery(x.taxonomy, x.name))) return { ok: false, reason: `type ${x.taxonomy} isn't a target service` };
  if (x.brand) return { ok: false, reason: `part of a chain or brand (${x.brand})` };
  if (LARGE_ORG.test(x.name)) return { ok: false, reason: "name indicates a large organisation" };
  return { ok: true };
}

/** Broad/blank Overture types where the business name (not the type) decides, e.g. "Ada's Braids" filed as "shopping". */
const NAME_ONLY_OK = new Set(["personal_or_beauty_service", "event_or_party_service", "home_service", "design_service", "wellness_service"]);

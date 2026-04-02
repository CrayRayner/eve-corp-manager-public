'use strict';

/**
 * Structure fuel consumption workaround: ESI does NOT return fuel usage.
 * It only returns structure type_id and services: [ { name, state: "online"|"offline"|"cleanup" } ].
 * Fuel per hour comes from SDE attribute 2109 (serviceModuleFuelAmount) per service module type.
 * We map ESI service name (English type name) → fuel blocks per hour.
 * Source: SDE/ESI universe/types/{id} dogma_attributes attribute_id 2109.
 * Extend this map when new service modules are added by CCP; names must match ESI exactly.
 */
const SERVICE_FUEL_PER_HOUR = {
  // Structure Resource Processing
  'Standup Reprocessing Facility I': 10,
  'Standup Reprocessing Facility II': 10,
  'Standup Biochemical Reactor I': 10,
  'Standup Composite Reactor I': 10,
  'Standup Hybrid Reactor I': 10,
  // Engineering / Manufacturing
  'Standup Manufacturing Plant I': 12,
  'Standup Manufacturing Plant II': 12,
  'Standup Laboratory I': 20,
  'Standup Laboratory II': 20,
  'Standup Research Lab I': 20,
  'Standup Research Lab II': 20,
  // Moon drilling (refinery)
  'Standup Moon Drill I': 5,
  'Standup Moon Drill II': 5,
  'Standup Metenox Moon Drill': 5,
  // Citadel services (Market, etc.)
  'Market Hub': 40,
  'Market Hub I': 40,
  'Standup Market Hub I': 40,
  'Cynosural System Jammer': 24,
  'Standup Cynosural System Jammer I': 24,
  'Cynosural System Jammer I': 24,
  'Clone Bay': 20,
  'Standup Clone Bay I': 20,
  'Clone Bay I': 20,
  'Cloning Center': 20,
  'Standup Cloning Center I': 20,
  'Repair Facility': 30,
  'Standup Repair Facility I': 30,
  'Repair Facility I': 30,
  'Damage Control': 15,
  'Standup Damage Control I': 15,
  'Fighter Support Unit': 25,
  'Standup Fighter Support Unit I': 25,
  'Fighter Support Unit I': 25,
  'Supercapital Ship Maintenance Bay': 50,
  'Standup Supercapital Ship Maintenance Bay I': 50,
  'Capital Ship Maintenance Bay': 40,
  'Standup Capital Ship Maintenance Bay I': 40,
  'Ship Maintenance Bay': 30,
  'Standup Ship Maintenance Bay I': 30,
  'Bounty Office': 15,
  'Standup Bounty Office I': 15,
  'Security Office': 15,
  'Standup Security Office I': 15,
  'Medal Office': 10,
  'Standup Medal Office I': 10,
  'Insurance': 10,
  'Standup Insurance I': 10,
  'Loyalty Point Store': 20,
  'Standup Loyalty Point Store I': 20,
  'Naval Reserve': 30,
  'Standup Naval Reserve I': 30,
};

/**
 * Structure type_id → fuel consumption multiplier (1 = no bonus).
 * Citadels: -25% = 0.75. Refineries (Athanor/Tatara): -20% for reprocessing/reaction = 0.8.
 * Engineering (Raitaru/Astrahus): -25% = 0.75. We use a single multiplier per type for simplicity.
 */
const STRUCTURE_FUEL_MULTIPLIER = {
  35832: 0.75,  // Fortizar (Citadel)
  35833: 0.75,  // Keepstar
  35834: 0.75,  // Raitaru (Engineering)
  35835: 0.80,  // Athanor (Refinery)
  35836: 0.80,  // Tatara (Refinery)
  35825: 0.75,  // Astrahus (Citadel)
  35826: 0.75,  // Fortizar (if different id)
  35827: 0.75,  // Sotiyo (Engineering)
  35840: 0.75,  // Ansiblex
  35841: 0.75,  // Tenebrex
  40340: 0.75,  // IHub
  81826: 1.00,  // Metenox (refinery; fuel blocks for services if any)
};

const HOURS_PER_MONTH = 24 * 30; // 720 — EVE may show consumption per 15 days in-game; if our calc is 2× in-game, set structure_fuel_month_hours to 360 in Settings.

/** Metenox (81826) has one moon drill = 5 blocks/hr = 3600/month. If ESI returns an unknown service name we default to 10 → 7200; use 5 for Metenox so auto shows 3600. */
const METENOX_TYPE_ID = 81826;
function getServiceFuelPerHour(serviceName, structureTypeId) {
  if (!serviceName || typeof serviceName !== 'string') return 0;
  const name = serviceName.trim();
  const fuel = SERVICE_FUEL_PER_HOUR[name] ?? 10;
  if (structureTypeId === METENOX_TYPE_ID && fuel === 10) return 5; // unknown service on Metenox = moon drill
  return fuel;
}

function getStructureMultiplier(typeId) {
  return STRUCTURE_FUEL_MULTIPLIER[typeId] ?? 1.0;
}

/**
 * Compute fuel blocks per hour and per month for a structure from its online services.
 * services: array of { name: string, state: "online"|"offline"|"cleanup" } from ESI.
 */
function computeStructureFuel(services, structureTypeId) {
  const multiplier = getStructureMultiplier(structureTypeId);
  let fuelPerHour = 0;
  if (Array.isArray(services)) {
    for (const svc of services) {
      if (svc.state === 'online' && svc.name) {
        fuelPerHour += getServiceFuelPerHour(svc.name, structureTypeId);
      }
    }
  }
  fuelPerHour = Math.round(fuelPerHour * multiplier);
  const fuelPerMonth = fuelPerHour * HOURS_PER_MONTH;
  return { fuelPerHour, fuelPerMonth };
}

module.exports = {
  SERVICE_FUEL_PER_HOUR,
  STRUCTURE_FUEL_MULTIPLIER,
  getServiceFuelPerHour,
  getStructureMultiplier,
  computeStructureFuel,
  HOURS_PER_MONTH,
};

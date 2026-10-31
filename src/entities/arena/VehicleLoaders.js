/**
 * VehicleLoaders.js
 * Default asset loaders & wheel/suspension specs for vehicles.
 */

import {
  FENNEC_DESCRIPTOR,
} from '../../ui-core/config/vehicleTunerConfig.js';
import {
  loadCustomGlbCarAsset,
  createCustomGlbCarModel,
} from '../vehicle/customGlbCarModel.js';
import {
  createProceduralSportWheel,
} from '../vehicle/vehicleWheelsAndLamps.js';
import {
  DEFAULT_TEAM_COLORS,
} from './ArenaConstants.js';

export function createDefaultVehicleLoaders() {
  return {
    loadCustomGlbCarAsset,
    createCustomGlbCarModel,
    createProceduralSportWheel,
    wheelSpecs: {
      game: FENNEC_DESCRIPTOR.wheelAnchors,
    },
    suspensionSpecs: {
      octaneZ: 17,
    },
    teamColors: DEFAULT_TEAM_COLORS,
  };
}

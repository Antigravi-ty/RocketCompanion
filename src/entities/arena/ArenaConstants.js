import {
  SIM_OFFSETS,
  CAR_STATE_OFFSETS as ROCKETSIM_CAR_STATE_OFFSETS,
  CAR_STATE_STRIDE as ROCKETSIM_CAR_STATE_STRIDE,
  MAX_CARS
} from '../../physics/RocketSimConstants.js';

// Arena Dimensions & Coordinate Constants (Unreal Units)
export const ARENA_WIDTH = 8192;
export const ARENA_LENGTH = 10240;
export const ARENA_GOAL_DEPTH = 5120;

// Team Colors
export const TEAM_BLUE_HEX = 2844350;
export const TEAM_ORANGE_HEX = 16750126;
export const DEFAULT_TEAM_COLORS = [3111891, 13857839];

// Vehicle Boost Outlets & Hitbox Presets
export const OCTANE_BOOST_OUTLETS = [
  [-57, 10.25, 20.4278],
  [-57, 10.25, -20.4278]
];

export const OCTANE_HITBOX_PRESET = {
  length: 120.507,
  width: 86.6994,
  height: 38.6591,
  forward: 13.8757,
  up: 20.755
};

// Physics Buffer Offsets & Strides (RocketSim Memory Layout)
export const BUFFER_OFFSETS = SIM_OFFSETS;
export const CAR_STATE_OFFSETS = ROCKETSIM_CAR_STATE_OFFSETS;
export const CAR_STATE_STRIDE = ROCKETSIM_CAR_STATE_STRIDE;
export const BOOST_PAD_OFFSET = SIM_OFFSETS.CARS + MAX_CARS * CAR_STATE_STRIDE;
export const WHEEL_STATE_STRIDE = 3;
export const BOT_CAR_INDEX = 1;

import { resolveAssetPath } from '../../utils/AssetResponseValidator.js';
export { resolveAssetPath };

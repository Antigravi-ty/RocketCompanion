export const GOLDEN_BOOST_ASSET_PATH = "/assets/boost/rush-mono";
export const PLUME_TEXTURE = `${GOLDEN_BOOST_ASSET_PATH}/plume.webp`;
export const TURBULENCE_TEXTURE = `${GOLDEN_BOOST_ASSET_PATH}/turbulence.webp`;
export const SPARKS_TEXTURE = `${GOLDEN_BOOST_ASSET_PATH}/sparks.webp`;

export const REALISTIC_TRAIL_COUNT = 160;
export const REALISTIC_DRIVE_COUNT = 32;
export const REALISTIC_TRAIL_LIFE = 1.0;
export const REALISTIC_DRIVE_LIFE = 0.5;
export const REALISTIC_TRAIL_INTERVAL = 32;
export const REALISTIC_DRIVE_RATE = 10;
export const REALISTIC_MAX_PARTICLES_PER_FRAME = 24;

export const ARCADE_TRAIL_COUNT = 72;
export const ARCADE_DRIVE_COUNT = 16;
export const ARCADE_TRAIL_LIFE = 0.36;
export const ARCADE_DRIVE_LIFE = 0.3;
export const ARCADE_TRAIL_DISTANCE = 28;
export const ARCADE_DRIVE_SPAWN_RATE = 8;
export const ARCADE_MAX_PARTICLES_PER_FRAME = 24;
export const ARCADE_BOOST_COLOR_HEX = 16750126;

export const CURVE_SCALE = new Float32Array([.047923,.4878,.696485,.776236,.823334,.865453,.901153,.930914,.955217,.974545,.989377,1.000196,1.007483,1.011718,1.013383,1.012959,1.010928,1.00777,1.003967,1,1]);
export const CURVE_OPACITY = new Float32Array([0,.052264,.18705,.371348,.572152,.75645,.891236,.9435,.933541,.905905,.863957,.811057,.75057,.685858,.620283,.55721,.5,.391974,.223421,.068158,0]);
export const CURVE_VELOCITY = new Float32Array([.989099,.963349,.89434,.794431,.675982,.551353,.432905,.332996,.263987,.238237]);
export const CURVE_DRIVE_SIZE = new Float32Array([1,1.02175,1.084,1.18225,1.312,1.46875,1.648,1.84525,2.056,2.27575,2.5,2.72425,2.944,3.15475,3.352,3.53125,3.688,3.81775,3.916,3.97825,4]);
export const CURVE_DRIVE_COLOR = new Float32Array([2,1.9855,1.944,1.8785,1.792,1.6875,1.568,1.4365,1.296,1.1495,1,.8505,.704,.5635,.432,.3125,.208,.1215,.056,.0145,0]);
export const CURVE_DRIVE_OPACITY = new Float32Array([.25,.2481875,.243,.2348125,.224,.2109375,.196,.1795625,.162,.1436875,.125,.1063125,.088,.0704375,.054,.0390625,.026,.0151875,.007,.0018125,0]);
export const CURVE_DYNAMIC_X = new Float32Array([0,.147955,.548288,1.135698,1.844884,2.610548,3.367389,4.050106,4.593399,4.931969,5.000516,4.788702,4.367,3.7901,3.112689,2.389455,1.675084,1.024267,.491688,.132037,0]);
export const CURVE_DYNAMIC_Y = new Float32Array([0,.104,.352,.648,.896,1,.99363,.975704,.948,.912296,.87037,.824,.774963,.725037,.676,.62963,.587704,.552,.524296,.50637,.5]);
export const CURVE_DYNAMIC_Z = new Float32Array([1,.9748,.9064,.8056,.6832,.55,.4168,.2944,.1936,.1252,.1]);
export const CURVE_DYNAMIC_W = new Float32Array([.25,.271,.328,.412,.514,.625,.736,.838,.922,.979,1]);

/**
 * Piecewise linear interpolation over a curve LUT.
 */
export function evalCurveLut(lut, normalizedTime) {
  const clamped = Math.max(0, Math.min(1, normalizedTime)) * (lut.length - 1);
  const idx = Math.min(lut.length - 2, Math.floor(clamped));
  const t = clamped - idx;
  return lut[idx] + (lut[idx + 1] - lut[idx]) * t;
}

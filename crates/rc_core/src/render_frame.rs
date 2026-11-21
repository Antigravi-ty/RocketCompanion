use glam::{Mat3, Quat, Vec3};

/// RocketSim Unreal Units to Three.js meters (50 uu = 1 m).
pub const UU_TO_METERS: f32 = 0.02;

/// Magic "RCF1" in little-endian u32.
pub const RENDER_FRAME_MAGIC: u32 = 0x3146_4352;
pub const RENDER_FRAME_VERSION: u32 = 1;

pub const CAR_FLAG_IS_BOOSTING: u32 = 1 << 0;
pub const CAR_FLAG_IS_SUPERSONIC: u32 = 1 << 1;
pub const CAR_FLAG_ON_GROUND: u32 = 1 << 2;
pub const CAR_FLAG_HAS_FLIPPED: u32 = 1 << 3;

/// Fixed-layout binary RenderFrame exported by `rc_core` for Three.js consumption.
/// All positions/velocities/quaternions are already converted into Three.js Y-up meters
/// at this single boundary.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct RenderFramePod {
    // Header (8 x 4 = 32 bytes)
    pub magic: u32,
    pub version: u32,
    pub tick: u32,
    pub teleport_seq: u32,
    pub ball_cam: u32,
    pub car_flags: u32,
    pub car_boost: f32,
    pub reserved: u32,

    // Ball in Three.js Y-up meters (10 x 4 = 40 bytes)
    pub ball_pos: [f32; 3],
    pub ball_quat: [f32; 4],
    pub ball_vel: [f32; 3],

    // Car 0 in Three.js Y-up meters (10 x 4 = 40 bytes)
    pub car_pos: [f32; 3],
    pub car_quat: [f32; 4],
    pub car_vel: [f32; 3],

    // Camera in Three.js Y-up meters (10 x 4 = 40 bytes)
    pub cam_pos: [f32; 3],
    pub cam_dir: [f32; 3],
    pub cam_up: [f32; 3],
    pub cam_fov: f32,
}

impl Default for RenderFramePod {
    fn default() -> Self {
        Self {
            magic: RENDER_FRAME_MAGIC,
            version: RENDER_FRAME_VERSION,
            tick: 0,
            teleport_seq: 0,
            ball_cam: 1,
            car_flags: 0,
            car_boost: 100.0,
            reserved: 0,
            ball_pos: [0.0, 1.855, 0.0],
            ball_quat: [0.0, 0.0, 0.0, 1.0],
            ball_vel: [0.0; 3],
            car_pos: [0.0, 0.34, 0.0],
            car_quat: [0.0, 0.0, 0.0, 1.0],
            car_vel: [0.0; 3],
            cam_pos: [0.0, 2.0, 6.0],
            cam_dir: [0.0, 0.0, -1.0],
            cam_up: [0.0, 1.0, 0.0],
            cam_fov: 110.0,
        }
    }
}

impl RenderFramePod {
    pub const BYTE_LEN: usize = core::mem::size_of::<Self>();

    pub fn as_bytes(&self) -> &[u8] {
        unsafe {
            core::slice::from_raw_parts((self as *const Self) as *const u8, Self::BYTE_LEN)
        }
    }
}

/// Convert a RocketSim Z-up position (uu) into Three.js Y-up (meters).
/// Mapping: (x, y, z)_rs -> (x, z, -y) * 0.02 (proper right-handed -90deg X rotation).
#[inline]
pub fn rs_pos_to_three(v: [f32; 3]) -> [f32; 3] {
    [
        v[0] * UU_TO_METERS,
        v[2] * UU_TO_METERS,
        -v[1] * UU_TO_METERS,
    ]
}

/// Convert a RocketSim Z-up direction vector (unitless) into Three.js Y-up.
#[inline]
pub fn rs_dir_to_three(v: Vec3) -> [f32; 3] {
    [v.x, v.z, -v.y]
}

/// Convert a RocketSim rotation matrix (columns: forward, right, up in Z-up)
/// into a Three.js Y-up quaternion (where Three.js local +X = forward, +Y = up, +Z = right? Wait:
/// in Three.js standard car mesh, let's align local +X=forward, +Y=up, +Z=right_or_back,
/// using the exact same R_x(-90deg) similarity transform on the RocketSim basis).
#[inline]
pub fn rs_rot_to_three_quat(forward_rs: Vec3, right_rs: Vec3, up_rs: Vec3) -> [f32; 4] {
    let f = Vec3::from_array(rs_dir_to_three(forward_rs)).normalize_or_zero();
    let r = Vec3::from_array(rs_dir_to_three(right_rs)).normalize_or_zero();
    let u = Vec3::from_array(rs_dir_to_three(up_rs)).normalize_or_zero();
    // RocketSim basis columns are (forward, right, up). Note: forward x right = -up in UE3 LH,
    // or forward x up = right. Let's construct an orthonormal RH basis for Three.js:
    // Local +X = forward, Local +Y = up, Local +Z = forward x up.
    let z_axis = f.cross(u).normalize_or_zero();
    let y_axis = z_axis.cross(f).normalize_or_zero();
    let _ = r;
    let mat = Mat3::from_cols(f, y_axis, z_axis);
    let q = Quat::from_mat3(&mat).normalize();
    [q.x, q.y, q.z, q.w]
}

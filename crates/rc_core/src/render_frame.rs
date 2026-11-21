pub const RENDER_FRAME_MAGIC: u32 = 0x5243_4631; // "RCF1"

pub const FLAG_BALL_CAM: u32 = 1 << 0;
pub const FLAG_SUPERSONIC: u32 = 1 << 1;
pub const FLAG_BOOSTING: u32 = 1 << 2;
pub const FLAG_GROUNDED: u32 = 1 << 3;
pub const FLAG_HAS_JUMPED: u32 = 1 << 4;
pub const FLAG_HAS_FLIPPED: u32 = 1 << 5;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct RenderFrame {
    pub magic: u32,
    pub tick: u32,
    pub teleport_seq: u32,
    pub flags: u32,
    pub ball_pos: [f32; 3],
    pub ball_quat: [f32; 4],
    pub ball_vel: [f32; 3],
    pub car_pos: [f32; 3],
    pub car_quat: [f32; 4],
    pub car_vel: [f32; 3],
    pub car_boost: f32,
    pub cam_pos: [f32; 3],
    pub cam_quat: [f32; 4],
    pub cam_fov: f32,
    pub boost_pads_lo: u32,
    pub boost_pads_hi: u32,
}

impl RenderFrame {
    pub const BYTE_LEN: usize = core::mem::size_of::<Self>();

    pub fn as_bytes(&self) -> &[u8] {
        // SAFETY: RenderFrame is #[repr(C)] with plain u32/f32 fields and no padding.
        unsafe { core::slice::from_raw_parts((self as *const Self).cast::<u8>(), Self::BYTE_LEN) }
    }
}

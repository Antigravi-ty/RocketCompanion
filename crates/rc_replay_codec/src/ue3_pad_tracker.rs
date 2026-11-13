//! 34-pad spatial lookup and decoded 30Hz timeline structs for UE3 NetStream extraction.

use crate::{
    types::{ReplayBookmarkPod, ReplayRosterSlotPod, RLRC_BOOST_PAD_COUNT, RLRC_MAX_PLAYER_SLOTS},
    ue3_attributes::Ue3RigidBody,
};

pub const STANDARD_PADS_XY_BIG: [(f32, f32, bool); RLRC_BOOST_PAD_COUNT] = [
    (0.0, -4240.0, false),
    (-1792.0, -4184.0, false),
    (1792.0, -4184.0, false),
    (-3072.0, -4096.0, true),
    (3072.0, -4096.0, true),
    (-940.0, -3308.0, false),
    (940.0, -3308.0, false),
    (0.0, -2816.0, false),
    (-3584.0, -2484.0, false),
    (3584.0, -2484.0, false),
    (-1788.0, -2300.0, false),
    (1788.0, -2300.0, false),
    (-2048.0, -1036.0, false),
    (0.0, -1024.0, false),
    (2048.0, -1036.0, false),
    (-3584.0, 0.0, true),
    (-1024.0, 0.0, false),
    (1024.0, 0.0, false),
    (3584.0, 0.0, true),
    (-2048.0, 1036.0, false),
    (0.0, 1024.0, false),
    (2048.0, 1036.0, false),
    (-1788.0, 2300.0, false),
    (1788.0, 2300.0, false),
    (-3584.0, 2484.0, false),
    (3584.0, 2484.0, false),
    (0.0, 2816.0, false),
    (-940.0, 3308.0, false),
    (940.0, 3308.0, false),
    (-3072.0, 4096.0, true),
    (3072.0, 4096.0, true),
    (-1792.0, 4184.0, false),
    (1792.0, 4184.0, false),
    (0.0, 4240.0, false),
];

pub fn find_nearest_pad(x: f32, y: f32) -> usize {
    let mut best_idx = 0;
    let mut best_d2 = f32::MAX;
    for (i, &(px, py, _)) in STANDARD_PADS_XY_BIG.iter().enumerate() {
        let dx = x - px;
        let dy = y - py;
        let d2 = dx * dx + dy * dy;
        if d2 < best_d2 {
            best_d2 = d2;
            best_idx = i;
        }
    }
    best_idx
}

#[inline]
pub fn decode_axis_byte(b: u8) -> f32 {
    if b == 128 {
        0.0
    } else {
        ((b as f32 - 128.0) / 127.0).clamp(-1.0, 1.0)
    }
}

#[derive(Clone)]
pub struct SourceCarState {
    pub active: bool,
    pub demolished: bool,
    pub rb_updated: bool,
    pub rigid_body: Ue3RigidBody,
    pub boost_amount: f32,
    pub throttle: f32,
    pub steer: f32,
    pub handbrake: bool,
    pub boost_active: bool,
    pub jump_active: bool,
    pub double_jump_active: bool,
    pub dodge_active: bool,
}

impl Default for SourceCarState {
    fn default() -> Self {
        Self {
            active: false,
            demolished: false,
            rb_updated: false,
            rigid_body: Ue3RigidBody::default(),
            boost_amount: (85.0 / 255.0) * 100.0,
            throttle: 0.0,
            steer: 0.0,
            handbrake: false,
            boost_active: false,
            jump_active: false,
            double_jump_active: false,
            dodge_active: false,
        }
    }
}

#[derive(Clone)]
pub struct SourceNetworkFrame {
    pub source_frame: u32,
    pub time_seconds: f32,
    pub delta_seconds: f32,
    pub seconds_remaining: i32,
    pub is_overtime: bool,
    pub round_countdown: i32,
    pub blue_score: u32,
    pub orange_score: u32,
    pub ball_active: bool,
    pub ball_rb_updated: bool,
    pub ball_rb: Ue3RigidBody,
    pub cars: [SourceCarState; RLRC_MAX_PLAYER_SLOTS],
}

#[derive(Clone, Copy)]
pub struct SourceBoostPadEvent {
    pub time_seconds: f32,
    pub pad_index: usize,
    pub is_big: bool,
    pub picked_up: bool,
}

pub struct Ue3DecodedTimeline {
    pub roster: [ReplayRosterSlotPod; RLRC_MAX_PLAYER_SLOTS],
    pub roster_count: usize,
    pub frames: Vec<SourceNetworkFrame>,
    pub boost_pad_events: Vec<SourceBoostPadEvent>,
    pub demolish_bookmarks: Vec<ReplayBookmarkPod>,
}

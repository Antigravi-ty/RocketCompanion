mod camera_kernel;
mod coords;
mod render_frame;
mod telemetry;

use core::cell::UnsafeCell;

use rocketsim::{Arena, CarBodyConfig, CarControls, GameMode, Team, init_or_reload_soccar_from_slices};

use crate::camera_kernel::{CameraStepInput, CleanPovCameraKernel};
use crate::coords::{ue_rot_to_three_quat, ue_to_three_vec3};
use crate::render_frame::{
    FLAG_BALL_CAM, FLAG_BOOSTING, FLAG_GROUNDED, FLAG_HAS_FLIPPED, FLAG_HAS_JUMPED,
    FLAG_SUPERSONIC, RENDER_FRAME_MAGIC, RenderFrame,
};
use crate::telemetry::TelemetryRingBuffer;

const FIXED_DT: f64 = 1.0 / 120.0;
const ARENA_GAME_MODE: GameMode = GameMode::Soccar;

struct SimCoreState {
    mesh_chunks: Vec<Vec<u8>>,
    arena: Option<Arena>,
    car_idx: usize,
    controls: CarControls,
    want_ball_cam: bool,
    aspect: f64,
    tick: u32,
    teleport_seq: u32,
    pending_teleport: bool,
    camera: CleanPovCameraKernel,
    frame: RenderFrame,
    telemetry: TelemetryRingBuffer,
    telemetry_bytes_len: usize,
    telemetry_bytes_ptr: *const u8,
}

impl SimCoreState {
    fn new() -> Self {
        Self {
            mesh_chunks: Vec::new(),
            arena: None,
            car_idx: 0,
            controls: CarControls::DEFAULT,
            want_ball_cam: true,
            aspect: 16.0 / 9.0,
            tick: 0,
            teleport_seq: 0,
            pending_teleport: false,
            camera: CleanPovCameraKernel::new(),
            frame: RenderFrame {
                magic: RENDER_FRAME_MAGIC,
                ..RenderFrame::default()
            },
            telemetry: TelemetryRingBuffer::new(),
            telemetry_bytes_len: 0,
            telemetry_bytes_ptr: core::ptr::null(),
        }
    }

    fn update_render_frame(&mut self) {
        let Some(arena) = self.arena.as_ref() else {
            return;
        };

        let ball = arena.get_ball_state();
        let car = arena.get_car_state(self.car_idx);

        let ball_pos = ue_to_three_vec3(ball.phys.pos);
        let ball_quat = ue_rot_to_three_quat(ball.phys.rot_mat);
        let ball_vel = ue_to_three_vec3(ball.phys.vel);

        let car_pos = ue_to_three_vec3(car.phys.pos);
        let car_quat = ue_rot_to_three_quat(car.phys.rot_mat);
        let car_vel = ue_to_three_vec3(car.phys.vel);

        let cam_out = self.camera.step(&CameraStepInput {
            dt: FIXED_DT,
            want_ball_cam: self.want_ball_cam,
            did_teleport: self.pending_teleport,
            car_pos,
            car_quat,
            car_vel,
            ball_pos,
            is_grounded: car.is_on_ground(),
            is_supersonic: car.is_supersonic,
            aspect: self.aspect,
        });
        self.pending_teleport = false;

        let mut flags = 0_u32;
        if self.want_ball_cam {
            flags |= FLAG_BALL_CAM;
        }
        if car.is_supersonic {
            flags |= FLAG_SUPERSONIC;
        }
        if car.is_boosting {
            flags |= FLAG_BOOSTING;
        }
        if car.is_on_ground() {
            flags |= FLAG_GROUNDED;
        }
        if car.has_jumped {
            flags |= FLAG_HAS_JUMPED;
        }
        if car.has_flipped {
            flags |= FLAG_HAS_FLIPPED;
        }

        let mut boost_pads_lo = 0_u32;
        let mut boost_pads_hi = 0_u32;
        let num_pads = arena.num_boost_pads().min(64);
        for i in 0..num_pads {
            if arena.get_boost_pad_state(i).is_active() {
                if i < 32 {
                    boost_pads_lo |= 1_u32 << i;
                } else {
                    boost_pads_hi |= 1_u32 << (i - 32);
                }
            }
        }

        self.frame = RenderFrame {
            magic: RENDER_FRAME_MAGIC,
            tick: self.tick,
            teleport_seq: self.teleport_seq,
            flags,
            ball_pos,
            ball_quat,
            ball_vel,
            car_pos,
            car_quat,
            car_vel,
            car_boost: car.boost,
            cam_pos: cam_out.pos,
            cam_quat: cam_out.quat,
            cam_fov: cam_out.fov,
            boost_pads_lo,
            boost_pads_hi,
        };
        self.telemetry.push(&self.frame);
    }
}

struct GlobalState(UnsafeCell<Option<SimCoreState>>);

// SAFETY: WASM execution in the Web Worker is single-threaded.
unsafe impl Sync for GlobalState {}

static STATE: GlobalState = GlobalState(UnsafeCell::new(None));

fn with_state<R>(f: impl FnOnce(&mut SimCoreState) -> R) -> R {
    // SAFETY: Single-threaded Web Worker access; no re-entrant mutable borrows.
    let slot = unsafe { &mut *STATE.0.get() };
    let state = slot.get_or_insert_with(SimCoreState::new);
    f(state)
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_alloc(size: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(size);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_free(ptr: *mut u8, size: usize) {
    if ptr.is_null() || size == 0 {
        return;
    }
    // SAFETY: Matches allocation from rc_alloc with exact capacity.
    unsafe {
        let _ = Vec::from_raw_parts(ptr, 0, size);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_reset_mesh_staging() {
    with_state(|s| {
        s.mesh_chunks.clear();
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_push_mesh_chunk(ptr: *const u8, len: usize) -> i32 {
    if ptr.is_null() || len == 0 {
        return -1;
    }
    // SAFETY: Caller passes valid WASM linear memory slice allocated via rc_alloc.
    let slice = unsafe { core::slice::from_raw_parts(ptr, len) };
    with_state(|s| {
        s.mesh_chunks.push(slice.to_vec());
        s.mesh_chunks.len() as i32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_finalize_arena_meshes() -> i32 {
    with_state(|s| {
        let refs: Vec<&[u8]> = s.mesh_chunks.iter().map(|v| v.as_slice()).collect();
        let res = init_or_reload_soccar_from_slices(&refs);
        s.mesh_chunks.clear();
        if res.is_ok() { 0 } else { -1 }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_create_sim() -> i32 {
    with_state(|s| {
        let mut arena = Arena::new(ARENA_GAME_MODE);
        let car_idx = arena.add_car(Team::Blue, CarBodyConfig::OCTANE);
        arena.reset_to_random_kickoff(Some(42));
        s.arena = Some(arena);
        s.car_idx = car_idx;
        s.controls = CarControls::DEFAULT;
        s.tick = 0;
        s.teleport_seq = 1;
        s.pending_teleport = true;
        s.camera.reset();
        s.telemetry.clear();
        s.update_render_frame();
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_set_controls(
    throttle: f32,
    steer: f32,
    pitch: f32,
    yaw: f32,
    roll: f32,
    jump: u32,
    boost: u32,
    handbrake: u32,
    ball_cam: u32,
) {
    with_state(|s| {
        s.controls = CarControls {
            throttle,
            steer,
            pitch,
            yaw,
            roll,
            jump: jump != 0,
            boost: boost != 0,
            handbrake: handbrake != 0,
        };
        s.want_ball_cam = ball_cam != 0;
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_set_aspect(aspect: f32) {
    with_state(|s| {
        if aspect.is_finite() && aspect > 0.1 {
            s.aspect = aspect as f64;
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_reset_kickoff() -> u32 {
    with_state(|s| {
        if let Some(arena) = s.arena.as_mut() {
            let seed = (s.tick as u64).wrapping_mul(6364136223846793005).wrapping_add(1);
            arena.reset_to_random_kickoff(Some(seed));
            s.teleport_seq = s.teleport_seq.wrapping_add(1);
            s.pending_teleport = true;
            s.update_render_frame();
        }
        s.teleport_seq
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_step_sim() -> u32 {
    with_state(|s| {
        if let Some(arena) = s.arena.as_mut() {
            arena.set_car_controls(s.car_idx, s.controls);
            let _events = arena.step_tick();
            s.tick = s.tick.wrapping_add(1);
            s.update_render_frame();
        }
        s.tick
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_get_render_frame_ptr() -> *const u8 {
    with_state(|s| s.frame.as_bytes().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_get_render_frame_byte_len() -> usize {
    RenderFrame::BYTE_LEN
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_prepare_telemetry() -> usize {
    with_state(|s| {
        let bytes = s.telemetry.prepare_ordered_bytes();
        s.telemetry_bytes_ptr = bytes.as_ptr();
        s.telemetry_bytes_len = bytes.len();
        s.telemetry_bytes_len
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_get_telemetry_ptr() -> *const u8 {
    with_state(|s| s.telemetry_bytes_ptr)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera_kernel::{CameraStepInput, CleanPovCameraKernel};

    #[test]
    fn render_frame_is_140_bytes() {
        assert_eq!(RenderFrame::BYTE_LEN, 140);
    }

    #[test]
    fn camera_kernel_produces_finite_poses_and_transitions() {
        let mut cam = CleanPovCameraKernel::new();
        let mut inp = CameraStepInput {
            dt: 1.0 / 120.0,
            want_ball_cam: true,
            did_teleport: false,
            car_pos: [0.0, 17.0, -2000.0],
            car_quat: [0.0, 0.0, 0.0, 1.0],
            car_vel: [0.0, 0.0, 1200.0],
            ball_pos: [0.0, 93.15, 0.0],
            is_grounded: true,
            is_supersonic: false,
            aspect: 16.0 / 9.0,
        };

        for _ in 0..30 {
            let out = cam.step(&inp);
            assert!(out.pos.iter().all(|v| v.is_finite()));
            assert!(out.quat.iter().all(|v| v.is_finite()));
            assert!(out.fov.is_finite() && out.fov > 20.0 && out.fov < 160.0);
        }

        inp.want_ball_cam = false;
        for _ in 0..30 {
            let out = cam.step(&inp);
            assert!(out.pos.iter().all(|v| v.is_finite()));
            assert!(out.quat.iter().all(|v| v.is_finite()));
            assert!(out.fov.is_finite());
        }
    }

    #[test]
    fn telemetry_ring_buffer_wraps_cleanly() {
        let mut ring = TelemetryRingBuffer::new();
        let mut f = RenderFrame::default();
        for i in 0..300_u32 {
            f.tick = i;
            ring.push(&f);
        }
        let bytes = ring.prepare_ordered_bytes();
        assert_eq!(
            bytes.len(),
            crate::telemetry::TELEMETRY_CAPACITY * core::mem::size_of::<crate::telemetry::TelemetrySample>()
        );
    }
}

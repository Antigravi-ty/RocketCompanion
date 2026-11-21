pub mod camera_kernel;
pub mod coords;
pub mod render_frame;
pub mod telemetry;

pub use rocketsim::CarControls;
use rocketsim::{
    Arena, CarBodyConfig, GameMode, Team, init_or_reload_soccar_from_slices,
};

use crate::camera_kernel::{CameraStepInput, CleanPovCameraKernel};
use crate::coords::{ue_rot_to_three_quat, ue_to_three_vec3};
use crate::render_frame::{
    FLAG_BALL_CAM, FLAG_BOOSTING, FLAG_GROUNDED, FLAG_HAS_FLIPPED, FLAG_HAS_JUMPED,
    FLAG_SUPERSONIC, RENDER_FRAME_MAGIC, RenderFrame,
};
use crate::telemetry::TelemetryRingBuffer;

pub const FIXED_DT: f64 = 1.0 / 120.0;
const ARENA_GAME_MODE: GameMode = GameMode::Soccar;

pub struct SimCore {
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
}

impl Default for SimCore {
    fn default() -> Self {
        Self::new()
    }
}

impl SimCore {
    pub fn new() -> Self {
        Self {
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
        }
    }

    pub fn load_arena_meshes_from_slices(slices: &[&[u8]]) -> Result<(), ()> {
        init_or_reload_soccar_from_slices(slices).map_err(|_| ())
    }

    pub fn create_soccar_freeplay(&mut self, seed: Option<u64>) {
        let mut arena = Arena::new(ARENA_GAME_MODE);
        let car_idx = arena.add_car(Team::Blue, CarBodyConfig::OCTANE);
        arena.reset_to_random_kickoff(seed.or(Some(42)));
        self.arena = Some(arena);
        self.car_idx = car_idx;
        self.controls = CarControls::DEFAULT;
        self.tick = 0;
        self.teleport_seq = 1;
        self.pending_teleport = true;
        self.camera.reset();
        self.telemetry.clear();
        self.update_render_frame();
    }

    pub fn set_controls(&mut self, controls: CarControls, want_ball_cam: bool) {
        self.controls = controls;
        self.want_ball_cam = want_ball_cam;
    }

    pub fn set_aspect(&mut self, aspect: f32) {
        if aspect.is_finite() && aspect > 0.1 {
            self.aspect = aspect as f64;
        }
    }

    pub fn reset_kickoff(&mut self) -> u32 {
        if let Some(arena) = self.arena.as_mut() {
            let seed = (self.tick as u64)
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1);
            arena.reset_to_random_kickoff(Some(seed));
            self.teleport_seq = self.teleport_seq.wrapping_add(1);
            self.pending_teleport = true;
            self.update_render_frame();
        }
        self.teleport_seq
    }

    pub fn step(&mut self) -> u32 {
        if let Some(arena) = self.arena.as_mut() {
            arena.set_car_controls(self.car_idx, self.controls);
            let _events = arena.step_tick();
            self.tick = self.tick.wrapping_add(1);
            self.update_render_frame();
        }
        self.tick
    }

    pub fn render_frame(&self) -> &RenderFrame {
        &self.frame
    }

    pub fn render_frame_bytes(&self) -> &[u8] {
        self.frame.as_bytes()
    }

    pub fn prepare_telemetry_bytes(&mut self) -> &[u8] {
        self.telemetry.prepare_ordered_bytes()
    }

    pub fn arena(&self) -> Option<&Arena> {
        self.arena.as_ref()
    }

    pub fn arena_mut(&mut self) -> Option<&mut Arena> {
        self.arena.as_mut()
    }

    pub fn car_idx(&self) -> usize {
        self.car_idx
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
            crate::telemetry::TELEMETRY_CAPACITY
                * core::mem::size_of::<crate::telemetry::TelemetrySample>()
        );
    }

    fn ensure_test_arena_meshes_loaded() -> bool {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../public/arenamesh");
        if !dir.is_dir() {
            return false;
        }
        let mut blobs = Vec::new();
        for i in 0..16 {
            let p = dir.join(format!("mesh_{i}.cmf"));
            if let Ok(bytes) = std::fs::read(&p) {
                blobs.push(bytes);
            }
        }
        if blobs.is_empty() {
            return false;
        }
        let slices: Vec<&[u8]> = blobs.iter().map(|b| b.as_slice()).collect();
        SimCore::load_arena_meshes_from_slices(&slices).is_ok()
    }

    fn run_air_dodge_sequence(pitch: f32, yaw: f32, roll: f32) -> (rocketsim::CarState, rocketsim::CarState) {
        assert!(ensure_test_arena_meshes_loaded(), "public/arenamesh/*.cmf required for physics test");
        let mut sim = SimCore::new();
        sim.create_soccar_freeplay(Some(42));

        // 1. Jump off the ground for 12 ticks
        sim.set_controls(
            CarControls {
                jump: true,
                ..CarControls::DEFAULT
            },
            true,
        );
        for _ in 0..12 {
            sim.step();
        }

        // 2. Release jump for 2 ticks so second jump can trigger a dodge
        sim.set_controls(CarControls::DEFAULT, true);
        for _ in 0..2 {
            sim.step();
        }

        let before = sim.arena().unwrap().get_car_state(sim.car_idx()).clone();

        // 3. Trigger dodge/stall with given pitch/yaw/roll + jump=true
        sim.set_controls(
            CarControls {
                pitch,
                yaw,
                roll,
                jump: true,
                ..CarControls::DEFAULT
            },
            true,
        );
        for _ in 0..10 {
            sim.step();
        }

        let after = sim.arena().unwrap().get_car_state(sim.car_idx()).clone();
        (before, after)
    }

    #[test]
    fn aerial_directional_flips_and_stalls_work_in_rocketsim() {
        // W (pitch = -1): Front flip accelerates forward along +X/+Y car heading
        let (before_w, after_w) = run_air_dodge_sequence(-1.0, 0.0, 0.0);
        assert!(after_w.has_flipped, "W front-flip should set has_flipped");
        let horiz_delta_w = ((after_w.phys.vel.x - before_w.phys.vel.x).powi(2)
            + (after_w.phys.vel.y - before_w.phys.vel.y).powi(2))
        .sqrt();
        assert!(horiz_delta_w > 300.0, "W front-flip should apply horizontal dodge impulse, got {horiz_delta_w}");

        // S (pitch = +1): Back flip accelerates backward
        let (before_s, after_s) = run_air_dodge_sequence(1.0, 0.0, 0.0);
        assert!(after_s.has_flipped, "S back-flip should set has_flipped");
        let horiz_delta_s = ((after_s.phys.vel.x - before_s.phys.vel.x).powi(2)
            + (after_s.phys.vel.y - before_s.phys.vel.y).powi(2))
        .sqrt();
        assert!(horiz_delta_s > 300.0, "S back-flip should apply horizontal dodge impulse, got {horiz_delta_s}");

        // A / D (yaw = -1 / +1): Left / Right side flip
        let (before_a, after_a) = run_air_dodge_sequence(0.0, -1.0, 0.0);
        assert!(after_a.has_flipped, "A side-flip should set has_flipped");
        let horiz_delta_a = ((after_a.phys.vel.x - before_a.phys.vel.x).powi(2)
            + (after_a.phys.vel.y - before_a.phys.vel.y).powi(2))
        .sqrt();
        assert!(horiz_delta_a > 300.0, "A side-flip should apply horizontal dodge impulse, got {horiz_delta_a}");

        let (before_d, after_d) = run_air_dodge_sequence(0.0, 1.0, 0.0);
        assert!(after_d.has_flipped, "D side-flip should set has_flipped");
        let horiz_delta_d = ((after_d.phys.vel.x - before_d.phys.vel.x).powi(2)
            + (after_d.phys.vel.y - before_d.phys.vel.y).powi(2))
        .sqrt();
        assert!(horiz_delta_d > 300.0, "D side-flip should apply horizontal dodge impulse, got {horiz_delta_d}");

        // Q / E (roll = -1 / +1): Air-roll left / right side flip
        let (_, after_q) = run_air_dodge_sequence(0.0, 0.0, -1.0);
        assert!(after_q.has_flipped, "Q air-roll flip should set has_flipped");
        let (_, after_e) = run_air_dodge_sequence(0.0, 0.0, 1.0);
        assert!(after_e.has_flipped, "E air-roll flip should set has_flipped");

        // Q + D simultaneously (roll = -1, yaw = +1): Stall!
        // Triggers has_flipped (is dodging), keeps vertical velocity near zero, and applies NO horizontal dodge impulse.
        let (before_qd, after_qd) = run_air_dodge_sequence(0.0, 1.0, -1.0);
        assert!(after_qd.has_flipped, "Q+D stall should trigger has_flipped");
        let horiz_delta_qd = ((after_qd.phys.vel.x - before_qd.phys.vel.x).powi(2)
            + (after_qd.phys.vel.y - before_qd.phys.vel.y).powi(2))
        .sqrt();
        assert!(
            horiz_delta_qd < 50.0,
            "Q+D stall must NOT apply horizontal dodge impulse, got {horiz_delta_qd}"
        );

        // A + E simultaneously (yaw = -1, roll = +1): Opposite Stall!
        let (before_ae, after_ae) = run_air_dodge_sequence(0.0, -1.0, 1.0);
        assert!(after_ae.has_flipped, "A+E stall should trigger has_flipped");
        let horiz_delta_ae = ((after_ae.phys.vel.x - before_ae.phys.vel.x).powi(2)
            + (after_ae.phys.vel.y - before_ae.phys.vel.y).powi(2))
        .sqrt();
        assert!(
            horiz_delta_ae < 50.0,
            "A+E stall must NOT apply horizontal dodge impulse, got {horiz_delta_ae}"
        );
    }
}

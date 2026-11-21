pub mod camera;
pub mod render_frame;

use glam::Vec3;
use rocketsim::{Arena, CarBodyConfig, CarControls, GameMode, Team};

use crate::{
    camera::PovCameraKernel,
    render_frame::{
        CAR_FLAG_HAS_FLIPPED, CAR_FLAG_IS_BOOSTING, CAR_FLAG_IS_SUPERSONIC, CAR_FLAG_ON_GROUND,
        RenderFramePod, rs_dir_to_three, rs_pos_to_three, rs_rot_to_three_quat,
    },
};

pub const FIXED_DT: f32 = 1.0 / 120.0;

pub struct RcCoreSim {
    arena: Arena,
    car_idx: usize,
    camera: PovCameraKernel,
    controls: CarControls,
    tick: u32,
    teleport_seq: u32,
    latest_frame: RenderFramePod,
}

impl RcCoreSim {
    pub fn new_soccar_freeplay() -> Self {
        let mut arena = Arena::new(GameMode::Soccar);
        let car_idx = arena.add_car(Team::Blue, CarBodyConfig::OCTANE);
        arena.reset_to_random_kickoff(Some(0));

        let mut sim = Self {
            arena,
            car_idx,
            camera: PovCameraKernel::new(),
            controls: CarControls::default(),
            tick: 0,
            teleport_seq: 1,
            latest_frame: RenderFramePod::default(),
        };
        sim.sync_render_frame();
        sim
    }

    pub fn set_controls(&mut self, controls: CarControls, ball_cam: bool) {
        self.controls = controls;
        self.camera.ball_cam = ball_cam;
        self.arena.set_car_controls(self.car_idx, controls);
    }

    pub fn reset_kickoff(&mut self, seed: Option<u64>) {
        self.arena.reset_to_random_kickoff(seed);
        self.teleport_seq = self.teleport_seq.wrapping_add(1);
        self.camera.reset();
        self.sync_render_frame();
    }

    pub fn step(&mut self, ticks: u32) {
        for _ in 0..ticks {
            self.arena.set_car_controls(self.car_idx, self.controls);
            let _events = self.arena.step_tick();
            self.tick = self.tick.wrapping_add(1);

            // Auto-reset on goal in Freeplay so the ball/car never get stuck inside a goal
            if self.arena.is_ball_scored() {
                self.arena.reset_to_random_kickoff(None);
                self.teleport_seq = self.teleport_seq.wrapping_add(1);
                self.camera.reset();
            }

            self.sync_render_frame();
        }
    }

    fn sync_render_frame(&mut self) {
        let ball = self.arena.get_ball_state();
        let car = self.arena.get_car_state(self.car_idx);

        let car_pos_rs = Vec3::from(car.pos);
        let car_vel_rs = Vec3::from(car.vel);
        let car_fwd_rs = Vec3::from(car.rot_mat.x_axis);
        let car_right_rs = Vec3::from(car.rot_mat.y_axis);
        let car_up_rs = Vec3::from(car.rot_mat.z_axis);
        let ball_pos_rs = Vec3::from(ball.pos);

        let on_ground = car.is_on_ground();
        let is_supersonic = car.is_supersonic;
        let is_boosting = car.is_boosting;
        let has_flipped = car.has_flipped;

        let cam_out = self.camera.step(
            FIXED_DT,
            car_pos_rs,
            car_vel_rs,
            car_fwd_rs,
            ball_pos_rs,
            on_ground,
            is_supersonic,
        );

        let mut flags = 0u32;
        if is_boosting {
            flags |= CAR_FLAG_IS_BOOSTING;
        }
        if is_supersonic {
            flags |= CAR_FLAG_IS_SUPERSONIC;
        }
        if on_ground {
            flags |= CAR_FLAG_ON_GROUND;
        }
        if has_flipped {
            flags |= CAR_FLAG_HAS_FLIPPED;
        }

        self.latest_frame = RenderFramePod {
            magic: render_frame::RENDER_FRAME_MAGIC,
            version: render_frame::RENDER_FRAME_VERSION,
            tick: self.tick,
            teleport_seq: self.teleport_seq,
            ball_cam: if self.camera.ball_cam { 1 } else { 0 },
            car_flags: flags,
            car_boost: car.boost,
            reserved: 0,
            ball_pos: rs_pos_to_three(ball.pos.into()),
            ball_quat: rs_rot_to_three_quat(
                Vec3::from(ball.rot_mat.x_axis),
                Vec3::from(ball.rot_mat.y_axis),
                Vec3::from(ball.rot_mat.z_axis),
            ),
            ball_vel: rs_pos_to_three(ball.vel.into()),
            car_pos: rs_pos_to_three(car.pos.into()),
            car_quat: rs_rot_to_three_quat(car_fwd_rs, car_right_rs, car_up_rs),
            car_vel: rs_pos_to_three(car.vel.into()),
            cam_pos: rs_pos_to_three(cam_out.pos.into()),
            cam_dir: rs_dir_to_three(cam_out.dir),
            cam_up: rs_dir_to_three(cam_out.up),
            cam_fov: cam_out.fov,
        };
    }

    pub fn render_frame(&self) -> &RenderFramePod {
        &self.latest_frame
    }

    pub fn render_frame_bytes(&self) -> &[u8] {
        self.latest_frame.as_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render_frame::{RENDER_FRAME_MAGIC, RENDER_FRAME_VERSION};
    use std::sync::Once;

    static INIT: Once = Once::new();

    fn ensure_test_meshes_init() {
        INIT.call_once(|| {
            let mut slices = Vec::new();
            let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../public/arenamesh");
            for i in 0..16 {
                let p = base.join(format!("mesh_{i}.cmf"));
                if let Ok(bytes) = std::fs::read(&p) {
                    slices.push(bytes);
                }
            }
            let refs: Vec<&[u8]> = slices.iter().map(|v| v.as_slice()).collect();
            rocketsim::init_or_reload_soccar_from_slices(&refs)
                .expect("failed to init soccar meshes for rc_core tests");
        });
    }

    #[test]
    fn test_render_frame_binary_layout() {
        assert_eq!(RenderFramePod::BYTE_LEN, 152);
        let frame = RenderFramePod::default();
        assert_eq!(frame.magic, RENDER_FRAME_MAGIC);
        assert_eq!(frame.version, RENDER_FRAME_VERSION);
        assert_eq!(frame.as_bytes().len(), 152);
    }

    #[test]
    fn test_freeplay_step_and_teleport_seq() {
        ensure_test_meshes_init();
        let mut sim = RcCoreSim::new_soccar_freeplay();
        let seq0 = sim.render_frame().teleport_seq;
        let start_car_pos = sim.render_frame().car_pos;

        sim.set_controls(
            CarControls::default().with_throttle(1.0).with_boost(true),
            true,
        );
        sim.step(120);

        let after_car_pos = sim.render_frame().car_pos;
        let dist_sq = (after_car_pos[0] - start_car_pos[0]).powi(2)
            + (after_car_pos[2] - start_car_pos[2]).powi(2);
        assert!(dist_sq > 1.0, "Car should have driven forward: {:?}", after_car_pos);
        assert_eq!(sim.render_frame().tick, 120);

        sim.reset_kickoff(Some(42));
        assert!(sim.render_frame().teleport_seq > seq0);
    }

    #[test]
    fn test_camera_determinism_independent_of_step_batching() {
        ensure_test_meshes_init();
        // Stepping 1 tick at a time (simulating 120Hz) vs 4 ticks at a time (simulating 30fps rAF)
        // must produce the exact same camera pose because CameraKernel steps strictly at FIXED_DT.
        let mut sim_120 = RcCoreSim::new_soccar_freeplay();
        let mut sim_30 = RcCoreSim::new_soccar_freeplay();

        let ctrl = CarControls::default()
            .with_throttle(1.0)
            .with_steer(0.35)
            .with_boost(true);
        sim_120.set_controls(ctrl, true);
        sim_30.set_controls(ctrl, true);

        for _ in 0..240 {
            sim_120.step(1);
        }
        for _ in 0..60 {
            sim_30.step(4);
        }

        let f1 = sim_120.render_frame();
        let f2 = sim_30.render_frame();
        assert_eq!(f1.tick, f2.tick);
        for i in 0..3 {
            assert!((f1.cam_pos[i] - f2.cam_pos[i]).abs() < 1e-6);
            assert!((f1.cam_dir[i] - f2.cam_dir[i]).abs() < 1e-6);
            assert!((f1.cam_up[i] - f2.cam_up[i]).abs() < 1e-6);
        }
        assert!((f1.cam_fov - f2.cam_fov).abs() < 1e-6);
    }
}

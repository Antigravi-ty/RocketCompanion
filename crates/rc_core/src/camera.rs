use glam::Vec3;

/// Fixed 120Hz POV Camera Kernel (Car Cam & Ball Cam) in RocketSim Z-up coordinates (uu).
/// Runs strictly at fixed `dt = 1.0 / 120.0` inside `rc_core`, completely decoupled from render FPS.
#[derive(Clone, Debug)]
pub struct PovCameraSettings {
    pub fov: f32,
    pub distance: f32,
    pub height: f32,
    pub angle_deg: f32,
    pub stiffness: f32,
    pub transition_speed: f32,
}

impl Default for PovCameraSettings {
    fn default() -> Self {
        Self {
            fov: 110.0,
            distance: 270.0,
            height: 100.0,
            angle_deg: -3.0,
            stiffness: 0.35,
            transition_speed: 1.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct PovCameraOutput {
    pub pos: Vec3,
    pub dir: Vec3,
    pub up: Vec3,
    pub fov: f32,
}

#[derive(Clone, Debug)]
pub struct PovCameraKernel {
    pub settings: PovCameraSettings,
    pub ball_cam: bool,
    initialized: bool,
    smoothed_focus: Vec3,
    smoothed_dir: Vec3,
    smoothed_pos: Vec3,
    car_cam_yaw: f32,
    car_cam_pitch: f32,
    ball_cam_blend: f32,
    smoothed_fov: f32,
}

impl Default for PovCameraKernel {
    fn default() -> Self {
        Self::new()
    }
}

impl PovCameraKernel {
    pub fn new() -> Self {
        Self {
            settings: PovCameraSettings::default(),
            ball_cam: true,
            initialized: false,
            smoothed_focus: Vec3::ZERO,
            smoothed_dir: Vec3::X,
            smoothed_pos: Vec3::new(-270.0, 0.0, 120.0),
            car_cam_yaw: 0.0,
            car_cam_pitch: 0.0,
            ball_cam_blend: 1.0,
            smoothed_fov: 110.0,
        }
    }

    pub fn reset(&mut self) {
        self.initialized = false;
        self.ball_cam_blend = if self.ball_cam { 1.0 } else { 0.0 };
        self.smoothed_fov = self.settings.fov;
    }

    pub fn step(
        &mut self,
        dt: f32,
        car_pos: Vec3,
        car_vel: Vec3,
        car_forward: Vec3,
        ball_pos: Vec3,
        on_ground: bool,
        is_supersonic: bool,
    ) -> PovCameraOutput {
        let up_world = Vec3::Z;
        let angle_rad = self.settings.angle_deg.to_radians();

        // Desired target focus (slightly above car center)
        let focus_target = car_pos + Vec3::new(0.0, 0.0, 18.0);

        // Compute Car Cam direction (follows horizontal velocity when moving, else car_forward)
        let horiz_vel = Vec3::new(car_vel.x, car_vel.y, 0.0);
        let desired_car_dir = if horiz_vel.length_squared() > 2500.0 {
            horiz_vel.normalize()
        } else {
            let f_xy = Vec3::new(car_forward.x, car_forward.y, 0.0);
            if f_xy.length_squared() > 1e-4 {
                f_xy.normalize()
            } else {
                Vec3::X
            }
        };
        let desired_yaw = desired_car_dir.y.atan2(desired_car_dir.x);
        let desired_pitch = if on_ground {
            0.0
        } else {
            (car_forward.z * 0.35).clamp(-0.45, 0.45)
        };

        // Compute Ball Cam direction (from car toward ball)
        let to_ball = ball_pos - focus_target;
        let ball_dir = if to_ball.length_squared() > 1.0 {
            to_ball.normalize()
        } else {
            desired_car_dir
        };

        if !self.initialized {
            self.initialized = true;
            self.smoothed_focus = focus_target;
            self.car_cam_yaw = desired_yaw;
            self.car_cam_pitch = desired_pitch;
            self.ball_cam_blend = if self.ball_cam { 1.0 } else { 0.0 };
            self.smoothed_dir = if self.ball_cam { ball_dir } else { desired_car_dir };
            self.smoothed_pos =
                focus_target - self.smoothed_dir * self.settings.distance + Vec3::new(0.0, 0.0, self.settings.height);
            self.smoothed_fov = self.settings.fov;
        }

        // Smooth transition between Car Cam and Ball Cam
        let target_blend = if self.ball_cam { 1.0 } else { 0.0 };
        let blend_rate = (self.settings.transition_speed.max(0.1) * 6.0 * dt).min(1.0);
        self.ball_cam_blend += (target_blend - self.ball_cam_blend) * blend_rate;

        // Shortest-angle yaw interpolation for Car Cam
        let mut yaw_diff = desired_yaw - self.car_cam_yaw;
        while yaw_diff > core::f32::consts::PI {
            yaw_diff -= core::f32::consts::TAU;
        }
        while yaw_diff < -core::f32::consts::PI {
            yaw_diff += core::f32::consts::TAU;
        }
        let stiffness_rate = (6.0 + self.settings.stiffness * 18.0) * dt;
        self.car_cam_yaw += yaw_diff * stiffness_rate.min(1.0);
        self.car_cam_pitch += (desired_pitch - self.car_cam_pitch) * (5.0 * dt).min(1.0);

        let car_cam_dir = Vec3::new(
            self.car_cam_yaw.cos() * self.car_cam_pitch.cos(),
            self.car_cam_yaw.sin() * self.car_cam_pitch.cos(),
            self.car_cam_pitch.sin(),
        )
        .normalize_or_zero();

        // Blend Car Cam and Ball Cam look directions
        let target_dir = car_cam_dir
            .lerp(ball_dir, self.ball_cam_blend)
            .normalize_or_zero();

        let dir_alpha = (18.0 * dt).min(1.0);
        self.smoothed_dir = self.smoothed_dir.lerp(target_dir, dir_alpha).normalize_or_zero();

        // Focus spring follow
        let focus_alpha = ((10.0 + self.settings.stiffness * 25.0) * dt).min(1.0);
        self.smoothed_focus = self.smoothed_focus.lerp(focus_target, focus_alpha);

        // Compute camera eye position behind focus
        let horiz_dir = Vec3::new(self.smoothed_dir.x, self.smoothed_dir.y, 0.0);
        let horiz_norm = if horiz_dir.length_squared() > 1e-4 {
            horiz_dir.normalize()
        } else {
            Vec3::X
        };
        let pitch_offset = self.smoothed_dir.z * 0.55 + angle_rad;
        let eye_offset = -horiz_norm * (self.settings.distance * pitch_offset.cos())
            + Vec3::new(0.0, 0.0, self.settings.height - self.settings.distance * pitch_offset.sin() * 0.4);

        let mut desired_pos = self.smoothed_focus + eye_offset;

        // Clamp camera inside Soccar arena bounds so it never clips outside walls/floor
        desired_pos.x = desired_pos.x.clamp(-3950.0, 3950.0);
        desired_pos.y = desired_pos.y.clamp(-4950.0, 4950.0);
        desired_pos.z = desired_pos.z.clamp(24.0, 1980.0);

        let pos_alpha = ((14.0 + self.settings.stiffness * 30.0) * dt).min(1.0);
        self.smoothed_pos = self.smoothed_pos.lerp(desired_pos, pos_alpha);

        // Look from smoothed_pos toward slightly ahead of focus (or ball)
        let look_target = self.smoothed_focus + self.smoothed_dir * 120.0;
        let final_dir = (look_target - self.smoothed_pos).normalize_or_zero();
        let right = final_dir.cross(up_world).normalize_or_zero();
        let final_up = right.cross(final_dir).normalize_or_zero();

        // Slight FOV kick when supersonic
        let target_fov = if is_supersonic {
            (self.settings.fov + 4.0).min(115.0)
        } else {
            self.settings.fov
        };
        self.smoothed_fov += (target_fov - self.smoothed_fov) * (8.0 * dt).min(1.0);

        PovCameraOutput {
            pos: self.smoothed_pos,
            dir: final_dir,
            up: final_up,
            fov: self.smoothed_fov,
        }
    }
}

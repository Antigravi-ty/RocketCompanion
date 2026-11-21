use glam::Vec3;

use crate::coords::cam_dir_up_to_quat;

const UROT_PER_RAD: f64 = 10430.378350470453;
const UROT_PER_RAD_F32: f32 = 10430.378_f32;
const DEG_TO_RAD: f64 = 0.017453292519943295;
const RAD_TO_DEG: f64 = 57.29577951308232;
const HALF_PI: f64 = core::f64::consts::FRAC_PI_2;

#[derive(Clone, Copy, Debug)]
pub struct CameraSettings {
    pub fov: f64,
    pub distance: f64,
    pub height: f64,
    pub angle_deg: f64,
    pub stiffness: f64,
    pub transition_speed: f64,
}

impl Default for CameraSettings {
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

#[derive(Clone, Copy, Debug, Default)]
struct SpringFilter3D {
    rate: f64,
    max_lag_distance: f64,
    scale: f64,
    pos_x: f64,
    pos_y: f64,
    pos_z: f64,
    vel_x: f64,
    vel_y: f64,
    vel_z: f64,
    initialized: bool,
}

impl SpringFilter3D {
    fn new(rate: f64, max_lag_distance: f64) -> Self {
        Self {
            rate,
            max_lag_distance,
            ..Self::default()
        }
    }

    fn step(&mut self, tx: f64, ty: f64, tz: f64, dt: f64) {
        if !self.initialized {
            self.initialized = true;
            self.pos_x = tx;
            self.pos_y = ty;
            self.pos_z = tz;
            self.vel_x = 0.0;
            self.vel_y = 0.0;
            self.vel_z = 0.0;
            return;
        }
        let alpha = 1.0 - (dt * -self.rate).exp();
        self.pos_x += (tx - self.pos_x) * alpha;
        self.pos_y += (ty - self.pos_y) * alpha;
        self.pos_z += (tz - self.pos_z) * alpha;
        let mut dx = tx - self.pos_x;
        let mut dy = ty - self.pos_y;
        let mut dz = tz - self.pos_z;
        let max_lag = self.max_lag_distance;
        if max_lag > 0.0 {
            let dist_sq = dz * dz + dx * dx + dy * dy;
            if dist_sq > max_lag * max_lag {
                let inv_d = if dist_sq == 0.0 {
                    1.0
                } else {
                    1.0 / dist_sq.sqrt()
                };
                dx = max_lag * (dx * inv_d);
                dy = max_lag * (dy * inv_d);
                dz = max_lag * (dz * inv_d);
                self.pos_x = tx - dx;
                self.pos_y = ty - dy;
                self.pos_z = tz - dz;
            }
        }
        self.pos_x = (self.pos_x as f32) as f64;
        self.pos_y = (self.pos_y as f32) as f64;
        self.pos_z = (self.pos_z as f32) as f64;
        let sc = self.scale;
        self.vel_x = ((dx * sc) as f32) as f64;
        self.vel_y = ((dy * sc) as f32) as f64;
        self.vel_z = ((dz * sc) as f32) as f64;
    }
}

#[derive(Clone, Copy, Debug)]
struct CameraPoseSnapshot {
    focus_x: f64,
    focus_y: f64,
    focus_z: f64,
    pitch: f64,
    yaw: f64,
    roll: f64,
    distance: f64,
    fov: f64,
    camera_pos_x: f64,
    camera_pos_y: f64,
    camera_pos_z: f64,
}

impl Default for CameraPoseSnapshot {
    fn default() -> Self {
        Self {
            focus_x: 0.0,
            focus_y: 0.0,
            focus_z: 0.0,
            pitch: 0.0,
            yaw: 0.0,
            roll: 0.0,
            distance: 270.0,
            fov: 110.0,
            camera_pos_x: 0.0,
            camera_pos_y: 0.0,
            camera_pos_z: 0.0,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct PoseTransitionDelta {
    focus_x: f64,
    focus_y: f64,
    focus_z: f64,
    pitch: f64,
    yaw: f64,
    roll: f64,
    distance: f64,
    fov: f64,
}

#[inline]
fn round_to_nearest_even(value: f64) -> f64 {
    value.round_ties_even()
}

#[inline]
fn saturate_int32(value: f64) -> i32 {
    if value.is_nan() {
        return 0;
    }
    if value >= 2_147_483_647.0 {
        return 2_147_483_647;
    }
    if value <= -2_147_483_648.0 {
        return -2_147_483_648;
    }
    value.trunc() as i32
}

#[inline]
fn extend_int16(value: i32) -> i32 {
    (value as i16) as i32
}

#[inline]
fn quantize_angle_radians_to_urot16(radians: f64) -> f64 {
    let scaled = (radians as f32) * UROT_PER_RAD_F32;
    (extend_int16(saturate_int32(scaled as f64)) as f64) / UROT_PER_RAD
}

#[inline]
fn radians_to_rounded_urot_int(radians: f64) -> i32 {
    saturate_int32(round_to_nearest_even(radians * UROT_PER_RAD))
}

#[inline]
fn interpolate_urot16_angle(current_rad: f64, target_rad: f64, alpha_f32: f32) -> f64 {
    let current_urot = radians_to_rounded_urot_int(current_rad);
    let target_urot = radians_to_rounded_urot_int(target_rad);
    let delta_urot = extend_int16(target_urot.wrapping_sub(current_urot));
    let step_urot = saturate_int32((alpha_f32 * (delta_urot as f32)) as f64);
    (extend_int16(current_urot.wrapping_add(step_urot)) as f64) / UROT_PER_RAD
}

#[inline]
fn compute_urot_yaw_radians(dir_x: f64, dir_z: f64, horiz_len: f64) -> f64 {
    let yaw_units = if horiz_len > 1e-9 {
        let raw = saturate_int32(((dir_z.atan2(dir_x) as f32) * UROT_PER_RAD_F32) as f64);
        extend_int16(16384_i32.wrapping_sub(raw))
    } else {
        16384
    };
    (yaw_units as f64) / UROT_PER_RAD
}

#[inline]
fn wrap_radians_pi(radians: f64) -> f64 {
    radians.sin().atan2(radians.cos())
}

#[inline]
fn extract_car_basis_from_quat(q: [f32; 4]) -> ([f64; 3], [f64; 3], [f64; 3]) {
    let qx = q[0] as f64;
    let qy = q[1] as f64;
    let qz = q[2] as f64;
    let qw = q[3] as f64;

    let ux = 2.0 * (qx * qy - qw * qz);
    let uy = qw * qw - qx * qx + qy * qy - qz * qz;
    let uz = 2.0 * (qy * qz + qw * qx);
    let u_len_sq = uz * uz + ux * ux + uy * uy;
    let inv_u = if u_len_sq == 0.0 {
        1.0
    } else {
        1.0 / u_len_sq.sqrt()
    };

    let rx = 2.0 * (qx * qz + qw * qy);
    let ry = 2.0 * (qy * qz - qw * qx);
    let rz = qw * qw - qx * qx - qy * qy + qz * qz;
    let r_len_sq = rz * rz + rx * rx + ry * ry;
    let inv_r = if r_len_sq == 0.0 {
        1.0
    } else {
        1.0 / r_len_sq.sqrt()
    };

    let fx = qw * qw + qx * qx - qy * qy - qz * qz;
    let fy = 2.0 * (qx * qy + qw * qz);
    let fz = 2.0 * (qx * qz - qw * qy);
    let f_len_sq = fz * fz + fx * fx + fy * fy;
    let inv_f = if f_len_sq == 0.0 {
        1.0
    } else {
        1.0 / f_len_sq.sqrt()
    };

    (
        [fx * inv_f, fy * inv_f, fz * inv_f],
        [rx * inv_r, ry * inv_r, rz * inv_r],
        [ux * inv_u, uy * inv_u, uz * inv_u],
    )
}

pub struct CameraStepInput {
    pub dt: f64,
    pub want_ball_cam: bool,
    pub did_teleport: bool,
    pub car_pos: [f32; 3],
    pub car_quat: [f32; 4],
    pub car_vel: [f32; 3],
    pub ball_pos: [f32; 3],
    pub is_grounded: bool,
    pub is_supersonic: bool,
    pub aspect: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct CameraStepOutput {
    pub pos: [f32; 3],
    pub quat: [f32; 4],
    pub fov: f32,
}

pub struct CleanPovCameraKernel {
    active_ball_cam: bool,
    requested_ball_cam: bool,
    snap_orientation_next_step: bool,
    prev_grounded_state: bool,
    is_grounded_state: bool,
    is_initialized: bool,
    is_supersonic: bool,
    ground_blend_weight: f64,
    transition_remaining_time: f64,
    transition_total_duration: f64,
    car_forward: [f64; 3],
    car_right: [f64; 3],
    car_up: [f64; 3],
    car_vel: [f64; 3],
    surface_normal: [f64; 3],
    smoothed_normal: [f64; 3],
    focus_spring: SpringFilter3D,
    height_spring: SpringFilter3D,
    distance_spring: SpringFilter3D,
    primary_pose: CameraPoseSnapshot,
    blended_pose: CameraPoseSnapshot,
    transition_from_pose: CameraPoseSnapshot,
    transition_to_pose: CameraPoseSnapshot,
    ground_candidate_pose: CameraPoseSnapshot,
    air_candidate_pose: CameraPoseSnapshot,
    working_pose: CameraPoseSnapshot,
    transition_delta: PoseTransitionDelta,
    pub settings: CameraSettings,
}

impl CleanPovCameraKernel {
    pub fn new() -> Self {
        let mut kernel = Self {
            active_ball_cam: true,
            requested_ball_cam: true,
            snap_orientation_next_step: true,
            prev_grounded_state: true,
            is_grounded_state: true,
            is_initialized: false,
            is_supersonic: false,
            ground_blend_weight: 1.0,
            transition_remaining_time: 0.0,
            transition_total_duration: 0.5,
            car_forward: [0.0; 3],
            car_right: [0.0; 3],
            car_up: [0.0; 3],
            car_vel: [0.0; 3],
            surface_normal: [0.0, 1.0, 0.0],
            smoothed_normal: [0.0, 1.0, 0.0],
            focus_spring: SpringFilter3D::new(6.32, 0.0),
            height_spring: SpringFilter3D::new(2.03, 0.0),
            distance_spring: SpringFilter3D::new(4.14, 0.0),
            primary_pose: CameraPoseSnapshot::default(),
            blended_pose: CameraPoseSnapshot::default(),
            transition_from_pose: CameraPoseSnapshot::default(),
            transition_to_pose: CameraPoseSnapshot::default(),
            ground_candidate_pose: CameraPoseSnapshot::default(),
            air_candidate_pose: CameraPoseSnapshot::default(),
            working_pose: CameraPoseSnapshot::default(),
            transition_delta: PoseTransitionDelta::default(),
            settings: CameraSettings::default(),
        };
        kernel.reset();
        kernel
    }

    pub fn reset(&mut self) {
        self.settings = CameraSettings::default();
        self.requested_ball_cam = true;
        self.active_ball_cam = true;
        self.focus_spring = SpringFilter3D::new(6.32, 0.0);
        self.height_spring = SpringFilter3D::new(2.03, 0.0);
        self.distance_spring = SpringFilter3D::new(4.14, 0.0);
        self.snap_orientation_next_step = true;
        self.prev_grounded_state = true;
        self.is_grounded_state = true;
        self.ground_blend_weight = 1.0;
        self.surface_normal = [0.0, 1.0, 0.0];
        self.smoothed_normal = [0.0, 1.0, 0.0];
        self.primary_pose = CameraPoseSnapshot::default();
        self.blended_pose = CameraPoseSnapshot::default();
        self.transition_from_pose = CameraPoseSnapshot::default();
        self.transition_to_pose = CameraPoseSnapshot::default();
        self.ground_candidate_pose = CameraPoseSnapshot::default();
        self.air_candidate_pose = CameraPoseSnapshot::default();
        self.working_pose = CameraPoseSnapshot::default();
        self.is_initialized = false;
        self.transition_remaining_time = 0.0;
        self.transition_total_duration = 0.5;
        self.transition_delta = PoseTransitionDelta::default();
    }

    fn reset_springs_and_ground_state(&mut self, is_grounded: bool) {
        self.smoothed_normal = self.surface_normal;
        self.ground_blend_weight = if is_grounded { 1.0 } else { 0.0 };
        self.prev_grounded_state = is_grounded;
        self.snap_orientation_next_step = true;
        self.distance_spring.initialized = false;
        self.height_spring.initialized = false;
        self.focus_spring.initialized = false;
    }

    fn init_primary_pose(&mut self, car_pos: [f64; 3]) {
        let [fx, fy, fz] = self.car_forward;
        let [ux, uy, uz] = self.car_up;
        let fwd_h = fx.hypot(fz);
        let init_yaw = compute_urot_yaw_radians(fx, fz, fwd_h);
        let fwd_pitch = quantize_angle_radians_to_urot16(fy.atan2(fwd_h));
        let init_pitch = quantize_angle_radians_to_urot16(
            fwd_pitch + quantize_angle_radians_to_urot16(self.settings.angle_deg * DEG_TO_RAD),
        );
        let h = self.settings.height;
        let dist_f32 = self.settings.distance as f32;
        let out = &mut self.primary_pose;
        out.fov = self.settings.fov;
        out.distance = self.settings.distance;
        out.roll = 0.0;
        out.yaw = init_yaw;
        out.pitch = init_pitch;
        out.focus_x = car_pos[0] + ux * h;
        out.focus_y = car_pos[1] + uy * h;
        out.focus_z = car_pos[2] + uz * h;
        let sin_p = (init_pitch as f32).sin();
        let cos_p = (init_pitch as f32).cos();
        let sin_y = (init_yaw as f32).sin();
        let cos_y = (init_yaw as f32).cos();
        out.camera_pos_z = ((out.focus_z as f32) - (cos_p * cos_y) * dist_f32) as f64;
        out.camera_pos_x = ((out.focus_x as f32) - (cos_p * sin_y) * dist_f32) as f64;
        let raw_cam_y = ((out.focus_y as f32) - dist_f32 * sin_p) as f64;
        out.camera_pos_y = if raw_cam_y < 10.0 { 10.0 } else { raw_cam_y };
    }

    fn project_focus_along_view_ray(
        pose: &mut CameraPoseSnapshot,
        focus_spring: &SpringFilter3D,
        tx: f64,
        ty: f64,
        tz: f64,
        stiffness: f64,
    ) {
        let sin_p = (pose.pitch as f32).sin();
        let cos_p = (pose.pitch as f32).cos();
        let p_dir_y = sin_p;
        let p_dir_z = cos_p * (pose.yaw as f32).cos();
        let p_dir_x = cos_p * (pose.yaw as f32).sin();

        let rel_sz = (focus_spring.pos_z - pose.camera_pos_z) as f32;
        let rel_sy = (focus_spring.pos_y - pose.camera_pos_y) as f32;
        let rel_sx = (focus_spring.pos_x - pose.camera_pos_x) as f32;
        let dot_s = p_dir_y * rel_sy + p_dir_x * rel_sx + p_dir_z * rel_sz;
        let perp_z = rel_sz - p_dir_z * dot_s;
        let perp_y = rel_sy - p_dir_y * dot_s;
        let perp_x = rel_sx - p_dir_x * dot_s;

        let rel_tx = (tx - pose.camera_pos_x) as f32;
        let rel_ty = (ty - pose.camera_pos_y) as f32;
        let rel_tz = (tz - pose.camera_pos_z) as f32;
        let dot_t = p_dir_y * rel_ty + p_dir_x * rel_tx + p_dir_z * rel_tz;

        let proj_z = perp_z + p_dir_z * dot_t;
        let proj_y = perp_y + p_dir_y * dot_t;
        let proj_x = perp_x + p_dir_x * dot_t;
        let bf_z = (pose.camera_pos_z as f32) + proj_z;
        let bf_y = (pose.camera_pos_y as f32) + proj_y;
        let bf_x = (pose.camera_pos_x as f32) + proj_x;

        let stiff_f32 = stiffness as f32;
        pose.focus_y = (((ty as f32) - bf_y) * stiff_f32 + bf_y) as f64;
        pose.focus_z = (((tz as f32) - bf_z) * stiff_f32 + bf_z) as f64;
        pose.focus_x = (((tx as f32) - bf_x) * stiff_f32 + bf_x) as f64;
    }

    fn compute_ball_cam_rotation(
        ball_pos: [f64; 3],
        out: &mut CameraPoseSnapshot,
        angle_deg: f64,
        snap_orientation: bool,
        dt: f64,
    ) {
        let to_ball_x = ball_pos[0] - out.focus_x;
        let to_ball_y = ball_pos[1] - out.focus_y;
        let to_ball_z = ball_pos[2] - out.focus_z;
        let elev_to_ball =
            quantize_angle_radians_to_urot16(to_ball_y.atan2(to_ball_x.hypot(to_ball_z)));
        out.focus_y += (elev_to_ball * UROT_PER_RAD).abs() * 0.005;

        let look_ball_x = ball_pos[0] - out.focus_x;
        let look_ball_y = ball_pos[1] - out.focus_y;
        let look_ball_z = ball_pos[2] - out.focus_z;

        let horiz_ball_dist = look_ball_x.hypot(look_ball_z);
        let ball_yaw = compute_urot_yaw_radians(look_ball_x, look_ball_z, horiz_ball_dist);
        let raw_ball_pitch = quantize_angle_radians_to_urot16(look_ball_y.atan2(horiz_ball_dist));
        let base_angle_pitch = quantize_angle_radians_to_urot16(angle_deg * DEG_TO_RAD);
        let high_angle_factor = (((raw_ball_pitch * UROT_PER_RAD).abs() - 4000.0) / 4000.0)
            .clamp(0.0, 1.0);
        let ball_pitch = quantize_angle_radians_to_urot16(
            (raw_ball_pitch - base_angle_pitch) * 0.8 * high_angle_factor + base_angle_pitch,
        );

        if snap_orientation {
            out.roll = 0.0;
            out.yaw = ball_yaw;
            out.pitch = ball_pitch;
        } else {
            let alpha = 1.0 - (dt * -8.59).exp();
            out.roll = wrap_radians_pi(out.roll + wrap_radians_pi(0.0 - out.roll) * alpha);
            out.yaw = wrap_radians_pi(out.yaw + wrap_radians_pi(ball_yaw - out.yaw) * alpha);
            out.pitch = wrap_radians_pi(out.pitch + wrap_radians_pi(ball_pitch - out.pitch) * alpha);
        }
    }

    fn compute_air_car_cam_rotation(
        snap_orientation: bool,
        car_forward: [f64; 3],
        car_vel: [f64; 3],
        angle_deg: f64,
        out: &mut CameraPoseSnapshot,
    ) {
        if snap_orientation {
            let horiz_mag = car_forward[0].hypot(car_forward[2]);
            let forward_yaw = compute_urot_yaw_radians(car_forward[0], car_forward[2], horiz_mag);
            let forward_pitch =
                quantize_angle_radians_to_urot16(car_forward[1].atan2(horiz_mag));

            let [vx, vy, vz] = car_vel;
            let (vel_yaw, vel_horiz_mag) = if vz * vz + vx * vx + vy * vy > 1e-8 {
                let hm = vx.hypot(vz);
                (compute_urot_yaw_radians(vx, vz, hm), hm)
            } else {
                (forward_yaw, vx.hypot(vz))
            };
            let _ = forward_pitch;
            let speed_blend = (vel_horiz_mag / 500.0).min(1.0);
            let blended_yaw =
                wrap_radians_pi(wrap_radians_pi(vel_yaw - forward_yaw) * speed_blend + forward_yaw);
            out.yaw = blended_yaw;
            out.roll = 0.0;
            out.pitch = quantize_angle_radians_to_urot16(angle_deg * DEG_TO_RAD);
            return;
        }

        let dir_x = out.focus_x - out.camera_pos_x;
        let dir_y = out.focus_y - out.camera_pos_y;
        let dir_z = out.focus_z - out.camera_pos_z;

        let vx_f32 = car_vel[0] as f32;
        let vy_f32 = car_vel[1] as f32;
        let vz_f32 = car_vel[2] as f32;
        let vx_sq = vx_f32 * vx_f32;
        let vy_sq = vy_f32 * vy_f32;
        let vz_sq = vz_f32 * vz_f32;
        let speed_ratio = (((vx_sq + vy_sq + vz_sq).sqrt() / 2300.0) as f64).min(1.0) as f32;
        let stiffness_factor = speed_ratio * -25.0 + 35.0;

        let horiz_dist = dir_x.hypot(dir_z);
        let target_yaw = compute_urot_yaw_radians(dir_x, dir_z, horiz_dist);
        let target_pitch = quantize_angle_radians_to_urot16(dir_y.atan2(horiz_dist));

        let blend_alpha_f32 = (stiffness_factor / 60.0).min(1.0);
        out.yaw = interpolate_urot16_angle(out.yaw, target_yaw, blend_alpha_f32);
        out.pitch = interpolate_urot16_angle(out.pitch, target_pitch, blend_alpha_f32);
        out.roll = interpolate_urot16_angle(out.roll, 0.0, blend_alpha_f32);

        let sin_pitch = (out.pitch as f32).sin();
        let cos_pitch = (out.pitch as f32).cos();
        let cos_yaw = (out.yaw as f32).cos();
        let sin_yaw = (out.yaw as f32).sin();
        let look_y = sin_pitch as f64;
        let look_z = (cos_pitch * cos_yaw) as f64;
        let look_x = (cos_pitch * sin_yaw) as f64;

        if car_vel[2] * look_z + car_vel[0] * look_x + car_vel[1] * look_y < 0.0 {
            let horiz_speed_ratio =
                (((vx_sq + vz_sq).sqrt() / 2300.0) as f64).min(1.0) as f32;
            let damp_scale_f32 = 1.0 - horiz_speed_ratio;
            let pitch_urot = radians_to_rounded_urot_int(out.pitch);
            out.pitch = (extend_int16(saturate_int32((damp_scale_f32 * (pitch_urot as f32)) as f64))
                as f64)
                / UROT_PER_RAD;
        }
    }

    fn compute_ground_car_cam_rotation(
        snap_orientation: bool,
        dt: f64,
        surface_normal: [f64; 3],
        smoothed_normal: &mut [f64; 3],
        car_forward: [f64; 3],
        angle_deg: f64,
        stiffness: f64,
        out: &mut CameraPoseSnapshot,
    ) {
        let blend_alpha = 1.0 - (dt * -10.46).exp();
        let mut nx = smoothed_normal[0] + (surface_normal[0] - smoothed_normal[0]) * blend_alpha;
        let mut ny = smoothed_normal[1] + (surface_normal[1] - smoothed_normal[1]) * blend_alpha;
        let mut nz = smoothed_normal[2] + (surface_normal[2] - smoothed_normal[2]) * blend_alpha;
        let n_len_sq = nz * nz + nx * nx + ny * ny;
        let inv_n_len = if n_len_sq == 0.0 {
            1.0
        } else {
            1.0 / n_len_sq.sqrt()
        };
        nx *= inv_n_len;
        ny *= inv_n_len;
        nz *= inv_n_len;
        *smoothed_normal = [nx, ny, nz];

        let c1_z = nx * car_forward[1] - ny * car_forward[0];
        let c1_y = nz * car_forward[0] - nx * car_forward[2];
        let c1_x = ny * car_forward[2] - nz * car_forward[1];

        let proj_z = c1_x * ny - c1_y * nx;
        let proj_y = c1_z * nx - c1_x * nz;
        let proj_x = c1_y * nz - c1_z * ny;

        let elev_angle = proj_y.atan2(proj_x.hypot(proj_z));
        let slope_blend = ((elev_angle * UROT_PER_RAD).abs() / 48000.0).min(1.0);

        let (tnx, tny, tnz) = if elev_angle > 0.0 {
            (-nx, -ny, -nz)
        } else {
            (nx, ny, nz)
        };

        let blended_dir_z = proj_z + (tnz - proj_z) * slope_blend;
        let blended_dir_y = proj_y + (tny - proj_y) * slope_blend;
        let blended_dir_x = proj_x + (tnx - proj_x) * slope_blend;

        let horiz_len = blended_dir_x.hypot(blended_dir_z);
        let base_yaw = compute_urot_yaw_radians(blended_dir_x, blended_dir_z, horiz_len);
        let base_pitch_raw =
            quantize_angle_radians_to_urot16(blended_dir_y.atan2(horiz_len));
        let max_pitch_room = HALF_PI - base_pitch_raw;
        let setting_pitch_rad = quantize_angle_radians_to_urot16(angle_deg * DEG_TO_RAD);
        let clamped_offset_pitch = setting_pitch_rad.min(max_pitch_room);
        let base_pitch = quantize_angle_radians_to_urot16(base_pitch_raw + clamped_offset_pitch);

        if snap_orientation {
            out.roll = 0.0;
            out.yaw = base_yaw;
            out.pitch = base_pitch;
            return;
        }

        let stiffness_scale = stiffness * 2.427 + 1.0;
        let (fast_yaw, fast_pitch, fast_roll) = if stiffness < 1.0 {
            let fast_alpha_f32 = (1.0 - (dt * (stiffness_scale * -13.39)).exp()) as f32;
            (
                interpolate_urot16_angle(out.yaw, base_yaw, fast_alpha_f32),
                interpolate_urot16_angle(out.pitch, base_pitch, fast_alpha_f32),
                interpolate_urot16_angle(out.roll, 0.0, fast_alpha_f32),
            )
        } else {
            (base_yaw, base_pitch, 0.0)
        };

        let slow_alpha_f32 = (1.0 - (dt * (stiffness_scale * -2.03)).exp()) as f32;
        let slow_yaw = interpolate_urot16_angle(out.yaw, base_yaw, slow_alpha_f32);
        let slow_pitch = interpolate_urot16_angle(out.pitch, base_pitch, slow_alpha_f32);
        let slow_roll = interpolate_urot16_angle(out.roll, 0.0, slow_alpha_f32);

        let wall_blend_f32 = (1.0 - ny.abs()) as f32;
        out.yaw = interpolate_urot16_angle(fast_yaw, slow_yaw, wall_blend_f32);
        out.pitch = interpolate_urot16_angle(fast_pitch, slow_pitch, wall_blend_f32);
        out.roll = interpolate_urot16_angle(fast_roll, slow_roll, wall_blend_f32);
    }

    fn blend_ground_and_air_poses(
        out: &mut CameraPoseSnapshot,
        gp: &CameraPoseSnapshot,
        ap: &CameraPoseSnapshot,
        w: f64,
    ) {
        let w_f32 = w as f32;
        out.focus_x = ap.focus_x + (gp.focus_x - ap.focus_x) * w;
        out.focus_y = ap.focus_y + (gp.focus_y - ap.focus_y) * w;
        out.focus_z = ap.focus_z + (gp.focus_z - ap.focus_z) * w;
        out.pitch = interpolate_urot16_angle(ap.pitch, gp.pitch, w_f32);
        out.yaw = interpolate_urot16_angle(ap.yaw, gp.yaw, w_f32);
        out.roll = interpolate_urot16_angle(ap.roll, gp.roll, w_f32);
        out.distance = ap.distance + (gp.distance - ap.distance) * w;
        out.fov = ap.fov + (gp.fov - ap.fov) * w;

        let cp = (out.pitch as f32).cos();
        let sp = (out.pitch as f32).sin();
        let dz = cp * (out.yaw as f32).cos();
        let dy = sp;
        let dx = cp * (out.yaw as f32).sin();
        let dist_f32 = out.distance as f32;
        out.camera_pos_z = ((out.focus_z as f32) - dz * dist_f32) as f64;
        out.camera_pos_x = ((out.focus_x as f32) - dx * dist_f32) as f64;
        let r_cam_y = ((out.focus_y as f32) - dist_f32 * dy) as f64;
        out.camera_pos_y = if r_cam_y < 10.0 { 10.0 } else { r_cam_y };
    }

    fn step_camera_pose(
        &mut self,
        is_ball_cam: bool,
        car_pos: [f64; 3],
        ball_pos: [f64; 3],
        dt: f64,
        pose: &mut CameraPoseSnapshot,
    ) {
        let ground_rate = if self.is_grounded_state { 2.0 } else { -4.0 };
        if self.is_grounded_state != self.prev_grounded_state {
            self.prev_grounded_state = self.is_grounded_state;
            if self.is_grounded_state {
                self.smoothed_normal = self.surface_normal;
            }
        }
        self.ground_blend_weight =
            (((self.ground_blend_weight as f32) + (ground_rate * (dt as f32))) as f64)
                .clamp(0.0, 1.0);

        let h = self.settings.height;
        let (h_off_x, h_off_y, h_off_z, focus_lag_limit) = if is_ball_cam {
            self.height_spring.initialized = true;
            self.height_spring.pos_x = 0.0;
            self.height_spring.pos_y = h;
            self.height_spring.pos_z = 0.0;
            (0.0, h, 0.0, 0.001)
        } else {
            let full_gnd = self.ground_blend_weight >= 1.0;
            let tx = if full_gnd { self.car_up[0] * h } else { 0.0 };
            let ty = if full_gnd { self.car_up[1] * h } else { h };
            let tz = if full_gnd { self.car_up[2] * h } else { 0.0 };
            self.height_spring.step(tx, ty, tz, dt);
            (
                self.height_spring.pos_x,
                self.height_spring.pos_y,
                self.height_spring.pos_z,
                100.0,
            )
        };

        let tx = car_pos[0] + h_off_x;
        let ty = car_pos[1] + h_off_y;
        let tz = car_pos[2] + h_off_z;
        self.focus_spring.max_lag_distance = focus_lag_limit;
        self.focus_spring.step(tx, ty, tz, dt);
        Self::project_focus_along_view_ray(
            pose,
            &self.focus_spring,
            tx,
            ty,
            tz,
            self.settings.stiffness,
        );

        if is_ball_cam {
            Self::compute_ball_cam_rotation(
                ball_pos,
                pose,
                self.settings.angle_deg,
                self.snap_orientation_next_step,
                dt,
            );
        } else if self.ground_blend_weight >= 1.0 {
            Self::compute_ground_car_cam_rotation(
                self.snap_orientation_next_step,
                dt,
                self.surface_normal,
                &mut self.smoothed_normal,
                self.car_forward,
                self.settings.angle_deg,
                self.settings.stiffness,
                pose,
            );
        } else if self.ground_blend_weight <= 0.0 {
            Self::compute_air_car_cam_rotation(
                self.snap_orientation_next_step,
                self.car_forward,
                self.car_vel,
                self.settings.angle_deg,
                pose,
            );
        } else {
            let mut gp = *pose;
            let mut ap = *pose;
            Self::compute_ground_car_cam_rotation(
                self.snap_orientation_next_step,
                dt,
                self.surface_normal,
                &mut self.smoothed_normal,
                self.car_forward,
                self.settings.angle_deg,
                self.settings.stiffness,
                &mut gp,
            );
            Self::compute_air_car_cam_rotation(
                self.snap_orientation_next_step,
                self.car_forward,
                self.car_vel,
                self.settings.angle_deg,
                &mut ap,
            );
            Self::blend_ground_and_air_poses(pose, &gp, &ap, self.ground_blend_weight);
            self.ground_candidate_pose = gp;
            self.air_candidate_pose = ap;
        }

        let sin_p = (pose.pitch as f32).sin() as f64;
        let cos_p = (pose.pitch as f32).cos() as f64;
        let dir_y = sin_p;
        let dir_z = ((cos_p as f32) * (pose.yaw as f32).cos()) as f64;
        let dir_x = ((cos_p as f32) * (pose.yaw as f32).sin()) as f64;
        let fwd_speed =
            self.car_vel[2] * dir_z + self.car_vel[0] * dir_x + self.car_vel[1] * dir_y;
        let stretch = (1.0 - self.settings.stiffness) * (fwd_speed * 0.05);
        let dist_target = self.settings.distance + stretch.max(-50.0);
        self.distance_spring.step(dist_target, 0.0, 0.0, dt);
        let cur_dist_f32 = self.distance_spring.pos_x as f32;
        pose.distance = cur_dist_f32 as f64;

        let car_speed = if self.is_supersonic {
            0.0
        } else {
            (self.car_vel[2] * self.car_vel[2]
                + self.car_vel[0] * self.car_vel[0]
                + self.car_vel[1] * self.car_vel[1])
                .sqrt()
        };
        let target_fov =
            self.settings.fov + if self.is_supersonic { 10.0 } else { (car_speed / 2300.0) * 5.0 };
        let fov_rate = if self.is_supersonic { 40.0 } else { 25.0 };
        if self.snap_orientation_next_step {
            pose.fov = target_fov;
        } else {
            let max_delta = dt * fov_rate;
            let fov_diff = target_fov - pose.fov;
            pose.fov = if fov_diff.abs() <= max_delta {
                target_fov
            } else if fov_diff < 0.0 {
                pose.fov - max_delta
            } else {
                pose.fov + max_delta
            };
        }

        if !is_ball_cam && self.ground_blend_weight > 0.0 {
            pose.roll = quantize_angle_radians_to_urot16(
                self.ground_blend_weight
                    * (self.car_right[1].atan2(self.car_right[0].hypot(self.car_right[2]))
                        * -0.1),
            );
        }

        let f_sin_p = (pose.pitch as f32).sin();
        let f_cos_p = (pose.pitch as f32).cos();
        pose.camera_pos_z =
            ((pose.focus_z as f32) - (f_cos_p * (pose.yaw as f32).cos()) * cur_dist_f32) as f64;
        pose.camera_pos_x =
            ((pose.focus_x as f32) - (f_cos_p * (pose.yaw as f32).sin()) * cur_dist_f32) as f64;
        let f_cam_y = ((pose.focus_y as f32) - cur_dist_f32 * f_sin_p) as f64;
        pose.camera_pos_y = if f_cam_y < 10.0 { 10.0 } else { f_cam_y };
        self.snap_orientation_next_step = false;
    }

    fn apply_quadratic_transition_blend(
        out: &mut CameraPoseSnapshot,
        d: &PoseTransitionDelta,
        rem_time: f64,
        total_dur: f64,
        dist_first: bool,
    ) {
        if rem_time <= 0.0 || total_dur <= 0.0 {
            return;
        }
        let r = (rem_time / total_dur).clamp(0.0, 1.0);
        let w = r * r;
        out.focus_x += d.focus_x * w;
        out.focus_y += d.focus_y * w;
        out.focus_z += d.focus_z * w;
        if dist_first {
            out.distance += d.distance * w;
            out.fov += d.fov * w;
            out.pitch = wrap_radians_pi(out.pitch + d.pitch * w);
            out.yaw = wrap_radians_pi(out.yaw + d.yaw * w);
            out.roll = wrap_radians_pi(out.roll + d.roll * w);
        } else {
            out.pitch = wrap_radians_pi(out.pitch + d.pitch * w);
            out.yaw = wrap_radians_pi(out.yaw + d.yaw * w);
            out.roll = wrap_radians_pi(out.roll + d.roll * w);
            out.distance += d.distance * w;
            out.fov += d.fov * w;
        }
    }

    pub fn step(&mut self, inp: &CameraStepInput) -> CameraStepOutput {
        let (fwd, right, up) = extract_car_basis_from_quat(inp.car_quat);
        self.car_forward = fwd;
        self.car_right = right;
        self.car_up = up;
        self.car_vel = [
            inp.car_vel[0] as f64,
            inp.car_vel[1] as f64,
            inp.car_vel[2] as f64,
        ];
        self.is_grounded_state = inp.is_grounded;
        self.is_supersonic = inp.is_supersonic;

        let car_pos = [
            inp.car_pos[0] as f64,
            inp.car_pos[1] as f64,
            inp.car_pos[2] as f64,
        ];
        let ball_pos = [
            inp.ball_pos[0] as f64,
            inp.ball_pos[1] as f64,
            inp.ball_pos[2] as f64,
        ];

        let flat_floor = inp.is_grounded && car_pos[1] < 60.0 && up[1] > 0.7;
        let raw_n = if flat_floor {
            [0.0, 1.0, 0.0]
        } else {
            up
        };
        let n_len_sq = raw_n[0] * raw_n[0] + raw_n[1] * raw_n[1] + raw_n[2] * raw_n[2];
        let inv_n = if n_len_sq < 1e-8 {
            1.0
        } else {
            1.0 / n_len_sq.sqrt()
        };
        self.surface_normal = [raw_n[0] * inv_n, raw_n[1] * inv_n, raw_n[2] * inv_n];

        let dt = inp.dt.clamp(0.0, 0.05);
        let want_ball_cam = inp.want_ball_cam;
        let prev_requested = self.requested_ball_cam;
        self.requested_ball_cam = want_ball_cam;

        if inp.did_teleport && self.is_initialized {
            self.focus_spring.initialized = false;
        }

        if !self.is_initialized {
            self.init_primary_pose(car_pos);
            self.blended_pose = self.primary_pose;
            self.active_ball_cam = want_ball_cam;
            self.reset_springs_and_ground_state(inp.is_grounded);
            let mut p = self.primary_pose;
            self.step_camera_pose(want_ball_cam, car_pos, ball_pos, dt, &mut p);
            self.primary_pose = p;
            self.blended_pose = p;
            self.is_initialized = true;
            self.transition_remaining_time = 0.0;
        } else if want_ball_cam != prev_requested {
            let mut from_p = self.primary_pose;
            self.step_camera_pose(self.active_ball_cam, car_pos, ball_pos, dt, &mut from_p);
            self.active_ball_cam = self.requested_ball_cam;
            self.reset_springs_and_ground_state(self.is_grounded_state);
            let mut to_p = self.primary_pose;
            self.step_camera_pose(self.active_ball_cam, car_pos, ball_pos, dt, &mut to_p);
            self.transition_from_pose = from_p;
            self.transition_to_pose = to_p;
            self.primary_pose = to_p;
            self.transition_delta = PoseTransitionDelta {
                focus_x: from_p.focus_x - to_p.focus_x,
                focus_y: from_p.focus_y - to_p.focus_y,
                focus_z: from_p.focus_z - to_p.focus_z,
                pitch: wrap_radians_pi(from_p.pitch - to_p.pitch),
                yaw: wrap_radians_pi(from_p.yaw - to_p.yaw),
                roll: wrap_radians_pi(from_p.roll - to_p.roll),
                distance: from_p.distance - to_p.distance,
                fov: from_p.fov - to_p.fov,
            };
            let duration = 0.5 / self.settings.transition_speed.clamp(0.1, 10.0);
            self.transition_total_duration = duration;
            self.transition_remaining_time = duration;
            let mut b = to_p;
            Self::apply_quadratic_transition_blend(&mut b, &self.transition_delta, duration, duration, true);
            self.blended_pose = b;
        } else {
            let mut w = self.primary_pose;
            self.step_camera_pose(self.active_ball_cam, car_pos, ball_pos, dt, &mut w);
            self.working_pose = w;
            self.primary_pose = w;
            let mut b = w;
            Self::apply_quadratic_transition_blend(
                &mut b,
                &self.transition_delta,
                self.transition_remaining_time,
                self.transition_total_duration,
                false,
            );
            self.blended_pose = b;
            self.transition_remaining_time = (self.transition_remaining_time - dt).max(0.0);
        }

        let bp = &self.blended_pose;
        let sin_p = (bp.pitch as f32).sin();
        let cos_p = (bp.pitch as f32).cos();
        let dir_y = sin_p;
        let dir_z = (bp.yaw as f32).cos() * cos_p;
        let dir_x = (bp.yaw as f32).sin() * cos_p;
        let dist_f32 = bp.distance as f32;
        let cam_pos_z = (bp.focus_z as f32) - dir_z * dist_f32;
        let cam_pos_x = (bp.focus_x as f32) - dir_x * dist_f32;
        let raw_cam_y = (bp.focus_y as f32) - sin_p * dist_f32;
        let cam_pos_y = if raw_cam_y < 10.0 { 10.0 } else { raw_cam_y };

        let mut out_up_x = 0.0_f64;
        let mut out_up_y = 1.0_f64;
        let mut out_up_z = 0.0_f64;
        let roll = bp.roll;
        if roll.abs() > 1e-8 {
            let cr = roll.cos();
            let sr = roll.sin();
            let omc = 1.0 - cr;
            let dy = dir_y as f64;
            let dx = dir_x as f64;
            let dz = dir_z as f64;
            out_up_z = dy * dz * omc + dx * sr;
            out_up_y = dy * dy * omc + cr;
            out_up_x = dy * dx * omc - dz * sr;
        }

        let half_fov = bp.fov * DEG_TO_RAD * 0.5;
        let aspect = if inp.aspect < 1.0 {
            16.0 / 9.0
        } else {
            inp.aspect
        };
        let v_half = (half_fov.tan() / aspect).atan();
        let v_fov = ((v_half + v_half) * RAD_TO_DEG) as f32;

        let quat = cam_dir_up_to_quat(
            Vec3::new(dir_x, dir_y, dir_z),
            Vec3::new(out_up_x as f32, out_up_y as f32, out_up_z as f32),
        );

        CameraStepOutput {
            pos: [cam_pos_x, cam_pos_y, cam_pos_z],
            quat,
            fov: v_fov,
        }
    }
}

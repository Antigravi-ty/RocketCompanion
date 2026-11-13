//! 120Hz Hermite/SLERP timeline resampler, 34-pad boost cooldown solver, and Track 0 packer
//! for decoded UE3 `.replay` timelines.

use glam::{Quat, Vec3};
use rc_physics_sim::{
    layout::{
        BoostPadStatePod, CarControlsPod, CarStatePod, GameStateBufferPod, MAX_CARS, MAX_PADS,
    },
    replay::{ReplayFrameEntry, ReplayStorage, REPLAY_MAX_FRAMES},
};

use crate::{
    types::{
        track0_meta_offsets, ReplayBookmarkPod, ReplayRosterSlotPod, ReplayStreamHeaderPod,
        RLRC_FIXED_DT, RLRC_MAX_PLAYER_SLOTS, RLRC_TICK_RATE_HZ,
    },
    ue3_attributes::Ue3RigidBody,
    ue3_bitreader::{Ue3Quat, Ue3Vec3},
    ue3_header::Ue3ParsedHeader,
    ue3_pad_tracker::{SourceNetworkFrame, Ue3DecodedTimeline},
};

#[inline]
fn to_vec3(v: Ue3Vec3) -> Vec3 {
    Vec3::new(v.x, v.y, v.z)
}

#[inline]
fn to_quat(q: Ue3Quat) -> Quat {
    let q = Quat::from_xyzw(q.x, q.y, q.z, q.w);
    if q.length_squared() < 1e-8 {
        Quat::IDENTITY
    } else {
        q.normalize()
    }
}

#[inline]
fn quat_to_basis(q: Quat) -> ([f32; 3], [f32; 3], [f32; 3]) {
    let x = q.x;
    let y = q.y;
    let z = q.z;
    let w = q.w;
    let xx = x * x;
    let yy = y * y;
    let zz = z * z;
    let xy = x * y;
    let xz = x * z;
    let yz = y * z;
    let wx = w * x;
    let wy = w * y;
    let wz = w * z;
    let fwd = [1.0 - 2.0 * (yy + zz), 2.0 * (xy + wz), 2.0 * (xz - wy)];
    let right = [2.0 * (xy - wz), 1.0 - 2.0 * (xx + zz), 2.0 * (yz + wx)];
    let up = [2.0 * (xz + wy), 2.0 * (yz - wx), 1.0 - 2.0 * (xx + yy)];
    (fwd, right, up)
}

fn interpolate_rigid_body(
    a: &Ue3RigidBody,
    b: &Ue3RigidBody,
    t: f32,
    dt: f32,
    hermite: bool,
) -> (Vec3, Quat, Vec3, Vec3) {
    let p0 = to_vec3(a.position);
    let p1 = to_vec3(b.position);
    let v0 = to_vec3(a.linear_velocity);
    let v1 = to_vec3(b.linear_velocity);
    let q0 = to_quat(a.rotation);
    let q1 = to_quat(b.rotation);
    let w0 = to_vec3(a.angular_velocity);
    let w1 = to_vec3(b.angular_velocity);

    let pos = if hermite && dt > 1e-4 {
        let t2 = t * t;
        let t3 = t2 * t;
        let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
        let h10 = t3 - 2.0 * t2 + t;
        let h01 = -2.0 * t3 + 3.0 * t2;
        let h11 = t3 - t2;
        p0 * h00 + v0 * (h10 * dt) + p1 * h01 + v1 * (h11 * dt)
    } else {
        p0.lerp(p1, t)
    };
    let vel = v0.lerp(v1, t);
    let ang_vel = w0.lerp(w1, t);
    let rot = q0.slerp(q1, t);
    (pos, rot, vel, ang_vel)
}

fn pack_controls_into_track64(controls: &[CarControlsPod; MAX_CARS], out: &mut [u8; 64]) {
    out.fill(0);
    for c in 0..MAX_CARS {
        let ctrl = &controls[c];
        let q_off = 24 + c * 5;
        out[q_off] = (ctrl.throttle.clamp(-1.0, 1.0) * 127.0).round() as i8 as u8;
        out[q_off + 1] = (ctrl.steer.clamp(-1.0, 1.0) * 127.0).round() as i8 as u8;
        out[q_off + 2] = (ctrl.pitch.clamp(-1.0, 1.0) * 127.0).round() as i8 as u8;
        out[q_off + 3] = (ctrl.yaw.clamp(-1.0, 1.0) * 127.0).round() as i8 as u8;
        out[q_off + 4] = (ctrl.roll.clamp(-1.0, 1.0) * 127.0).round() as i8 as u8;

        let mut b2 = 0u8;
        if ctrl.jump > 0.5 {
            b2 |= 1 << 5;
        }
        if ctrl.boost > 0.5 {
            b2 |= 1 << 6;
        }
        if ctrl.handbrake > 0.5 {
            b2 |= 1 << 7;
        }
        out[c * 3 + 2] = b2;
    }
}

pub fn resample_ue3_timeline_to_storage(
    parsed: &Ue3ParsedHeader<'_>,
    timeline: Ue3DecodedTimeline,
    hermite: bool,
    synthesize_controls: bool,
    replay: &mut ReplayStorage,
    header: &mut ReplayStreamHeaderPod,
    roster_out: &mut [ReplayRosterSlotPod; MAX_CARS],
    bookmarks_out: &mut Vec<ReplayBookmarkPod>,
) -> i32 {
    replay.clear();
    if timeline.frames.is_empty() {
        header.status_code = -5;
        return 0;
    }

    let t_start = timeline.frames.first().unwrap().time_seconds;
    let t_end = timeline.frames.last().unwrap().time_seconds;
    let dur = (t_end - t_start).max(0.0);
    let count_120 = ((dur * RLRC_TICK_RATE_HZ).round() as usize + 1).clamp(1, REPLAY_MAX_FRAMES);

    let mut pad_cooldowns = [0.0f32; MAX_PADS];
    let mut pad_ev_cursor = 0usize;
    let mut pad_events = timeline.boost_pad_events;
    pad_events.sort_by(|a, b| {
        a.time_seconds
            .partial_cmp(&b.time_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut src_idx = 0usize;
    let nfs: &[SourceNetworkFrame] = &timeline.frames;

    for f in 0..count_120 {
        let t = (t_start + (f as f32) * RLRC_FIXED_DT).min(t_end);
        while src_idx + 1 < nfs.len() && nfs[src_idx + 1].time_seconds <= t {
            src_idx += 1;
        }
        let f0 = &nfs[src_idx];
        let f1 = if src_idx + 1 < nfs.len() {
            &nfs[src_idx + 1]
        } else {
            f0
        };
        let dt = (f1.time_seconds - f0.time_seconds).max(0.0);
        let alpha = if dt > 1e-5 {
            ((t - f0.time_seconds) / dt).clamp(0.0, 1.0)
        } else {
            0.0
        };

        while pad_ev_cursor < pad_events.len() && pad_events[pad_ev_cursor].time_seconds <= t {
            let ev = &pad_events[pad_ev_cursor];
            if ev.pad_index < MAX_PADS {
                pad_cooldowns[ev.pad_index] = if ev.picked_up {
                    if ev.is_big {
                        10.0
                    } else {
                        4.0
                    }
                } else {
                    0.0
                };
            }
            pad_ev_cursor += 1;
        }
        if f > 0 {
            for cd in &mut pad_cooldowns {
                if *cd > 0.0 {
                    *cd = (*cd - RLRC_FIXED_DT).max(0.0);
                }
            }
        }

        let (ball_pos, ball_rot, ball_vel, ball_ang) =
            interpolate_rigid_body(&f0.ball_rb, &f1.ball_rb, alpha, dt, hermite);
        let (bfwd, bright, bup) = quat_to_basis(ball_rot);

        let mut buf = GameStateBufferPod::default();
        buf.header.tick_count = f as f32;
        buf.header.num_cars = timeline.roster_count as f32;
        buf.header.num_pads = MAX_PADS as f32;

        buf.ball.pos = ball_pos.to_array();
        buf.ball.vel = ball_vel.to_array();
        buf.ball.ang_vel = ball_ang.to_array();
        buf.ball.forward = bfwd;
        buf.ball.right = bright;
        buf.ball.up = bup;

        let mut controls = [CarControlsPod::default(); MAX_CARS];
        let mut active_mask = 0u32;

        for s in 0..RLRC_MAX_PLAYER_SLOTS {
            let c0 = &f0.cars[s];
            let c1 = &f1.cars[s];
            if !c0.active && !c1.active {
                continue;
            }
            active_mask |= 1u32 << s;
            let (cpos, crot, cvel, cang) =
                interpolate_rigid_body(&c0.rigid_body, &c1.rigid_body, alpha, dt, hermite);
            let (cfwd, cright, cup) = quat_to_basis(crot);
            let speed = cvel.length();

            let mut car = CarStatePod::default();
            car.pos = cpos.to_array();
            car.vel = cvel.to_array();
            car.ang_vel = cang.to_array();
            car.forward = cfwd;
            car.right = cright;
            car.up = cup;
            car.boost = c0.boost_amount + (c1.boost_amount - c0.boost_amount) * alpha;
            car.is_on_ground = if cpos.z < 30.0 { 1.0 } else { 0.0 };
            car.is_supersonic = if speed >= 2200.0 { 1.0 } else { 0.0 };
            car.is_demoed = if c0.demolished { 1.0 } else { 0.0 };
            car.is_boosting = if c0.boost_active { 1.0 } else { 0.0 };
            buf.cars[s] = car;

            if synthesize_controls {
                controls[s] = CarControlsPod {
                    throttle: c0.throttle,
                    steer: c0.steer,
                    pitch: 0.0,
                    yaw: 0.0,
                    roll: 0.0,
                    jump: if c0.jump_active || c0.double_jump_active || c0.dodge_active {
                        1.0
                    } else {
                        0.0
                    },
                    boost: if c0.boost_active { 1.0 } else { 0.0 },
                    handbrake: if c0.handbrake { 1.0 } else { 0.0 },
                };
            }
        }

        for p in 0..MAX_PADS {
            buf.pads[p] = BoostPadStatePod {
                is_active: if pad_cooldowns[p] <= 0.0 { 1.0 } else { 0.0 },
                cooldown: pad_cooldowns[p],
            };
        }

        // Write embedded Track 0 metadata floats (indices 440..448)
        let floats = unsafe {
            core::slice::from_raw_parts_mut(&mut buf as *mut GameStateBufferPod as *mut f32, 448)
        };
        floats[track0_meta_offsets::SOURCE_FRAME_30HZ] = f0.source_frame as f32;
        floats[track0_meta_offsets::SECONDS_REMAINING] = f0.seconds_remaining as f32;
        floats[track0_meta_offsets::MATCH_FLAGS] = if f0.is_overtime { 1.0 } else { 0.0 };
        floats[track0_meta_offsets::TIME_SECONDS] = t;
        floats[track0_meta_offsets::BLUE_SCORE] = f0.blue_score as f32;
        floats[track0_meta_offsets::ORANGE_SCORE] = f0.orange_score as f32;
        floats[track0_meta_offsets::SLOT_ACTION_MASK] = active_mask as f32;
        floats[track0_meta_offsets::MAGIC_TAG] = track0_meta_offsets::MAGIC_VALUE;

        let mut packed_controls = [0u8; 64];
        pack_controls_into_track64(&controls, &mut packed_controls);

        replay.state_track.push(ReplayFrameEntry {
            state: buf,
            packed_controls,
        });
    }

    for i in 0..RLRC_MAX_PLAYER_SLOTS {
        roster_out[i] = timeline.roster[i];
    }

    bookmarks_out.clear();
    bookmarks_out.extend_from_slice(&parsed.bookmarks);
    bookmarks_out.extend_from_slice(&timeline.demolish_bookmarks);
    bookmarks_out.sort_by_key(|b| b.source_frame_30hz);

    replay.header.frame_count = replay.state_track.len() as u32;
    header.frame_count = replay.state_track.len() as u32;
    header.roster_count = timeline.roster_count as u32;
    header.bookmark_count = bookmarks_out.len() as u32;
    header.duration_seconds = dur;
    header.status_code = 1;
    header.frame_count as i32
}

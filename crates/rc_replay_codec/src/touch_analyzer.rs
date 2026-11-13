//! Rust port of `ReplayTouchTimelineAnalyzer.ts` for zero-copy touch/rebound timeline
//! extraction, lateral bias resolution, and scorer/opening-car detection.

use rc_physics_sim::{
    layout::{PhysicsEvent, MAX_CARS},
    replay::ReplayStorage,
};

const OFFSET_TICK: usize = 0;
const OFFSET_NUM_CARS: usize = 2;
const OFFSET_BALL: usize = 4;
const OFFSET_CARS: usize = 22;
const CAR_STATE_STRIDE: usize = 40;

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct ReplayTouchEventPod {
    pub frame_index: u32,
    pub tick: u32,
    pub car_index: u32,
    pub team: u32,
    pub ball_x: f32,
    pub ball_y: f32,
    pub ball_z: f32,
    pub _pad: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct ReplayReboundEventPod {
    pub frame_index: u32,
    pub tick: u32,
    pub ball_x: f32,
    pub ball_y: f32,
    pub ball_z: f32,
    pub norm_x: f32,
    pub norm_y: f32,
    pub _pad: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct ReplayTouchAnalysisSummaryPod {
    pub touch_count: u32,
    pub rebound_count: u32,
    pub last_scoring_touch_frame_idx: i32,
    pub goal_line_frame_idx: i32,
    pub resolved_scorer_car_index: i32,
    pub opening_car_index: i32,
    pub resolved_lateral_bias: f32,
    pub has_initial_settled_car: u32,
    pub settled_car_index: i32,
    pub settled_x: f32,
    pub settled_y: f32,
    pub settled_z: f32,
}

#[derive(Default)]
pub struct TouchAnalysisWorkspace {
    pub summary: ReplayTouchAnalysisSummaryPod,
    pub touches: Vec<ReplayTouchEventPod>,
    pub rebounds: Vec<ReplayReboundEventPod>,
    pub external_floats: Vec<f32>,
}

#[inline]
fn resolve_car_team(car_index: usize, car_team_mask: u32) -> u32 {
    if car_team_mask == 0 {
        (car_index % 2) as u32
    } else {
        (car_team_mask >> (car_index.min(31))) & 1
    }
}

pub fn analyze_touch_timeline_slices(
    frame_count: usize,
    get_snap: impl Fn(usize) -> &'static [f32],
    incidents: &[PhysicsEvent],
    scoring_team: u32,
    is_network_streamed: bool,
    watch_all_touches: bool,
    scorer_car_index: i32,
    car_team_mask: u32,
    out: &mut TouchAnalysisWorkspace,
) {
    out.touches.clear();
    out.rebounds.clear();

    let goal_sign_y = if scoring_team == 0 { 1.0f32 } else { -1.0f32 };
    let fallback_scorer = if scorer_car_index >= 0 {
        scorer_car_index
    } else {
        0
    };

    let mut goal_line_frame_idx: i32 = -1;
    let mut sum_pre_goal_ball_x = 0.0f64;
    let mut count_pre_goal_ball_x = 0.0f64;
    let mut inc_cursor = 0usize;

    let push_touch = |touches: &mut Vec<ReplayTouchEventPod>,
                      idx: u32,
                      tick: u32,
                      car_index: u32,
                      team: u32,
                      bx: f32,
                      by: f32,
                      bz: f32| {
        if let Some(prev) = touches.last() {
            if prev.car_index == car_index && idx.saturating_sub(prev.frame_index) <= 10 {
                return;
            }
        }
        touches.push(ReplayTouchEventPod {
            frame_index: idx,
            tick,
            car_index,
            team,
            ball_x: bx,
            ball_y: by,
            ball_z: bz,
            _pad: 0,
        });
    };

    let push_rebound = |rebounds: &mut Vec<ReplayReboundEventPod>,
                        idx: u32,
                        tick: u32,
                        bx: f32,
                        by: f32,
                        bz: f32,
                        nx: f32,
                        ny: f32| {
        if let Some(prev) = rebounds.last() {
            if idx.saturating_sub(prev.frame_index) <= 14 {
                return;
            }
        }
        rebounds.push(ReplayReboundEventPod {
            frame_index: idx,
            tick,
            ball_x: bx,
            ball_y: by,
            ball_z: bz,
            norm_x: nx,
            norm_y: ny,
            _pad: 0,
        });
    };

    for idx in 0..frame_count {
        let snap = get_snap(idx);
        if snap.len() < 22 {
            continue;
        }
        let tick = snap[OFFSET_TICK].max(0.0) as u32;
        let ball_x = snap[4];
        let ball_y = snap[5];
        let ball_z = snap[6];

        if goal_line_frame_idx >= 0 && ball_y * goal_sign_y < 5020.0 {
            goal_line_frame_idx = -1;
        }
        if goal_line_frame_idx < 0 {
            let recency_weight = 0.5 + 0.5 * (idx as f64 / (frame_count.max(2) - 1) as f64);
            sum_pre_goal_ball_x += (ball_x as f64) * recency_weight;
            count_pre_goal_ball_x += recency_weight;
            if ball_y * goal_sign_y >= 5100.0 {
                goal_line_frame_idx = idx as i32;
            }
        }

        let mut recorded_touch = false;
        let mut recorded_rebound = false;
        while inc_cursor < incidents.len() && incidents[inc_cursor].tick < tick {
            inc_cursor += 1;
        }
        let mut scan = inc_cursor;
        while scan < incidents.len() && incidents[scan].tick == tick {
            let ev = &incidents[scan];
            scan += 1;
            if ev.event_type == 1 {
                let num_cars = (snap[OFFSET_NUM_CARS].round().max(1.0) as usize).min(MAX_CARS);
                let raw_car = (ev.packed_ids & 0xFFFF) as i16 as i32;
                if raw_car >= 0 {
                    let car_idx = if (raw_car as usize) < num_cars {
                        raw_car as usize
                    } else {
                        0
                    };
                    let team = resolve_car_team(car_idx, car_team_mask);
                    push_touch(
                        &mut out.touches,
                        idx as u32,
                        tick,
                        car_idx as u32,
                        team,
                        ball_x,
                        ball_y,
                        ball_z,
                    );
                    recorded_touch = true;
                }
            } else if ev.event_type == 4 || ev.event_type == 5 {
                let nz = ev.norm_z;
                if nz.abs() < 0.75
                    && (goal_line_frame_idx < 0 || (idx as i32) <= goal_line_frame_idx)
                {
                    push_rebound(
                        &mut out.rebounds,
                        idx as u32,
                        tick,
                        ball_x,
                        ball_y,
                        ball_z,
                        ev.norm_x,
                        ev.norm_y,
                    );
                    recorded_rebound = true;
                }
            }
        }

        if idx > 1 && (goal_line_frame_idx < 0 || (idx as i32) <= goal_line_frame_idx + 4) {
            let prev = get_snap(idx - 1);
            if prev.len() >= 22 {
                let dvx = snap[16] - prev[16];
                let dvy = snap[17] - prev[17];
                let dvz = snap[18] - prev[18];
                let impulse = (dvx * dvx + dvy * dvy + (dvz + 5.4) * (dvz + 5.4)).sqrt();
                if impulse > 180.0 {
                    let num_cars =
                        (snap[OFFSET_NUM_CARS].round().max(0.0) as usize).min(MAX_CARS);
                    let mut best_car: i32 = -1;
                    let mut best_dist = 265.0f32;
                    for c in 0..num_cars {
                        let base = OFFSET_CARS + c * CAR_STATE_STRIDE;
                        if snap.len() < base + 3 {
                            continue;
                        }
                        let dx = snap[base] - ball_x;
                        let dy = snap[base + 1] - ball_y;
                        let dz = snap[base + 2] - ball_z;
                        let dist = (dx * dx + dy * dy + dz * dz).sqrt();
                        if dist < best_dist {
                            best_dist = dist;
                            best_car = c as i32;
                        }
                    }
                    if best_car >= 0 && !recorded_touch {
                        let c_idx = best_car as usize;
                        let team = resolve_car_team(c_idx, car_team_mask);
                        push_touch(
                            &mut out.touches,
                            idx as u32,
                            tick,
                            best_car as u32,
                            team,
                            ball_x,
                            ball_y,
                            ball_z,
                        );
                    } else if best_car < 0
                        && !recorded_rebound
                        && (dvx * dvx + dvy * dvy).sqrt() > 240.0
                        && (ball_x.abs() > 3820.0
                            || ball_y.abs() > 4820.0
                            || ball_x.abs() + ball_y.abs() > 7480.0)
                    {
                        let horiz = (dvx * dvx + dvy * dvy).sqrt().max(1e-5);
                        push_rebound(
                            &mut out.rebounds,
                            idx as u32,
                            tick,
                            ball_x,
                            ball_y,
                            ball_z,
                            dvx / horiz,
                            dvy / horiz,
                        );
                    }
                }
            }
        }
    }

    if goal_line_frame_idx < 0 && frame_count > 0 && !is_network_streamed {
        goal_line_frame_idx = (frame_count as i32 - 360).max(0);
    }

    let mut last_scoring_touch_frame_idx: i32 = -1;
    let mut resolved_scorer_car_index: i32 = fallback_scorer;
    let max_touch_search = if goal_line_frame_idx >= 0 {
        goal_line_frame_idx + 12
    } else {
        frame_count as i32
    };
    for t in out.touches.iter().rev() {
        if (t.frame_index as i32) <= max_touch_search
            && (watch_all_touches || t.team == scoring_team)
        {
            last_scoring_touch_frame_idx = t.frame_index as i32;
            resolved_scorer_car_index = t.car_index as i32;
            break;
        }
    }
    if last_scoring_touch_frame_idx < 0 {
        if let Some(last_t) = out.touches.last() {
            last_scoring_touch_frame_idx = last_t.frame_index as i32;
            resolved_scorer_car_index = last_t.car_index as i32;
        }
    }

    let opening_car_index = out
        .touches
        .iter()
        .find(|t| t.team == scoring_team)
        .or_else(|| out.touches.first())
        .map_or(resolved_scorer_car_index, |t| t.car_index as i32);

    let mut rebound_side_score = 0.0f64;
    for rb in &out.rebounds {
        if goal_line_frame_idx >= 0 && (rb.frame_index as i32) > goal_line_frame_idx {
            continue;
        }
        rebound_side_score += -(rb.ball_x as f64) * 0.9 + (rb.norm_x as f64) * 450.0;
    }

    let open_rel_x = if frame_count > 0 {
        let open_snap = get_snap(6.min(frame_count - 1));
        let open_base = OFFSET_CARS + (opening_car_index.max(0) as usize) * CAR_STATE_STRIDE;
        if open_snap.len() > open_base + 2 {
            (open_snap[open_base] - open_snap[OFFSET_BALL]) as f64
        } else {
            0.0
        }
    } else {
        0.0
    };
    let mean_ball_x = if count_pre_goal_ball_x > 0.0 {
        sum_pre_goal_ball_x / count_pre_goal_ball_x
    } else {
        0.0
    };
    let wall_blend = ((mean_ball_x.abs() - 1800.0) / 1300.0).clamp(0.0, 1.0);
    let rb_avg = if out.rebounds.is_empty() {
        0.0
    } else {
        rebound_side_score / (out.rebounds.len() as f64)
    };
    let combined_metric =
        (-mean_ball_x * 0.65 + rb_avg * 0.35) * wall_blend + open_rel_x * (1.0 - wall_blend * 0.85);
    let interior_sign = if combined_metric >= 0.0 { 1.0f32 } else { -1.0f32 };
    let resolved_lateral_bias = if -goal_sign_y * interior_sign >= 0.0 {
        1.0
    } else {
        -1.0
    };

    let mut has_settled = 0u32;
    let mut settled_car = 0i32;
    let mut settled_x = 0.0f32;
    let mut settled_y = 0.0f32;
    let mut settled_z = 0.0f32;
    let max_check = frame_count.saturating_sub(1).min(3);
    for idx in 1..=max_check {
        let prev = get_snap(idx - 1);
        let curr = get_snap(idx);
        let num_cars = (prev[OFFSET_NUM_CARS].round().max(0.0) as usize)
            .min(curr[OFFSET_NUM_CARS].round().max(0.0) as usize)
            .min(MAX_CARS);
        if opening_car_index >= 0 && (opening_car_index as usize) < num_cars {
            let base = OFFSET_CARS + (opening_car_index as usize) * CAR_STATE_STRIDE;
            if curr.len() > base + 2 && prev.len() > base + 2 {
                let dx = curr[base] - prev[base];
                let dy = curr[base + 1] - prev[base + 1];
                let dz = curr[base + 2] - prev[base + 2];
                if (dx * dx + dy * dy + dz * dz).sqrt() > 180.0 {
                    has_settled = 1;
                    settled_car = opening_car_index;
                    settled_x = curr[base];
                    settled_y = curr[base + 1];
                    settled_z = curr[base + 2];
                }
            }
        }
    }

    out.summary = ReplayTouchAnalysisSummaryPod {
        touch_count: out.touches.len() as u32,
        rebound_count: out.rebounds.len() as u32,
        last_scoring_touch_frame_idx,
        goal_line_frame_idx,
        resolved_scorer_car_index,
        opening_car_index,
        resolved_lateral_bias,
        has_initial_settled_car: has_settled,
        settled_car_index: settled_car,
        settled_x,
        settled_y,
        settled_z,
    };
}

pub fn analyze_touch_timeline_from_storage(
    replay: &ReplayStorage,
    scoring_team: u32,
    is_network_streamed: bool,
    watch_all_touches: bool,
    scorer_car_index: i32,
    car_team_mask: u32,
    out: &mut TouchAnalysisWorkspace,
) {
    let track = &replay.state_track;
    let ptr = track.as_ptr();
    let len = track.len();
    analyze_touch_timeline_slices(
        len,
        |idx| unsafe {
            let entry = &*ptr.add(idx);
            core::slice::from_raw_parts(&entry.state as *const _ as *const f32, 448)
        },
        &replay.incident_track,
        scoring_team,
        is_network_streamed,
        watch_all_touches,
        scorer_car_index,
        car_team_mask,
        out,
    );
}

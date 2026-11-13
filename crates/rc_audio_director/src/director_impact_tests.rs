use rc_physics_sim::layout::PhysicsEvent;

use crate::director::AudioDirectorInstance;

fn make_ball_world_event(
    tick: u32,
    normal_rel_vel: f32,
    speed: f32,
    dir_dot: f32,
) -> PhysicsEvent {
    PhysicsEvent {
        event_type: 0x04,
        tick,
        pos_x: 0.0,
        pos_y: 0.0,
        pos_z: 92.75,
        norm_x: 0.0,
        norm_y: 0.0,
        norm_z: 1.0,
        normal_rel_vel,
        speed,
        impulse: normal_rel_vel,
        packed_ids: PhysicsEvent::pack_ids(-1, -1),
        sub_type: 1,
        flags: 0,
        custom_float: dir_dot,
        custom_int: 0,
    }
}

#[test]
fn suppresses_high_speed_flat_rolling() {
    let mut director = AudioDirectorInstance::new();
    let ev = make_ball_world_event(100, 0.0, 2200.0, 0.0);
    director.process_physics_event(&ev, 100);
    assert_eq!(director.cue_pod.one_shot_count, 0);
}

#[test]
fn suppresses_shallow_angle_grazing() {
    let mut director = AudioDirectorInstance::new();
    let ev = make_ball_world_event(100, 200.0, 2000.0, 0.10);
    director.process_physics_event(&ev, 100);
    assert_eq!(director.cue_pod.one_shot_count, 0);
}

#[test]
fn suppresses_ground_dribble_low_normal_vel() {
    let mut director = AudioDirectorInstance::new();
    let ev = make_ball_world_event(100, 60.0, 120.0, 0.5);
    director.process_physics_event(&ev, 100);
    assert_eq!(director.cue_pod.one_shot_count, 0);
}

#[test]
fn enforces_80ms_10_tick_debounce_on_valid_bounces() {
    let mut director = AudioDirectorInstance::new();
    let ev1 = make_ball_world_event(100, 500.0, 700.0, 0.71);
    director.process_physics_event(&ev1, 100);
    assert_eq!(director.cue_pod.one_shot_count, 1);

    let ev2 = make_ball_world_event(105, 500.0, 700.0, 0.71);
    director.process_physics_event(&ev2, 105);
    assert_eq!(director.cue_pod.one_shot_count, 1);

    let ev3 = make_ball_world_event(110, 500.0, 700.0, 0.71);
    director.process_physics_event(&ev3, 110);
    assert_eq!(director.cue_pod.one_shot_count, 2);
}

#[test]
fn flip_reset_enforces_1s_debounce_per_car_not_globally() {
    let mut director = AudioDirectorInstance::new();
    let make_fr = |tick: u32, car_idx: i32| PhysicsEvent {
        event_type: 0x0F,
        tick,
        packed_ids: PhysicsEvent::pack_ids(car_idx, -1),
        sub_type: 1,
        ..Default::default()
    };

    // Car 0 triggers at tick 100
    director.process_physics_event(&make_fr(100, 0), 100);
    assert_eq!(director.cue_pod.one_shot_count, 1);

    // Car 0 within 120 ticks (1s) is suppressed
    director.process_physics_event(&make_fr(150, 0), 150);
    assert_eq!(director.cue_pod.one_shot_count, 1);

    // Cars 1, 2, 3 all get flip reset in the same second -> all 3 must trigger!
    director.process_physics_event(&make_fr(110, 1), 110);
    director.process_physics_event(&make_fr(112, 2), 112);
    director.process_physics_event(&make_fr(115, 3), 115);
    assert_eq!(director.cue_pod.one_shot_count, 4);

    // Car 0 after >= 120 ticks triggers again
    director.process_physics_event(&make_fr(220, 0), 220);
    assert_eq!(director.cue_pod.one_shot_count, 5);
}

#[test]
fn goal_scored_suppresses_rollback_retriggers() {
    let mut director = AudioDirectorInstance::new();
    let make_goal = |tick: u32| PhysicsEvent {
        event_type: 0x0E,
        tick,
        packed_ids: PhysicsEvent::pack_ids(0, -1),
        sub_type: 0,
        ..Default::default()
    };

    director.process_physics_event(&make_goal(500), 500);
    assert_eq!(director.cue_pod.one_shot_count, 1);

    // Simulated rollback to tick 495 and re-crossing goal at tick 502
    director.process_physics_event(&make_goal(502), 502);
    assert_eq!(director.cue_pod.one_shot_count, 1);
}

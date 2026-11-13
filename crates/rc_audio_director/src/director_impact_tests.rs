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
fn enforces_60ms_8_tick_debounce_on_valid_bounces() {
    let mut director = AudioDirectorInstance::new();
    let ev1 = make_ball_world_event(100, 500.0, 700.0, 0.71);
    director.process_physics_event(&ev1, 100);
    assert_eq!(director.cue_pod.one_shot_count, 1);

    let ev2 = make_ball_world_event(105, 500.0, 700.0, 0.71);
    director.process_physics_event(&ev2, 105);
    assert_eq!(director.cue_pod.one_shot_count, 1);

    let ev3 = make_ball_world_event(108, 500.0, 700.0, 0.71);
    director.process_physics_event(&ev3, 108);
    assert_eq!(director.cue_pod.one_shot_count, 2);
}

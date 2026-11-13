//! UE3 NetStream bitframe decoder loop delegating actor state updates to `ue3_actor_state`.

use std::collections::HashMap;

use crate::{
    ue3_actor_state::NetStreamExtractState,
    ue3_attributes::{decode_property_attribute, DecodedAttr, Ue3VersionTriplet},
    ue3_bitreader::Ue3BitReader,
    ue3_catalog::{
        build_class_net_cache_lookup, build_spawn_trajectory_lookup, SpawnTrajectory,
    },
    ue3_header::Ue3ParsedHeader,
    ue3_pad_tracker::{SourceNetworkFrame, Ue3DecodedTimeline},
    ue3_prober::{is_valid_frame_header, probe_unknown_property_bitwidth},
};

pub fn decode_ue3_netstream(parsed: &Ue3ParsedHeader<'_>) -> Result<Ue3DecodedTimeline, &'static str> {
    let node_map = build_class_net_cache_lookup(&parsed.objects, &parsed.net_cache);
    let spawns = build_spawn_trajectory_lookup(&parsed.objects);
    let mut br = Ue3BitReader::new(parsed.netstream_bytes);

    let max_channels = parsed.max_channels.max(1);
    let vector_max_bits = if parsed.net_version >= 7 { 22 } else { 20 };
    let expected_frames = parsed.source_frame_count.max(1) as usize;
    let is_lan = parsed.match_type.eq_ignore_ascii_case("lan");
    let is_rl223 = parsed.build_version.as_str() >= "221120.42953.406184";
    let extended_cam_settings = parsed.minor_version >= 34
        || parsed.net_version >= 12
        || parsed
            .objects
            .iter()
            .any(|o| o == "TAGame.CameraSettingsActor_TA:FreeLookAnchorYaw");

    let ver = Ue3VersionTriplet {
        major: parsed.major_version,
        minor: parsed.minor_version,
        net: parsed.net_version,
        is_lan,
        is_rl223,
        extended_cam_settings,
    };
    let do_parse_new_actor_name =
        ver.is_at_least(868, 20, 0) || (ver.is_at_least(868, 14, 0) && !is_lan);

    let mut active_actors: HashMap<u32, usize> = HashMap::new();
    let mut state = NetStreamExtractState::default();
    let mut frames = Vec::with_capacity(expected_frames.min(36_000));
    let mut prev_time: Option<f32> = None;
    let mut base_time: Option<f32> = None;

    for frame_idx in 0..expected_frames {
        if br.bits_remaining() < 64 {
            break;
        }
        let time = br.read_f32()?;
        let delta = br.read_f32()?;
        if time == 0.0 && delta == 0.0 {
            break;
        }
        if !is_valid_frame_header(time, delta, prev_time) {
            break;
        }
        let t0 = *base_time.get_or_insert(time);
        let rel_time = (time - t0).max(0.0);

        state.ball_rb_updated = false;
        for cs in &mut state.car_states {
            cs.rb_updated = false;
        }

        while br.read_bool()? {
            let actor_id = br.read_bits_max(max_channels)?;
            let is_open = br.read_bool()?;
            if is_open {
                let is_new = br.read_bool()?;
                if is_new {
                    if do_parse_new_actor_name {
                        let _ = br.read_i32()?;
                    }
                    let _ = br.read_bit()?;
                    let obj_id = br.read_i32()?;
                    if obj_id < 0 || (obj_id as usize) >= parsed.objects.len() {
                        return Err("Invalid object_id in NetStream");
                    }
                    let oid = obj_id as usize;
                    let obj_name = &parsed.objects[oid];
                    let sp = spawns.get(oid).copied().unwrap_or(SpawnTrajectory::None);
                    let init_loc = if sp == SpawnTrajectory::Location
                        || sp == SpawnTrajectory::LocationAndRotation
                    {
                        Some(br.read_compressed_vector(vector_max_bits, 1.0)?)
                    } else {
                        None
                    };
                    if sp == SpawnTrajectory::LocationAndRotation {
                        let _ = br.read_rotation_short()?;
                    }

                    active_actors.insert(actor_id, oid);
                    if obj_name.contains("Ball_") || obj_name.starts_with("Archetypes.Ball.") {
                        state.active_ball_actor = Some(actor_id);
                        if let Some(loc) = init_loc {
                            state.ball_rb.position = loc;
                            state.ball_rb_updated = true;
                        }
                    } else if obj_name.contains("Car_") || obj_name.starts_with("Archetypes.Car.")
                    {
                        if let Some(loc) = init_loc {
                            state.car_positions.insert(actor_id, loc);
                        }
                    } else if obj_name.contains("PRI_") {
                        state.pri_meta.entry(actor_id).or_default();
                    }
                } else {
                    let Some(&oid) = active_actors.get(&actor_id) else {
                        return Err("Missing active actor for property update");
                    };
                    let Some(node) = node_map.get(&oid).cloned() else {
                        return Err("Missing ClassNetCache node for actor");
                    };
                    let actor_cls = parsed.objects[oid].as_str();

                    while br.read_bool()? {
                        let stream_id = br.read_bits_max(node.max_stream_id)?;
                        let Some(&prop_oid) = node.props.get(&stream_id) else {
                            return Err("Unknown stream_id on actor");
                        };
                        let prop_name = parsed.objects[prop_oid].as_str();
                        let attr = match decode_property_attribute(
                            &mut br,
                            prop_name,
                            &parsed.objects,
                            vector_max_bits,
                            &ver,
                        ) {
                            Ok(a) => a,
                            Err(_) => {
                                if probe_unknown_property_bitwidth(
                                    &mut br,
                                    &node,
                                    &active_actors,
                                    &node_map,
                                    &spawns,
                                    &parsed.objects,
                                    max_channels,
                                    vector_max_bits,
                                    &ver,
                                    do_parse_new_actor_name,
                                    prev_time.unwrap_or(0.0),
                                )
                                .is_some()
                                {
                                    DecodedAttr::Skip
                                } else {
                                    return Err("Failed to decode or probe UE3 property");
                                }
                            }
                        };
                        state.apply_attr(actor_id, actor_cls, prop_name, attr, frame_idx, rel_time);
                    }
                }
            } else {
                active_actors.remove(&actor_id);
                state.on_delete_actor(actor_id);
            }
        }

        prev_time = Some(time);
        frames.push(SourceNetworkFrame {
            source_frame: frame_idx as u32,
            time_seconds: rel_time,
            delta_seconds: delta,
            seconds_remaining: state.seconds_remaining,
            is_overtime: state.is_overtime,
            round_countdown: state.round_countdown,
            blue_score: state.blue_score,
            orange_score: state.orange_score,
            ball_active: state.active_ball_actor.is_some(),
            ball_rb_updated: state.ball_rb_updated,
            ball_rb: state.ball_rb,
            cars: state.car_states.clone(),
        });
    }

    let roster = state.build_roster();
    Ok(Ue3DecodedTimeline {
        roster,
        roster_count: state.next_slot_idx.min(6),
        frames,
        boost_pad_events: state.boost_pad_events,
        demolish_bookmarks: state.demolish_bookmarks,
    })
}

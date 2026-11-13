//! Speculative unknown-property bitwidth prober and frame header validator for UE3 NetStream.

use std::collections::HashMap;

use crate::{
    ue3_attributes::{decode_property_attribute, Ue3VersionTriplet},
    ue3_bitreader::Ue3BitReader,
    ue3_catalog::{ResolvedNetCacheNode, SpawnTrajectory},
};

#[inline]
pub fn is_valid_frame_header(time: f32, delta: f32, prev_time: Option<f32>) -> bool {
    if !time.is_finite() || !delta.is_finite() {
        return false;
    }
    if time < 0.0 || time > 86_400.0 || delta < 0.0 || delta > 15.0 {
        return false;
    }
    if let Some(prev) = prev_time {
        if time + 0.25 < prev {
            return false;
        }
    }
    true
}

/// Speculatively probes candidate bitwidths for an unknown property so stream parsing
/// can recover cleanly when encountering new UE3 replicated fields.
pub fn probe_unknown_property_bitwidth(
    br: &mut Ue3BitReader<'_>,
    current_node: &ResolvedNetCacheNode,
    active_actors: &HashMap<u32, usize>,
    node_map: &HashMap<usize, ResolvedNetCacheNode>,
    spawns: &[SpawnTrajectory],
    objects: &[String],
    max_channels: u32,
    vector_max_bits: u32,
    ver: &Ue3VersionTriplet,
    do_parse_new_actor_name: bool,
    prev_time: f32,
) -> Option<usize> {
    const CANDIDATE_BITS: [usize; 14] = [1, 8, 32, 2, 4, 3, 5, 6, 7, 16, 24, 64, 11, 33];
    let base_pos = br.save_bit_pos();

    for &bits in &CANDIDATE_BITS {
        if br.restore_bit_pos(base_pos).is_err() || br.bits_remaining() < bits + 8 {
            continue;
        }
        if br.skip_bits(bits).is_err() {
            continue;
        }
        let mut ok = true;
        let mut guard = 0;
        while guard < 12 {
            guard += 1;
            match br.read_bool() {
                Ok(true) => {
                    let Ok(sid) = br.read_bits_max(current_node.max_stream_id) else {
                        ok = false;
                        break;
                    };
                    let Some(&prop_oid) = current_node.props.get(&sid) else {
                        ok = false;
                        break;
                    };
                    let pname = objects.get(prop_oid).map(String::as_str).unwrap_or("");
                    if decode_property_attribute(br, pname, objects, vector_max_bits, ver).is_err()
                    {
                        ok = false;
                        break;
                    }
                }
                Ok(false) => break,
                Err(_) => {
                    ok = false;
                    break;
                }
            }
        }
        if !ok {
            continue;
        }

        let mut actor_guard = 0;
        let mut valid_tail = false;
        while actor_guard < 8 {
            actor_guard += 1;
            match br.read_bool() {
                Ok(false) => {
                    if br.bits_remaining() < 64 {
                        valid_tail = true;
                        break;
                    }
                    if let (Ok(t), Ok(d)) = (br.read_f32(), br.read_f32()) {
                        valid_tail = (t == 0.0 && d == 0.0)
                            || is_valid_frame_header(t, d, Some(prev_time));
                    }
                    break;
                }
                Ok(true) => {
                    let Ok(aid) = br.read_bits_max(max_channels) else {
                        break;
                    };
                    let Ok(is_open) = br.read_bool() else {
                        break;
                    };
                    if is_open {
                        let Ok(is_new) = br.read_bool() else {
                            break;
                        };
                        if is_new {
                            if do_parse_new_actor_name && br.read_i32().is_err() {
                                break;
                            }
                            if br.read_bit().is_err() {
                                break;
                            }
                            let Ok(oid) = br.read_i32() else {
                                break;
                            };
                            if oid < 0 || (oid as usize) >= objects.len() {
                                break;
                            }
                            let sp = spawns
                                .get(oid as usize)
                                .copied()
                                .unwrap_or(SpawnTrajectory::None);
                            if (sp == SpawnTrajectory::Location
                                || sp == SpawnTrajectory::LocationAndRotation)
                                && br.read_compressed_vector(vector_max_bits, 1.0).is_err()
                            {
                                break;
                            }
                            if sp == SpawnTrajectory::LocationAndRotation
                                && br.read_rotation_short().is_err()
                            {
                                break;
                            }
                        } else {
                            let Some(&oid) = active_actors.get(&aid) else {
                                break;
                            };
                            let Some(node) = node_map.get(&oid) else {
                                break;
                            };
                            let mut sub_ok = true;
                            while let Ok(true) = br.read_bool() {
                                let Ok(sid) = br.read_bits_max(node.max_stream_id) else {
                                    sub_ok = false;
                                    break;
                                };
                                let Some(&poid) = node.props.get(&sid) else {
                                    sub_ok = false;
                                    break;
                                };
                                let pname = objects.get(poid).map(String::as_str).unwrap_or("");
                                if decode_property_attribute(
                                    br,
                                    pname,
                                    objects,
                                    vector_max_bits,
                                    ver,
                                )
                                .is_err()
                                {
                                    sub_ok = false;
                                    break;
                                }
                            }
                            if !sub_ok {
                                break;
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }
        if valid_tail {
            let _ = br.restore_bit_pos(base_pos + bits);
            return Some(bits);
        }
    }

    let _ = br.restore_bit_pos(base_pos);
    None
}

//! UE3 `.replay` Part 1 header property tree & Part 2 metadata/table parser.

use std::collections::HashMap;

use crate::{
    types::{ReplayBookmarkPod, ReplayStreamHeaderPod, RLRC_TICK_RATE_HZ},
    ue3_catalog::{Ue3NetCacheNode, Ue3NetCacheProp},
    ue3_crc::{
        compute_rl_crc32, read_ue3_property_tree, read_ue3_table, Ue3ByteReader, Ue3PropValue,
        RL_CRC_SEED,
    },
};

#[derive(Debug, Clone)]
pub struct Ue3KeyFrame {
    pub time: f32,
    pub frame: i32,
    pub bit_position: i32,
}

#[derive(Debug, Clone)]
pub struct Ue3TickMark {
    pub description: String,
    pub frame: i32,
}

#[derive(Debug, Clone)]
pub struct Ue3GoalHeader {
    pub frame: i32,
    pub player_name: String,
    pub player_team: i8,
}

pub struct Ue3ParsedHeader<'a> {
    pub major_version: i32,
    pub minor_version: i32,
    pub net_version: i32,
    pub match_type: String,
    pub build_version: String,
    pub max_channels: u32,
    pub record_fps: f32,
    pub source_frame_count: u32,
    pub duration_seconds: f32,
    pub blue_score: u32,
    pub orange_score: u32,
    pub part1_crc_valid: bool,
    pub part2_crc_valid: bool,
    pub keyframes: Vec<Ue3KeyFrame>,
    pub netstream_bytes: &'a [u8],
    pub objects: Vec<String>,
    pub names: Vec<String>,
    pub net_cache: Vec<Ue3NetCacheNode>,
    pub bookmarks: Vec<ReplayBookmarkPod>,
}

pub fn make_bookmark(
    frame_120hz: u32,
    source_frame_30hz: u32,
    time_seconds: f32,
    kind_code: u8,
    slot_index: i8,
    team: i8,
    label: &str,
) -> ReplayBookmarkPod {
    let mut pod = ReplayBookmarkPod {
        frame_index_120hz: frame_120hz,
        source_frame_30hz,
        time_seconds,
        kind_code,
        slot_index,
        team,
        label_len: 0,
        label_utf8: [0u8; 48],
    };
    let bytes = label.as_bytes();
    let n = bytes.len().min(48);
    pod.label_len = n as u8;
    pod.label_utf8[..n].copy_from_slice(&bytes[..n]);
    pod
}

fn extract_goals_from_props(props: &HashMap<String, Ue3PropValue>) -> Vec<Ue3GoalHeader> {
    let mut out = Vec::new();
    if let Some(Ue3PropValue::Array(rows)) = props.get("Goals") {
        for row in rows {
            let frame = row.get("frame").and_then(Ue3PropValue::as_i64).unwrap_or(0) as i32;
            let player_name = row
                .get("PlayerName")
                .and_then(Ue3PropValue::as_str)
                .unwrap_or("")
                .to_string();
            let player_team = row
                .get("PlayerTeam")
                .and_then(Ue3PropValue::as_i64)
                .unwrap_or(-1) as i8;
            out.push(Ue3GoalHeader {
                frame,
                player_name,
                player_team,
            });
        }
    }
    out
}

fn estimate_frame_time(source_frame: i32, keyframes: &[Ue3KeyFrame], record_fps: f32) -> f32 {
    let f = source_frame.max(0) as f32;
    let fps = if record_fps > 0.0 { record_fps } else { 30.0 };
    if keyframes.is_empty() {
        return f / fps;
    }
    let mut prev: Option<&Ue3KeyFrame> = None;
    for kf in keyframes {
        if kf.frame == source_frame {
            return kf.time;
        }
        if kf.frame > source_frame {
            if let Some(p) = prev {
                let df = (kf.frame - p.frame) as f32;
                if df > 0.0 {
                    return p.time + ((source_frame - p.frame) as f32 / df) * (kf.time - p.time);
                }
            }
            return kf.time - (kf.frame - source_frame) as f32 / fps;
        }
        prev = Some(kf);
    }
    let last = keyframes.last().unwrap();
    last.time + (source_frame - last.frame) as f32 / fps
}

pub fn parse_ue3_replay_header<'a>(
    bytes: &'a [u8],
) -> Result<Ue3ParsedHeader<'a>, &'static str> {
    if bytes.len() < 32 {
        return Err("Invalid .replay: buffer < 32B");
    }
    let p1_len = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let p1_crc = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
    let p2_off = 8usize.saturating_add(p1_len);
    if p2_off + 8 > bytes.len() {
        return Err("Invalid .replay: Part 1 out of bounds");
    }
    let p1_slice = &bytes[8..p2_off];
    let part1_crc_valid = compute_rl_crc32(p1_slice, RL_CRC_SEED) == p1_crc;

    let p2_len = u32::from_le_bytes([
        bytes[p2_off],
        bytes[p2_off + 1],
        bytes[p2_off + 2],
        bytes[p2_off + 3],
    ]) as usize;
    let p2_crc = u32::from_le_bytes([
        bytes[p2_off + 4],
        bytes[p2_off + 5],
        bytes[p2_off + 6],
        bytes[p2_off + 7],
    ]);
    let p2_end = p2_off.saturating_add(8).saturating_add(p2_len);
    if p2_end > bytes.len() {
        return Err("Invalid .replay: Part 2 out of bounds");
    }
    let p2_slice = &bytes[p2_off + 8..p2_end];
    let part2_crc_valid = compute_rl_crc32(p2_slice, RL_CRC_SEED) == p2_crc;

    let mut p1 = Ue3ByteReader::new(p1_slice);
    let major_version = p1.read_i32()?;
    let minor_version = p1.read_i32()?;
    let net_version = if major_version > 865 && minor_version > 17 {
        p1.read_i32()?
    } else {
        0
    };
    let _game_type = p1.read_ue_string()?;
    let props = read_ue3_property_tree(&mut p1)?;
    let goals = extract_goals_from_props(&props);

    let mut p2 = Ue3ByteReader::new(p2_slice);
    let _levels = read_ue3_table(&mut p2, |r| r.read_ue_string())?;
    let keyframes = read_ue3_table(&mut p2, |r| {
        Ok(Ue3KeyFrame {
            time: r.read_f32()?,
            frame: r.read_i32()?,
            bit_position: r.read_i32()?,
        })
    })?;
    let netstream_len = p2.read_i32()?.max(0) as usize;
    let netstream_bytes = p2.read_bytes(netstream_len)?;
    let _debug_info = read_ue3_table(&mut p2, |r| {
        let frame = r.read_i32()?;
        let _u = r.read_ue_string()?;
        let _t = r.read_ue_string()?;
        Ok(frame)
    })?;
    let tick_marks = read_ue3_table(&mut p2, |r| {
        Ok(Ue3TickMark {
            description: r.read_ue_string()?,
            frame: r.read_i32()?,
        })
    })?;
    let _packages = read_ue3_table(&mut p2, |r| r.read_ue_string())?;
    let objects = read_ue3_table(&mut p2, |r| r.read_ue_string())?;
    let names = read_ue3_table(&mut p2, |r| r.read_ue_string())?;
    let _class_indices = read_ue3_table(&mut p2, |r| {
        let _ = r.read_ue_string()?;
        r.read_i32()
    })?;
    let net_cache = read_ue3_table(&mut p2, |r| {
        let object_ind = r.read_i32()?;
        let parent_id = r.read_i32()?;
        let cache_id = r.read_i32()?;
        let properties = read_ue3_table(r, |pr| {
            Ok(Ue3NetCacheProp {
                object_ind: pr.read_i32()?,
                stream_id: pr.read_i32()?,
            })
        })?;
        Ok(Ue3NetCacheNode {
            object_ind,
            parent_id,
            cache_id,
            properties,
        })
    })?;

    let record_fps = props
        .get("RecordFPS")
        .and_then(Ue3PropValue::as_f32)
        .filter(|&v| v > 0.0)
        .unwrap_or(30.0);
    let source_frame_count = props
        .get("NumFrames")
        .and_then(Ue3PropValue::as_i64)
        .unwrap_or(0)
        .max(0) as u32;
    let total_seconds = props
        .get("TotalSecondsPlayed")
        .and_then(Ue3PropValue::as_f32)
        .unwrap_or(0.0);
    let est_end = if source_frame_count > 0 {
        let k0 = keyframes.first().map_or(0.0, |k| k.time);
        (estimate_frame_time(source_frame_count as i32 - 1, &keyframes, record_fps) - k0).max(0.0)
    } else {
        0.0
    };
    let duration_seconds = if total_seconds > 0.0 {
        total_seconds
    } else {
        est_end
    };

    let blue_score = props
        .get("Team0Score")
        .and_then(Ue3PropValue::as_i64)
        .map(|v| v.max(0) as u32)
        .unwrap_or_else(|| goals.iter().filter(|g| g.player_team == 0).count() as u32);
    let orange_score = props
        .get("Team1Score")
        .and_then(Ue3PropValue::as_i64)
        .map(|v| v.max(0) as u32)
        .unwrap_or_else(|| goals.iter().filter(|g| g.player_team == 1).count() as u32);

    let max_channels = props
        .get("MaxChannels")
        .and_then(Ue3PropValue::as_i64)
        .filter(|&v| v > 0)
        .unwrap_or(1023) as u32;
    let match_type = props
        .get("MatchType")
        .and_then(Ue3PropValue::as_str)
        .unwrap_or("")
        .to_string();
    let build_version = props
        .get("BuildVersion")
        .and_then(Ue3PropValue::as_str)
        .unwrap_or("")
        .to_string();

    let mut bookmarks = Vec::with_capacity(goals.len() + tick_marks.len() + keyframes.len());
    let base_t = keyframes.first().map_or(0.0, |k| k.time);
    for g in &goals {
        let t = (estimate_frame_time(g.frame, &keyframes, record_fps) - base_t).max(0.0);
        let f120 = (t * RLRC_TICK_RATE_HZ).round() as u32;
        let lbl = if g.player_name.is_empty() {
            "Goal".to_string()
        } else {
            format!("Goal: {}", g.player_name)
        };
        bookmarks.push(make_bookmark(
            f120,
            g.frame.max(0) as u32,
            t,
            2,
            -1,
            g.player_team,
            &lbl,
        ));
    }
    for tm in &tick_marks {
        let t = (estimate_frame_time(tm.frame, &keyframes, record_fps) - base_t).max(0.0);
        let f120 = (t * RLRC_TICK_RATE_HZ).round() as u32;
        let kind = if tm.description.eq_ignore_ascii_case("Save") {
            6
        } else if tm.description.eq_ignore_ascii_case("Goal") {
            2
        } else {
            1
        };
        bookmarks.push(make_bookmark(
            f120,
            tm.frame.max(0) as u32,
            t,
            kind,
            -1,
            -1,
            &tm.description,
        ));
    }
    for kf in &keyframes {
        let t = (kf.time - base_t).max(0.0);
        let f120 = (t * RLRC_TICK_RATE_HZ).round() as u32;
        bookmarks.push(make_bookmark(
            f120,
            kf.frame.max(0) as u32,
            t,
            5,
            -1,
            -1,
            "Keyframe",
        ));
    }

    Ok(Ue3ParsedHeader {
        major_version,
        minor_version,
        net_version,
        match_type,
        build_version,
        max_channels,
        record_fps,
        source_frame_count,
        duration_seconds,
        blue_score,
        orange_score,
        part1_crc_valid,
        part2_crc_valid,
        keyframes,
        netstream_bytes,
        objects,
        names,
        net_cache,
        bookmarks,
    })
}

pub fn populate_stream_header(parsed: &Ue3ParsedHeader<'_>, header: &mut ReplayStreamHeaderPod) {
    header.magic = 0x524C_5243;
    header.version = 2;
    header.container_format = 2;
    header.status_code = 1;
    header.source_frame_count = parsed.source_frame_count;
    header.tick_rate_hz = RLRC_TICK_RATE_HZ;
    header.record_fps = parsed.record_fps;
    header.duration_seconds = parsed.duration_seconds;
    header.blue_score = parsed.blue_score;
    header.orange_score = parsed.orange_score;
    header.part1_crc_valid = u32::from(parsed.part1_crc_valid);
    header.part2_crc_valid = u32::from(parsed.part2_crc_valid);
    header.keyframe_count = parsed.keyframes.len() as u32;
    header.bookmark_count = parsed.bookmarks.len() as u32;
}

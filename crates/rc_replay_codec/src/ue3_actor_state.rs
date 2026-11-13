//! Actor-to-slot state mapping and decoded attribute application for UE3 NetStream extraction.

use std::collections::HashMap;

use crate::{
    types::{ReplayBookmarkPod, ReplayRosterSlotPod, RLRC_MAX_PLAYER_SLOTS},
    ue3_attributes::{DecodedAttr, Ue3RigidBody},
    ue3_bitreader::Ue3Vec3,
    ue3_header::make_bookmark,
    ue3_pad_tracker::{
        decode_axis_byte, find_nearest_pad, SourceBoostPadEvent, SourceCarState,
        STANDARD_PADS_XY_BIG,
    },
};

#[derive(Default)]
pub struct PriMeta {
    pub name: String,
    pub team_actor: i32,
    pub team_num: Option<u8>,
    pub body_id: u32,
    pub primary_color: u32,
    pub accent_color: u32,
    pub cam_fov: f32,
    pub cam_height: f32,
    pub cam_pitch: f32,
    pub cam_dist: f32,
    pub cam_stiff: f32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CompKind {
    Boost,
    Jump,
    DoubleJump,
    Dodge,
}

pub struct NetStreamExtractState {
    pub pri_meta: HashMap<u32, PriMeta>,
    pub team_num_by_actor: HashMap<u32, u8>,
    pub pri_to_slot: HashMap<u32, usize>,
    pub car_to_pri: HashMap<u32, u32>,
    pub car_to_slot: HashMap<u32, usize>,
    pub comp_to_car: HashMap<u32, (u32, CompKind)>,
    pub pickup_to_pad: HashMap<u32, usize>,
    pub car_positions: HashMap<u32, Ue3Vec3>,
    pub active_ball_actor: Option<u32>,
    pub ball_rb: Ue3RigidBody,
    pub ball_rb_updated: bool,
    pub car_states: [SourceCarState; RLRC_MAX_PLAYER_SLOTS],
    pub seconds_remaining: i32,
    pub is_overtime: bool,
    pub round_countdown: i32,
    pub blue_score: u32,
    pub orange_score: u32,
    pub next_slot_idx: usize,
    pub boost_pad_events: Vec<SourceBoostPadEvent>,
    pub demolish_bookmarks: Vec<ReplayBookmarkPod>,
}

impl Default for NetStreamExtractState {
    fn default() -> Self {
        Self {
            pri_meta: HashMap::new(),
            team_num_by_actor: HashMap::new(),
            pri_to_slot: HashMap::new(),
            car_to_pri: HashMap::new(),
            car_to_slot: HashMap::new(),
            comp_to_car: HashMap::new(),
            pickup_to_pad: HashMap::new(),
            car_positions: HashMap::new(),
            active_ball_actor: None,
            ball_rb: Ue3RigidBody {
                sleeping: true,
                position: Ue3Vec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 93.15,
                },
                ..Default::default()
            },
            ball_rb_updated: false,
            car_states: Default::default(),
            seconds_remaining: 300,
            is_overtime: false,
            round_countdown: 0,
            blue_score: 0,
            orange_score: 0,
            next_slot_idx: 0,
            boost_pad_events: Vec::new(),
            demolish_bookmarks: Vec::new(),
        }
    }
}

impl NetStreamExtractState {
    pub fn on_delete_actor(&mut self, actor_id: u32) {
        if Some(actor_id) == self.active_ball_actor {
            self.active_ball_actor = None;
        }
        if let Some(slot) = self.car_to_slot.remove(&actor_id) {
            self.car_states[slot].active = false;
        }
        self.car_to_pri.remove(&actor_id);
        self.comp_to_car.remove(&actor_id);
        self.pickup_to_pad.remove(&actor_id);
    }

    pub fn apply_attr(
        &mut self,
        actor_id: u32,
        actor_cls: &str,
        prop_name: &str,
        attr: DecodedAttr,
        frame_idx: usize,
        rel_time: f32,
    ) {
        let tail = prop_name.rsplit(':').next().unwrap_or(prop_name);
        match attr {
            DecodedAttr::RigidBody(rb) => {
                if Some(actor_id) == self.active_ball_actor || actor_cls.contains("Ball") {
                    self.active_ball_actor = Some(actor_id);
                    self.ball_rb = rb;
                    self.ball_rb_updated = true;
                } else {
                    self.car_positions.insert(actor_id, rb.position);
                    if let Some(&slot) = self.car_to_slot.get(&actor_id) {
                        self.car_states[slot].active = true;
                        self.car_states[slot].demolished = false;
                        self.car_states[slot].rigid_body = rb;
                        self.car_states[slot].rb_updated = true;
                    }
                }
            }
            DecodedAttr::ActiveActor { active, actor } => {
                if tail == "PlayerReplicationInfo" && active && actor >= 0 {
                    let pri_id = actor as u32;
                    self.car_to_pri.insert(actor_id, pri_id);
                    let slot = if let Some(&s) = self.pri_to_slot.get(&pri_id) {
                        s
                    } else if self.next_slot_idx < RLRC_MAX_PLAYER_SLOTS {
                        let s = self.next_slot_idx;
                        self.next_slot_idx += 1;
                        self.pri_to_slot.insert(pri_id, s);
                        s
                    } else {
                        return;
                    };
                    self.car_to_slot.insert(actor_id, slot);
                    self.car_states[slot].active = true;
                } else if tail == "Team" && active && actor >= 0 {
                    let entry = self.pri_meta.entry(actor_id).or_default();
                    entry.team_actor = actor;
                    if let Some(&tn) = self.team_num_by_actor.get(&(actor as u32)) {
                        entry.team_num = Some(tn);
                    }
                } else if tail == "Vehicle" && active && actor >= 0 {
                    let kind = if actor_cls.contains("Boost") {
                        Some(CompKind::Boost)
                    } else if actor_cls.contains("DoubleJump") {
                        Some(CompKind::DoubleJump)
                    } else if actor_cls.contains("Jump") {
                        Some(CompKind::Jump)
                    } else if actor_cls.contains("Dodge") {
                        Some(CompKind::Dodge)
                    } else {
                        None
                    };
                    if let Some(k) = kind {
                        self.comp_to_car.insert(actor_id, (actor as u32, k));
                    }
                }
            }
            DecodedAttr::Str(s) if tail == "PlayerName" => {
                self.pri_meta.entry(actor_id).or_default().name = s;
            }
            DecodedAttr::Byte(b) => {
                if tail == "TeamNum" {
                    self.team_num_by_actor.insert(actor_id, b);
                } else if tail == "ReplicatedThrottle" {
                    if let Some(&slot) = self.car_to_slot.get(&actor_id) {
                        self.car_states[slot].throttle = decode_axis_byte(b);
                    }
                } else if tail == "ReplicatedSteer" {
                    if let Some(&slot) = self.car_to_slot.get(&actor_id) {
                        self.car_states[slot].steer = decode_axis_byte(b);
                    }
                } else if tail == "ReplicatedActive" {
                    if let Some(&(cid, kind)) = self.comp_to_car.get(&actor_id) {
                        if let Some(&slot) = self.car_to_slot.get(&cid) {
                            let on = (b & 1) == 1;
                            match kind {
                                CompKind::Boost => self.car_states[slot].boost_active = on,
                                CompKind::Jump => self.car_states[slot].jump_active = on,
                                CompKind::DoubleJump => {
                                    self.car_states[slot].double_jump_active = on
                                }
                                CompKind::Dodge => self.car_states[slot].dodge_active = on,
                            }
                        }
                    }
                } else if tail == "ReplicatedBoostAmount" {
                    if let Some(&(cid, _)) = self.comp_to_car.get(&actor_id) {
                        if let Some(&slot) = self.car_to_slot.get(&cid) {
                            self.car_states[slot].boost_amount = (b as f32 / 255.0) * 100.0;
                        }
                    }
                }
            }
            DecodedAttr::Bool(b) => {
                if tail == "bOverTime" {
                    self.is_overtime = b;
                } else if tail == "bReplicatedHandbrake" {
                    if let Some(&slot) = self.car_to_slot.get(&actor_id) {
                        self.car_states[slot].handbrake = b;
                    }
                }
            }
            DecodedAttr::Int(v) => {
                if tail == "SecondsRemaining" {
                    self.seconds_remaining = v;
                } else if tail == "ReplicatedRoundCountDownNumber" {
                    self.round_countdown = v;
                } else if tail == "Score" && actor_cls.contains("Team") {
                    if let Some(&tn) = self.team_num_by_actor.get(&actor_id) {
                        if tn == 0 {
                            self.blue_score = v.max(0) as u32;
                        } else if tn == 1 {
                            self.orange_score = v.max(0) as u32;
                        }
                    }
                }
            }
            DecodedAttr::ReplicatedBoost { boost_amount, .. } => {
                if let Some(&(cid, _)) = self.comp_to_car.get(&actor_id) {
                    if let Some(&slot) = self.car_to_slot.get(&cid) {
                        self.car_states[slot].boost_amount = (boost_amount as f32 / 255.0) * 100.0;
                    }
                }
            }
            DecodedAttr::CamSettings {
                fov,
                height,
                angle,
                distance,
                stiffness,
            } => {
                let entry = self.pri_meta.entry(actor_id).or_default();
                entry.cam_fov = fov;
                entry.cam_height = height;
                entry.cam_pitch = angle;
                entry.cam_dist = distance;
                entry.cam_stiff = stiffness;
            }
            DecodedAttr::BodyLoadout(body) => {
                self.pri_meta.entry(actor_id).or_default().body_id = body;
            }
            DecodedAttr::TeamBodyLoadout {
                blue_body,
                orange_body,
            } => {
                let entry = self.pri_meta.entry(actor_id).or_default();
                entry.body_id = if entry.team_num == Some(1) {
                    orange_body
                } else {
                    blue_body
                };
            }
            DecodedAttr::TeamPaint {
                primary_color,
                accent_color,
                ..
            } => {
                let entry = self.pri_meta.entry(actor_id).or_default();
                entry.primary_color = primary_color as u32;
                entry.accent_color = accent_color as u32;
            }
            DecodedAttr::Pickup {
                instigator,
                picked_up,
            } => {
                let is_picked = picked_up != 0 && picked_up != 255;
                let pad_idx = if let Some(&p) = self.pickup_to_pad.get(&actor_id) {
                    Some(p)
                } else if let Some(inst_id) = instigator {
                    if let Some(pos) = self.car_positions.get(&(inst_id as u32)) {
                        let p = find_nearest_pad(pos.x, pos.y);
                        self.pickup_to_pad.insert(actor_id, p);
                        Some(p)
                    } else {
                        None
                    }
                } else {
                    None
                };
                if let Some(p) = pad_idx {
                    self.boost_pad_events.push(SourceBoostPadEvent {
                        time_seconds: rel_time,
                        pad_index: p,
                        is_big: STANDARD_PADS_XY_BIG[p].2,
                        picked_up: is_picked,
                    });
                }
            }
            DecodedAttr::Demolish { victim_actor, .. } => {
                if victim_actor >= 0 {
                    if let Some(&slot) = self.car_to_slot.get(&(victim_actor as u32)) {
                        self.car_states[slot].demolished = true;
                        self.demolish_bookmarks.push(make_bookmark(
                            (rel_time * 120.0).round() as u32,
                            frame_idx as u32,
                            rel_time,
                            4,
                            slot as i8,
                            (slot % 2) as i8,
                            "Demolition",
                        ));
                    }
                }
            }
            _ => {}
        }
    }

    pub fn build_roster(&self) -> [ReplayRosterSlotPod; RLRC_MAX_PLAYER_SLOTS] {
        let mut roster = [ReplayRosterSlotPod::default(); RLRC_MAX_PLAYER_SLOTS];
        for (&pri_id, &slot) in &self.pri_to_slot {
            if slot >= RLRC_MAX_PLAYER_SLOTS {
                continue;
            }
            let mut pod = ReplayRosterSlotPod::default();
            pod.slot_index = slot as u32;
            pod.pri_actor_id = pri_id;
            pod.team = (slot % 2) as u32;
            if let Some(meta) = self.pri_meta.get(&pri_id) {
                if let Some(tn) = meta.team_num {
                    pod.team = tn as u32;
                }
                if meta.body_id > 0 {
                    pod.body_product_id = meta.body_id;
                }
                pod.primary_color_rgb = meta.primary_color;
                pod.accent_color_rgb = meta.accent_color;
                if meta.cam_fov > 10.0 {
                    pod.camera_fov = meta.cam_fov;
                    pod.camera_height = meta.cam_height;
                    pod.camera_pitch = meta.cam_pitch;
                    pod.camera_distance = meta.cam_dist;
                    pod.camera_stiffness = meta.cam_stiff;
                }
                let nb = meta.name.as_bytes();
                let n = nb.len().min(11);
                pod.name_len = n as u8;
                pod.name_utf8[..n].copy_from_slice(&nb[..n]);
            }
            roster[slot] = pod;
        }
        roster
    }
}
